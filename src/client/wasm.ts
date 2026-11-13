// A client for superdb compiled to WebAssembly.
//
// The wasm module must expose a `run` function (see SuperWasm) that runs a
// query over an input and returns the output in a requested format.  This
// client asks for BSUP and decodes it, so results are fully typed.

import { TypeContext } from "../types.ts"
import { decodeBSUPStream } from "../bsup/decoder.ts"
import type { QueryInput, QueryOptions, SuperDBClient } from "./client.ts"
import { QueryResult, SuperDBError } from "./result.ts"

/** The arguments of the wasm module's run function. */
export interface SuperWasmRunArgs {
  program: string
  input?: string | ReadableStream<Uint8Array>
  inputFormat?: string
  outputFormat: string
}

/**
 * The interface of a superdb wasm module.  `run` must return BSUP output
 * as bytes (a Uint8Array).  A module that returns its output as a string
 * can't carry binary BSUP, so a string result is accepted only for text
 * output formats.
 */
export interface SuperWasm {
  run(args: SuperWasmRunArgs): Promise<Uint8Array | string>
  parse?(program: string): unknown
}

export interface WasmClientOptions {
  /** The type context for results (default: a new context). */
  context?: TypeContext
}

/** Runs queries in a superdb wasm module. */
export class WasmClient implements SuperDBClient {
  readonly context: TypeContext
  readonly wasm: SuperWasm

  constructor(wasm: SuperWasm, opts: WasmClientOptions = {}) {
    this.wasm = wasm
    this.context = opts.context ?? new TypeContext()
  }

  async query(query: string, opts: QueryOptions = {}): Promise<QueryResult> {
    if (opts.args) throw new Error("WasmClient does not support query args yet")
    opts.signal?.throwIfAborted()
    let out: Uint8Array | string
    try {
      out = await this.wasm.run({
        program: query,
        input: toWasmInput(opts.input),
        inputFormat: opts.inputFormat ?? "auto",
        outputFormat: "bsup",
      })
    } catch (e) {
      throw new SuperDBError(e instanceof Error ? e.message : String(e))
    }
    if (typeof out === "string") {
      throw new SuperDBError("superdb wasm returned BSUP as a string; its run function must return a Uint8Array")
    }
    const bytes = out
    async function* chunks() {
      yield bytes
    }
    return new QueryResult(decodeBSUPStream(chunks(), { context: this.context }))
  }

  /** Runs a query and returns its output in a text format (e.g., "sup", "json", "csv"). */
  async runText(query: string, outputFormat: string, opts: Pick<QueryOptions, "input" | "inputFormat"> = {}): Promise<string> {
    const out = await this.wasm.run({
      program: query,
      input: toWasmInput(opts.input),
      inputFormat: opts.inputFormat ?? "auto",
      outputFormat,
    })
    return typeof out === "string" ? out : new TextDecoder().decode(out)
  }
}

function toWasmInput(input: QueryInput | undefined): string | ReadableStream<Uint8Array> {
  // The module rejects a missing input, so no input is an empty string.
  if (input === undefined) return ""
  if (typeof input === "string") return input
  if (input instanceof Uint8Array) return new Blob([input as Uint8Array<ArrayBuffer>]).stream()
  if (input instanceof Blob) return input.stream()
  return input
}

interface GoRuntime {
  importObject: WebAssembly.Imports
  run(instance: WebAssembly.Instance): Promise<void>
}

/**
 * Instantiates a superdb wasm module built with
 * github.com/teamortix/golang-wasm (as is super's book/super-example).  Go's
 * `wasm_exec.js` must already be loaded so that the global `Go` class exists.
 */
export async function loadSuperWasm(source: string | URL | Response | BufferSource): Promise<SuperWasm> {
  const g = globalThis as unknown as {
    Go?: new () => GoRuntime
    __go_wasm__?: Record<string, unknown>
  }
  if (!g.Go) throw new Error("loadSuperWasm: Go's wasm_exec.js must be loaded first")
  if (!g.__go_wasm__) {
    g.__go_wasm__ = {
      __wrapper__:
        (goFunc: (...args: unknown[]) => { error?: unknown; result?: unknown }) =>
        (...args: unknown[]) => {
          const r = goFunc(...args)
          if (r.error instanceof Error) throw r.error
          return r.result
        },
    }
  }
  const go = new g.Go()
  let instance: WebAssembly.Instance
  if (typeof source === "string" || source instanceof URL) {
    source = await fetch(source)
  }
  if (source instanceof Response) {
    instance = (await WebAssembly.instantiateStreaming(source, go.importObject)).instance
  } else {
    instance = (await WebAssembly.instantiate(source, go.importObject)).instance
  }
  void go.run(instance)
  // golang-wasm publishes exposed functions on __go_wasm__ once main calls
  // wasm.Ready().
  const api = g.__go_wasm__ as Record<string, unknown>
  for (let k = 0; k < 400 && typeof api.run !== "function"; k++) {
    await new Promise((r) => setTimeout(r, 5))
  }
  if (typeof api.run !== "function") throw new Error("loadSuperWasm: module did not expose run")
  return api as unknown as SuperWasm
}
