// A streaming BSUP decoder.
//
// Feed it bytes in chunks of any size (e.g., from a fetch response body) and
// it returns events as whole frames arrive: batches of values, control
// messages, and the end of each super frame.

import { type Type, TypeContext } from "../types.ts"
import type { Value } from "../values.ts"
import { decodeBody } from "./body.ts"
import { decodeColumnFrame } from "./columns.ts"
import { BSUPFormatError, ByteReader, readSizeLE, readUint32LE } from "./reader.ts"
import { TypeDefs, decodeTypeValue } from "./typedefs.ts"

/** The BSUP version this decoder implements. */
export const BSUP_VERSION = { major: 0, minor: 31 } as const

export const ROW_MAGIC = "SUPR"
export const CONTROL_MAGIC = "SUPX"
export const COLUMN_MAGIC = "SUPC"
export const SUPER_MAGIC = "SUPS"

const ROW_HEADER_SIZE = 26
const SUPER_FOOTER_SIZE = 38
const MAX_FRAME_SIZE = 2 * 1024 * 1024 * 1024

export type BSUPEvent =
  /** A batch of values from a row or column frame. */
  | { kind: "values"; values: Value[]; frame: "row" | "column"; fusedType: Type | undefined }
  /** Control messages from a control frame (e.g., query channel changes). */
  | { kind: "control"; values: Value[] }
  /** The end of a super frame and the fused type of its values. */
  | { kind: "superframe"; fusedType: Type | undefined }

export interface DecoderOptions {
  /** The context in which to create types (default: a new context). */
  context?: TypeContext
}

function magicOf(b: Uint8Array, off: number): string {
  return String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3])
}

function checkVersion(b: Uint8Array, off: number) {
  const v = b[off + 4] | (b[off + 5] << 8)
  const major = v >>> 10
  const minor = v & 0x3ff
  if (major !== BSUP_VERSION.major || (major === 0 && minor !== BSUP_VERSION.minor)) {
    throw new BSUPFormatError(
      `version mismatch: expected ${BSUP_VERSION.major}.${BSUP_VERSION.minor}, found ${major}.${minor}`,
    )
  }
}

export class BSUPDecoder {
  readonly context: TypeContext
  private buf = new Uint8Array(0)
  private start = 0
  private end = 0
  private consumed = 0

  constructor(opts: DecoderOptions = {}) {
    this.context = opts.context ?? new TypeContext()
  }

  /** The number of bytes decoded so far. */
  get bytesDecoded(): number {
    return this.consumed
  }

  /** Appends a chunk of bytes and returns the events of any whole frames. */
  push(chunk: Uint8Array): BSUPEvent[] {
    this.append(chunk)
    const events: BSUPEvent[] = []
    for (;;) {
      const ev = this.next()
      if (ev === undefined) break
      if (ev !== null) events.push(ev)
    }
    return events
  }

  /** Signals the end of input. Throws if a partial frame remains. */
  finish(): void {
    if (this.end > this.start) {
      throw new BSUPFormatError(`truncated input: ${this.end - this.start} bytes of an incomplete frame`)
    }
  }

  private append(chunk: Uint8Array) {
    if (chunk.length === 0) return
    const live = this.end - this.start
    if (this.end + chunk.length > this.buf.length) {
      if (live + chunk.length <= this.buf.length && this.start > 0) {
        this.buf.copyWithin(0, this.start, this.end)
      } else {
        const grown = new Uint8Array(Math.max(live + chunk.length, this.buf.length * 2, 64 * 1024))
        grown.set(this.buf.subarray(this.start, this.end))
        this.buf = grown
      }
      this.start = 0
      this.end = live
    }
    this.buf.set(chunk, this.end)
    this.end += chunk.length
  }

