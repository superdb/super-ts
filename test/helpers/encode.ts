// A minimal BSUP encoder for tests.  It writes row frames, super footers,
// and hand-assembled column frames so the decoder can be tested without the
// Go implementation.

import type { Type, TypeContext } from "../../src/types.ts"
import type { Value } from "../../src/values.ts"
import { TypeDefsEncoder, encodeRowFrame, encodeSuperFooter } from "../../src/bsup/encoder.ts"

export class Bytes {
  parts: number[] = []
  byte(b: number) {
    this.parts.push(b & 0xff)
    return this
  }
  bytes(b: Uint8Array | number[]) {
    for (const x of b) this.parts.push(x)
    return this
  }
  uvarint(n: number | bigint) {
    let v = BigInt(n)
    while (v >= 0x80n) {
      this.parts.push(Number(v & 0x7fn) | 0x80)
      v >>= 7n
    }
    this.parts.push(Number(v))
    return this
  }
  string(s: string) {
    const b = new TextEncoder().encode(s)
    return this.uvarint(b.length).bytes(b)
  }
  value(b: Uint8Array) {
    return this.uvarint(b.length).bytes(b)
  }
  u32be(n: number) {
    return this.byte(n >>> 24).byte(n >>> 16).byte(n >>> 8).byte(n)
  }
  le(n: number | bigint, size: number) {
    let v = BigInt(n)
    for (let k = 0; k < size; k++) {
      this.parts.push(Number(v & 0xffn))
      v >>= 8n
    }
    return this
  }
  get length() {
    return this.parts.length
  }
  out(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

export function concat(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0))
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

export const VERSION = (0 << 10) | 31

// The typedefs, type value, body, row frame, and super footer encoders are
// the library's own.
export { TypeDefsEncoder as TypeDefsBuilder, encodeTypeValue, encodeBody } from "../../src/bsup/encoder.ts"

/** Encodes values as one row frame (or a control frame). */
export function rowFrame(values: Value[], opts: { control?: boolean; ctx?: TypeContext } = {}): Uint8Array {
  return encodeRowFrame(values, { control: opts.control, context: opts.ctx })
}

/** A super footer for a super frame of the given size. */
export function superFooter(superFrameSize: number, fusedType?: Type): Uint8Array {
  return encodeSuperFooter(superFrameSize, fusedType)
}

/** Encodes values as a BSUP file with one row frame and a super footer. */
export function encodeRows(values: Value[]): Uint8Array {
  const frame = rowFrame(values)
  return concat(frame, superFooter(frame.length, values[0]?.type))
}

// intcomp variable-byte encoders (enough for small vectors).

function varBytes(delta: bigint): number[] {
  const out: number[] = []
  while (delta >= 0x80n) {
    out.push(Number(delta & 0x7fn) | 0x80)
    delta >>= 7n
  }
  out.push(Number(delta))
  return out
}

/** intcomp.CompressUint32 for fewer than 128 values. */
export function intcompUint32(vals: number[]): Uint8Array {
  if (vals.length === 0) return new Uint8Array(0)
  if (vals.length >= 128) throw new Error("test encoder handles < 128 values")
  const bytes: number[] = []
  let prev = 0
  for (const v of vals) {
    bytes.push(...varBytes(BigInt((v - prev) >>> 0)))
    prev = v
  }
  while (bytes.length % 4) bytes.push(0x80)
  const words = [vals.length, 0]
  for (let k = 0; k < bytes.length; k += 4) {
    words.push(((bytes[k] << 24) | (bytes[k + 1] << 16) | (bytes[k + 2] << 8) | bytes[k + 3]) >>> 0)
  }
  words[1] = words.length
  words.push(words.length)
  const b = new Bytes()
  for (const w of words) b.le(w, 4)
  return b.out()
}

/** intcomp.CompressInt64/CompressUint64 for fewer than 256 values. */
export function intcomp64(vals: (number | bigint)[]): Uint8Array {
  if (vals.length === 0) return new Uint8Array(0)
  if (vals.length >= 256) throw new Error("test encoder handles < 256 values")
  const mask = (1n << 64n) - 1n
  const bytes: number[] = []
  let prev = 0n
  for (const x of vals) {
    const v = BigInt(x) & mask
    bytes.push(...varBytes((v - prev) & mask))
    prev = v
  }
  while (bytes.length % 8) bytes.push(0x80)
  const words: bigint[] = [0n]
  for (let k = 0; k < bytes.length; k += 8) {
    let w = 0n
    for (let j = 0; j < 8; j++) w = (w << 8n) | BigInt(bytes[k + j])
    words.push(w)
  }
  words[0] = BigInt(vals.length) | (BigInt(words.length) << 32n)
  words.push(BigInt(words.length))
  const b = new Bytes()
  for (const w of words) b.le(w, 8)
  return b.out()
}

/**
 * Assembles a column frame.  Build the locators with `loc` (in DFS order)
 * and add each segment's data with seg() in the same order.
 */
export class ColumnFrameBuilder {
  vdefs = new TypeDefsEncoder()
  tdefs = new TypeDefsEncoder()
  loc = new Bytes()
  private data: Uint8Array[] = []

  /** Appends an uncompressed segment to the locators and data. */
  seg(b: Uint8Array) {
    this.loc.byte(0).uvarint(b.length)
    this.data.push(b)
    return this
  }

  /** Appends an LZ4-compressed segment given its compressed bytes and uncompressed length. */
  segLZ4(compressed: Uint8Array, memLen: number) {
    this.loc.byte(1).uvarint(memLen).uvarint(compressed.length)
    this.data.push(compressed)
    return this
  }

  frame(rootIDs: number[], fusedType: Type, dynamicTagsFirst?: Uint8Array): Uint8Array {
    const fusedID = this.tdefs.lookup(fusedType)
    const head = new Bytes().uvarint(rootIDs.length)
    rootIDs.forEach((id) => head.uvarint(id))
    const data = concat(...(dynamicTagsFirst ? [dynamicTagsFirst] : []), ...this.data)
    if (dynamicTagsFirst) head.byte(0).uvarint(dynamicTagsFirst.length)
    const locators = concat(head.out(), this.loc.out())
    const vt = this.vdefs.bytes()
    const td = this.tdefs.bytes()
    const size = 42 + vt.length + locators.length + td.length + data.length
    const hdr = new Bytes()
      .bytes(new TextEncoder().encode("SUPC"))
      .le(VERSION, 2)
      .le(size, 8)
      .le(fusedID, 4)
      .le(vt.length, 8)
      .le(locators.length, 8)
      .le(td.length, 8)
    return concat(hdr.out(), vt, locators, td, data)
  }
}
