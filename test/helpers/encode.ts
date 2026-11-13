// A minimal BSUP encoder for tests.  It writes row frames, super footers,
// and hand-assembled column frames so the decoder can be tested without the
// Go implementation.

import { type Type, ID_COMPLEX, TypeContext, under } from "../../src/types.ts"
import type { Value } from "../../src/values.ts"

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

// Typedefs table builder.
export class TypeDefsBuilder {
  private ids = new Map<Type, number>()
  private defs: Uint8Array[] = []

  lookup(t: Type): number {
    if (t.kind === "primitive") return t.id
    const existing = this.ids.get(t)
    if (existing !== undefined) return existing
    if (t.kind === "named") {
      // Reserve the slot first to allow recursion.
      const id = ID_COMPLEX + this.defs.length
      this.ids.set(t, id)
      this.defs.push(new Uint8Array(0))
      const inner = this.lookup(t.type)
      this.defs[id - ID_COMPLEX] = new Bytes().byte(7).string(t.name).u32be(inner).out()
      return id
    }
    const b = new Bytes()
    switch (t.kind) {
      case "record": {
        const ids = t.fields.map((f) => this.lookup(f.type))
        b.byte(0).uvarint(t.fields.length)
        t.fields.forEach((f, k) => b.string(f.name).uvarint(ids[k]))
        break
      }
      case "array":
        b.byte(1).uvarint(this.lookup(t.type))
        break
      case "set":
        b.byte(2).uvarint(this.lookup(t.type))
        break
      case "map": {
        const k = this.lookup(t.keyType)
        const v = this.lookup(t.valType)
        b.byte(3).uvarint(k).uvarint(v)
        break
      }
      case "union": {
        const ids = t.types.map((m) => this.lookup(m))
        b.byte(4).uvarint(ids.length)
        ids.forEach((id) => b.uvarint(id))
        break
      }
      case "enum":
        b.byte(5).uvarint(t.symbols.length)
        t.symbols.forEach((s) => b.string(s))
        break
      case "error":
        b.byte(6).uvarint(this.lookup(t.type))
        break
      case "fusion":
        b.byte(8).uvarint(this.lookup(t.type))
        break
      case "option":
        b.byte(9).uvarint(this.lookup(t.type))
        break
      case "decimal":
        b.byte(10).uvarint(t.precision).uvarint(t.scale)
        break
    }
    const id = ID_COMPLEX + this.defs.length
    this.defs.push(b.out())
    this.ids.set(t, id)
    return id
  }

  bytes(): Uint8Array {
    if (this.defs.length === 0) return new Uint8Array(0)
    const b = new Bytes().uvarint(this.defs.length)
    let off = 0
    for (const d of this.defs) {
      b.uvarint(off)
      off += d.length
    }
    for (const d of this.defs) b.bytes(d)
    return b.out()
  }
}

export function encodeTypeValue(t: Type, names = new Set<string>()): Uint8Array {
  const b = new Bytes()
  const walk = (t: Type) => {
    switch (t.kind) {
      case "primitive":
        b.byte(t.id)
        break
      case "named":
        if (names.has(t.name)) {
          b.byte(56).string(t.name)
        } else {
          names.add(t.name)
          b.byte(55).string(t.name)
          walk(t.type)
        }
        break
      case "record":
        b.byte(48).uvarint(t.fields.length)
        for (const f of t.fields) {
          b.string(f.name)
          walk(f.type)
        }
        break
      case "array":
        b.byte(49)
        walk(t.type)
        break
      case "set":
        b.byte(50)
        walk(t.type)
        break
      case "map":
        b.byte(51)
        walk(t.keyType)
        walk(t.valType)
        break
      case "union":
        b.byte(52).uvarint(t.types.length)
        t.types.forEach(walk)
        break
      case "enum":
        b.byte(53).uvarint(t.symbols.length)
        t.symbols.forEach((s) => b.string(s))
        break
      case "error":
        b.byte(54)
        walk(t.type)
        break
      case "fusion":
        b.byte(57)
        walk(t.type)
        break
      case "option":
        b.byte(58)
        walk(t.type)
        break
      case "decimal":
        b.byte(59).uvarint(t.precision).uvarint(t.scale)
        break
    }
  }
  walk(t)
  return b.out()
}