  // next decodes the next frame if it's all here.  It returns undefined if
  // more input is needed and null for a frame that produces no event.
  private next(): BSUPEvent | null | undefined {
    const avail = this.end - this.start
    if (avail < 14) return undefined
    const b = this.buf
    const off = this.start
    const magic = magicOf(b, off)
    if (magic !== ROW_MAGIC && magic !== CONTROL_MAGIC && magic !== COLUMN_MAGIC && magic !== SUPER_MAGIC) {
      throw new BSUPFormatError(`unknown frame magic ${JSON.stringify(magic)}`)
    }
    checkVersion(b, off)
    const size = readSizeLE(b, off + 6)
    if (size > MAX_FRAME_SIZE) throw new BSUPFormatError(`frame size ${size} too large`)
    if (avail < size) return undefined
    // Copy the frame out of the shared buffer so values never alias it.
    const frame = b.slice(off, off + size)
    this.start += size
    this.consumed += size
    if (this.start === this.end) this.start = this.end = 0
    switch (magic) {
      case ROW_MAGIC: {
        const { values, fusedType } = decodeRowFrame(this.context, frame)
        return values.length > 0 ? { kind: "values", values, frame: "row", fusedType } : null
      }
      case CONTROL_MAGIC:
        return { kind: "control", values: decodeRowFrame(this.context, frame).values }
      case COLUMN_MAGIC: {
        const { values, fusedType } = decodeColumnFrame(this.context, frame)
        return values.length > 0 ? { kind: "values", values, frame: "column", fusedType } : null
      }
      default:
        return { kind: "superframe", fusedType: decodeSuperFooter(this.context, frame) }
    }
  }
}

/** Decodes a row (or control) frame, starting with its header. */
export function decodeRowFrame(ctx: TypeContext, frame: Uint8Array): { values: Value[]; fusedType: Type | undefined } {
  if (frame.length < ROW_HEADER_SIZE) throw new BSUPFormatError("short row frame")
  const fusedID = readUint32LE(frame, 14)
  const typedefsSize = readSizeLE(frame, 18)
  if (ROW_HEADER_SIZE + typedefsSize > frame.length) throw new BSUPFormatError("typedefs section out of range")
  const defs = new TypeDefs(ctx, frame.subarray(ROW_HEADER_SIZE, ROW_HEADER_SIZE + typedefsSize))
  const r = new ByteReader(frame, ROW_HEADER_SIZE + typedefsSize)
  const values: Value[] = []
  while (!r.done()) {
    const typ = defs.lookup(r.uvarint())
    values.push(decodeBody(ctx, typ, r.value()))
  }
  const fusedType = values.length > 0 ? defs.lookup(fusedID) : undefined
  return { values, fusedType }
}

/** Decodes a super footer and returns the fused type of its super frame. */
export function decodeSuperFooter(ctx: TypeContext, footer: Uint8Array): Type | undefined {
  if (footer.length < SUPER_FOOTER_SIZE + 8) throw new BSUPFormatError("short super footer")
  const fusedSize = readSizeLE(footer, 14)
  if (SUPER_FOOTER_SIZE + fusedSize > footer.length) throw new BSUPFormatError("fused type out of range")
  if (fusedSize === 0) return undefined
  return decodeTypeValue(ctx, footer.subarray(SUPER_FOOTER_SIZE, SUPER_FOOTER_SIZE + fusedSize))
}

/**
 * Decodes BSUP bytes and returns all of their values, ignoring control
 * messages.
 */
export function decodeBSUP(bytes: Uint8Array, opts: DecoderOptions = {}): Value[] {
  const d = new BSUPDecoder(opts)
  const out: Value[] = []
  for (const ev of d.push(bytes)) {
    if (ev.kind === "values") for (const v of ev.values) out.push(v)
  }
  d.finish()
  return out
}

/** Decodes a stream of BSUP bytes into an async sequence of events. */
export async function* decodeBSUPStream(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  opts: DecoderOptions = {},
): AsyncGenerator<BSUPEvent> {
  const d = new BSUPDecoder(opts)
  for await (const chunk of toAsyncIterable(stream)) {
    yield* d.push(chunk)
  }
  d.finish()
}

/** Adapts a ReadableStream (which may lack Symbol.asyncIterator) to an async iterable. */
export async function* toAsyncIterable<T>(stream: AsyncIterable<T> | ReadableStream<T>): AsyncGenerator<T> {
  if (Symbol.asyncIterator in stream) {
    yield* stream as AsyncIterable<T>
    return
  }
  const reader = (stream as ReadableStream<T>).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}
