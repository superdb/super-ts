// A client for the SuperDB service (`super db serve`).

import { TypeContext } from "../types.ts"
import { decodeBSUPStream } from "../bsup/decoder.ts"
import type { QueryOptions, SuperDBClient } from "./client.ts"
import { QueryResult, SuperDBError } from "./result.ts"

export const MEDIA_TYPE_BSUP = "application/x-bsup"

export interface HTTPClientOptions {
  /** Base URL of the service, e.g., `http://localhost:9867`. */
  url: string
  /** Bearer token, or a function returning one, for services with auth enabled. */
  token?: string | (() => string | undefined | Promise<string | undefined>)
  /** Extra headers for every request. */
  headers?: Record<string, string>
  /** The fetch implementation (default: globalThis.fetch). */
  fetch?: typeof fetch
  /** The type context for results (default: a new context). */
  context?: TypeContext
}

/** A client of the SuperDB service's HTTP API. */
export class HTTPClient implements SuperDBClient {
  readonly url: string
  readonly context: TypeContext
  private opts: HTTPClientOptions
  private fetchFn: typeof fetch

  constructor(opts: HTTPClientOptions | string) {
    this.opts = typeof opts === "string" ? { url: opts } : opts
    this.url = this.opts.url.replace(/\/+$/, "")
    this.context = this.opts.context ?? new TypeContext()
    this.fetchFn = this.opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  private async headers(extra: Record<string, string>): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...this.opts.headers, ...extra }
    const token = typeof this.opts.token === "function" ? await this.opts.token() : this.opts.token
    if (token) h["Authorization"] = `Bearer ${token}`
    return h
  }

  /** Sends a request and throws a SuperDBError for a non-2xx response. */
  async request(method: string, path: string, opts: { body?: unknown; accept?: string; signal?: AbortSignal } = {}): Promise<Response> {
    const headers = await this.headers({ Accept: opts.accept ?? "application/json" })
    let body: BodyInit | undefined
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json"
      body = JSON.stringify(opts.body)
    }
    const res = await this.fetchFn(this.url + path, { method, headers, body, signal: opts.signal })
    if (!res.ok) throw await errorFromResponse(res)
    return res
  }

  /** Runs a query and streams its results. */
  async query(query: string, opts: QueryOptions = {}): Promise<QueryResult> {
    if (opts.input !== undefined) throw new Error("HTTPClient.query does not take inputs; load data into the database instead")
    const controller = new AbortController()
    const onAbort = () => controller.abort(opts.signal?.reason)
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    const res = await this.request("POST", "/query?ctrl=T", {
      body: { query, args: opts.args ?? null },
      accept: MEDIA_TYPE_BSUP,
      signal: controller.signal,
    })
    if (!res.body) throw new SuperDBError("query response has no body")
    const events = decodeBSUPStream(res.body, { context: this.context })
    return new QueryResult(events, () => controller.abort())
  }

  /** The version of the service. */
  async version(): Promise<string> {
    const res = await this.request("GET", "/version")
    const js = (await res.json()) as { version?: string }
    return js.version ?? ""
  }

  /** True if the service responds to its status endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.request("GET", "/status", { accept: "*/*" })
      return true
    } catch {
      return false
    }
  }
}

async function errorFromResponse(res: Response): Promise<SuperDBError> {
  const text = await res.text().catch(() => "")
  try {
    const js = JSON.parse(text) as { error?: string; kind?: string; compilation_errors?: unknown[] }
    if (js && typeof js.error === "string") {
      return new SuperDBError(js.error, { kind: js.kind, status: res.status, compilationErrors: js.compilation_errors })
    }
  } catch {
    // Not JSON.
  }
  return new SuperDBError(text || `${res.status} ${res.statusText}`, { status: res.status })
}