function uintBody(v: bigint): Uint8Array {
  const out: number[] = []
  while (v !== 0n) {
    out.push(Number(v & 0xffn))
    v >>= 8n
  }
  return Uint8Array.from(out)
}

function intBody(v: bigint): Uint8Array {
  const mask = (1n << 64n) - 1n
  return uintBody(v >= 0n ? v << 1n : (((-v) << 1n) | 1n) & mask)
}

function container(parts: Uint8Array[]): Uint8Array {
  const b = new Bytes()
  for (const p of parts) b.value(p)
  return b.out()
}

/** Encodes the body of a value. */
export function encodeBody(v: Value): Uint8Array {
  switch (v.kind) {
    case "uint":
      return uintBody(BigInt(v.value))
    case "int":
      return intBody(BigInt(v.value))
    case "duration":
    case "timestamp":
      return intBody(v.ns)
    case "float": {
      const t = under(v.type)
      const id = t.kind === "primitive" ? t.id : 26
      if (id === 25) {
        const b = new Uint8Array(4)
        new DataView(b.buffer).setFloat32(0, v.value, true)
        return b
      }
      const b = new Uint8Array(8)
      new DataView(b.buffer).setFloat64(0, v.value, true)
      return b
    }
    case "bool":
      return Uint8Array.of(v.value ? 1 : 0)
    case "bytes":
      return v.value
    case "string":
      return new TextEncoder().encode(v.value)
    case "ip":
    case "net":
    case "uuid":
      return v.bytes
    case "type":
      return encodeTypeValue(v.value)
    case "null":
    case "missing":
    case "none":
      return new Uint8Array(0)
    case "unimplemented":
      return v.bytes
    case "record":
      return container(v.values.map(encodeBody))
    case "array":
    case "set":
      return container(v.items.map(encodeBody))
    case "map":
      return container(v.entries.flatMap(([k, x]) => [encodeBody(k), encodeBody(x)]))
    case "union":
      return container([uintBody(BigInt(v.tag)), encodeBody(v.value)])
    case "enum":
      return uintBody(BigInt(v.index))
    case "error":
      return encodeBody(v.value)
    case "option":
      return v.value === null ? container([uintBody(1n)]) : container([uintBody(0n), encodeBody(v.value)])
    case "fusion":
      return container([encodeBody(v.value), encodeTypeValue(v.subtype)])
  }
}

function fusedTypeOf(ctx: TypeContext, values: Value[]): Type {
  const types = [...new Set(values.map((v) => v.type))]
  return types.length === 1 ? types[0] : ctx.union(types)
}

/** Encodes values as one row frame (or a control frame). */
export function rowFrame(values: Value[], opts: { control?: boolean; ctx?: TypeContext } = {}): Uint8Array {
  const defs = new TypeDefsBuilder()
  const data = new Bytes()
  for (const v of values) data.uvarint(defs.lookup(v.type)).value(encodeBody(v))
  const fusedID = values.length > 0 ? defs.lookup(fusedTypeOf(opts.ctx ?? new TypeContext(), values)) : 0
  const typedefs = defs.bytes()
  const size = 26 + typedefs.length + data.length
  const hdr = new Bytes()
    .bytes(new TextEncoder().encode(opts.control ? "SUPX" : "SUPR"))
    .le(VERSION, 2)
    .le(size, 8)
    .le(fusedID, 4)
    .le(typedefs.length, 8)
  return concat(hdr.out(), typedefs, data.out())
}

/** A super footer for a super frame of the given size. */
export function superFooter(superFrameSize: number, fusedType?: Type): Uint8Array {
  const ft = fusedType ? encodeTypeValue(fusedType) : new Uint8Array(0)
  const footerSize = 38 + 8 + ft.length
  return concat(
    new Bytes()
      .bytes(new TextEncoder().encode("SUPS"))
      .le(VERSION, 2)
      .le(footerSize, 8)
      .le(ft.length, 8)
      .le(0, 8)
      .le(superFrameSize, 8)
      .out(),
    ft,
    new Bytes().le(footerSize, 8).out(),
  )
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
  vdefs = new TypeDefsBuilder()
  tdefs = new TypeDefsBuilder()
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
