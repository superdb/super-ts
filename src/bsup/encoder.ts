// A BSUP encoder.
//
// It writes values as row frames followed by a super footer, which is all
// SuperDB needs to read them with their types intact.  (Column frames are
// what super writes by default, but they are an optimization for big data
// that a client sending values has no need for.)

import { type Type, type TypeUnion, ID, ID_COMPLEX, TypeContext, under } from "../types.ts"
import type { Value } from "../values.ts"
import { BSUP_VERSION, ROW_MAGIC, CONTROL_MAGIC, SUPER_MAGIC } from "./decoder.ts"

const utf8 = new TextEncoder()

/** A growable byte buffer with the integer encodings that BSUP uses. */
export class ByteWriter {
  private buf: Uint8Array
  private len = 0

  constructor(capacity = 64) {
    this.buf = new Uint8Array(capacity)
  }

  private grow(n: number) {
    if (this.len + n <= this.buf.length) return
    const grown = new Uint8Array(Math.max(this.buf.length * 2, this.len + n))
    grown.set(this.buf.subarray(0, this.len))
    this.buf = grown
  }

  get length(): number {
    return this.len
  }

  byte(b: number): this {
    this.grow(1)
    this.buf[this.len++] = b & 0xff
    return this
  }

  bytes(b: Uint8Array | readonly number[]): this {
    this.grow(b.length)
    this.buf.set(b, this.len)
    this.len += b.length
    return this
  }

  uvarint(n: number | bigint): this {
    if (typeof n === "number" && n < 0x80000000) {
      while (n >= 0x80) {
        this.byte((n & 0x7f) | 0x80)
        n >>>= 7
      }
      return this.byte(n)
    }
    let v = BigInt(n)
    while (v >= 0x80n) {
      this.byte(Number(v & 0x7fn) | 0x80)
      v >>= 7n
    }
    return this.byte(Number(v))
  }

  /** A counted string: a uvarint length followed by UTF-8 bytes. */
  string(s: string): this {
    const b = utf8.encode(s)
    return this.uvarint(b.length).bytes(b)
  }

  /** A length-prefixed value body. */
  value(b: Uint8Array): this {
    return this.uvarint(b.length).bytes(b)
  }

  uint32BE(n: number): this {
    return this.byte(n >>> 24).byte(n >>> 16).byte(n >>> 8).byte(n)
  }

  /** A little-endian unsigned integer of size bytes. */
  le(n: number | bigint, size: number): this {
    let v = BigInt(n)
    for (let k = 0; k < size; k++) {
      this.byte(Number(v & 0xffn))
      v >>= 8n
    }
    return this
  }

  /** The bytes written so far (a copy). */
  out(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

function concat(arrs: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0))
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

/** Builds the typedefs table of a frame, assigning type IDs as types are looked up. */
export class TypeDefsEncoder {
  private ids = new Map<Type, number>()
  private defs: Uint8Array[] = []

  /** The ID of t in this table, adding typedefs for it as needed. */
  lookup(t: Type): number {
    if (t.kind === "primitive") return t.id
    const existing = this.ids.get(t)
    if (existing !== undefined) return existing
    if (t.kind === "named") {
      // Reserve the slot first so the underlying type can refer to it.
      const id = ID_COMPLEX + this.defs.length
      this.ids.set(t, id)
      this.defs.push(new Uint8Array(0))
      const inner = this.lookup(t.type)
      this.defs[id - ID_COMPLEX] = new ByteWriter().byte(7).string(t.name).uint32BE(inner).out()
      return id
    }
    const b = new ByteWriter()
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

  /** The typedefs section: a count, the offset of each typedef, then the typedefs. */
  bytes(): Uint8Array {
    if (this.defs.length === 0) return new Uint8Array(0)
    const b = new ByteWriter().uvarint(this.defs.length)
    let off = 0
    for (const d of this.defs) {
      b.uvarint(off)
      off += d.length
    }
    for (const d of this.defs) b.bytes(d)
    return b.out()
  }
}

/** Encodes t as a type value (the body of a value of type `type`). */
export function encodeTypeValue(t: Type, names = new Set<string>()): Uint8Array {
  const b = new ByteWriter()
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

const EMPTY = new Uint8Array(0)
const MASK64 = (1n << 64n) - 1n

function uintBody(n: number | bigint): Uint8Array {
  if (typeof n === "number" && n >= 0 && n < 0x100000000) {
    if (n === 0) return EMPTY
    if (n < 0x100) return Uint8Array.of(n)
    const out: number[] = []
    for (; n > 0; n = Math.floor(n / 256)) out.push(n & 0xff)
    return Uint8Array.from(out)
  }
  let v = BigInt(n)
  if (v < 0n || v > MASK64) throw new RangeError(`unsigned integer ${v} out of range`)
  const out: number[] = []
  for (; v !== 0n; v >>= 8n) out.push(Number(v & 0xffn))
  return Uint8Array.from(out)
}

function intBody(n: number | bigint): Uint8Array {
  const v = BigInt(n)
  if (v < -(1n << 63n) || v >= 1n << 63n) throw new RangeError(`integer ${v} out of range`)
  return uintBody(v >= 0n ? v << 1n : ((-v << 1n) | 1n) & MASK64)
}

function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/** The IEEE 754 binary16 bits of the float16 nearest to x. */
function float16Bits(x: number): number {
  if (Number.isNaN(x)) return 0x7e00
  const sign = x < 0 || Object.is(x, -0) ? 0x8000 : 0
  x = Math.abs(x)
  if (x === 0) return sign
  if (x === Infinity) return sign | 0x7c00
  let exp = Math.floor(Math.log2(x))
  if (x < 2 ** exp) exp--
  else if (x >= 2 ** (exp + 1)) exp++
  // Below 2^-14 values are subnormal, in units of 2^-24.  Rounding up to
  // 0x400 carries into the exponent, which is the right answer.
  if (exp < -14) return sign | roundHalfEven(x * 2 ** 24)
  let frac = roundHalfEven((x / 2 ** exp - 1) * 1024)
  if (frac === 1024) {
    frac = 0
    exp++
  }
  return exp > 15 ? sign | 0x7c00 : sign | ((exp + 15) << 10) | frac
}

function container(parts: readonly Uint8Array[]): Uint8Array {
  const b = new ByteWriter(parts.reduce((n, p) => n + p.length + 2, 0))
  for (const p of parts) b.value(p)
  return b.out()
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let k = 0; k < n; k++) {
    if (a[k] !== b[k]) return a[k] - b[k]
  }
  return a.length - b.length
}

function prefixed(body: Uint8Array): Uint8Array {
  return new ByteWriter(body.length + 2).value(body).out()
}

/** Encodes the body of a value (the row encoding of the value without its type). */
export function encodeBody(v: Value): Uint8Array {
  switch (v.kind) {
    case "uint":
      return uintBody(v.value)
    case "int":
      return intBody(v.value)
    case "duration":
    case "timestamp":
      return intBody(v.ns)
    case "float": {
      const t = under(v.type)
      const id = t.kind === "primitive" ? t.id : ID.float64
      const b = new Uint8Array(id === ID.float16 ? 2 : id === ID.float32 ? 4 : 8)
      const dv = new DataView(b.buffer)
      if (id === ID.float16) dv.setUint16(0, float16Bits(v.value), true)
      else if (id === ID.float32) dv.setFloat32(0, v.value, true)
      else dv.setFloat64(0, v.value, true)
      return b
    }
    case "bool":
      return Uint8Array.of(v.value ? 1 : 0)
    case "bytes":
      return v.value
    case "string":
      return utf8.encode(v.value)
    case "ip":
    case "net":
    case "uuid":
      return v.bytes
    case "type":
      return encodeTypeValue(v.value)
    case "null":
    case "missing":
    case "none":
      return EMPTY
    case "unimplemented":
      return v.bytes
    case "record":
      return container(v.values.map(encodeBody))
    case "array":
      return container(v.items.map(encodeBody))
    case "set": {
      // A set's elements are sorted by their length-prefixed bytes and
      // duplicates are removed.
      const elems = v.items.map((x) => prefixed(encodeBody(x))).sort(compareBytes)
      return concat(elems.filter((e, k) => k === 0 || compareBytes(e, elems[k - 1]) !== 0))
    }
    case "map": {
      // Likewise a map's entries, by their keys.
      const entries = v.entries
        .map(([k, x]) => [prefixed(encodeBody(k)), x] as const)
        .sort((a, b) => compareBytes(a[0], b[0]))
        .filter((e, k, all) => k === 0 || compareBytes(e[0], all[k - 1][0]) !== 0)
      return concat(entries.flatMap(([k, x]) => [k, prefixed(encodeBody(x))]))
    }
    case "union":
      return container([uintBody(v.tag), encodeBody(v.value)])
    case "enum":
      return uintBody(v.index)
    case "error":
      return encodeBody(v.value)
    case "option":
      return v.value === null ? container([uintBody(1)]) : container([EMPTY, encodeBody(v.value)])
    case "fusion":
      return container([encodeBody(v.value), encodeTypeValue(v.subtype)])
  }
}

const VERSION = (BSUP_VERSION.major << 10) | BSUP_VERSION.minor

function magic(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0))
}

/**
 * True if fusing just typ gives typ back, i.e., typ is the fused type of a
 * collection whose values all have type typ.  That holds unless typ has
 * (outside of any named type, which fusion doesn't look into) a fusion
 * type, any, or a union whose members SuperDB would combine: two unnamed
 * types of the same complex kind, such as two records.
 */
export function isFusedType(typ: Type): boolean {
  switch (typ.kind) {
    case "primitive":
      return typ.id !== ID.any && typ.id !== ID.all
    case "named":
    case "enum":
    case "decimal":
      return true
    case "record":
      return typ.fields.every((f) => isFusedType(f.type))
    case "array":
    case "set":
    case "error":
    case "option":
      return isFusedType(typ.type)
    case "map":
      return isFusedType(typ.keyType) && isFusedType(typ.valType)
    case "union":
      return unionIsFused(typ)
    case "fusion":
      return false
  }
}

function unionIsFused(typ: TypeUnion): boolean {
  const kinds = new Set<string>()
  for (const t of typ.types) {
    if (t.kind === "union" || !isFusedType(t)) return false
    if (t.kind === "primitive" || t.kind === "named") continue
    if (kinds.has(t.kind)) return false
    kinds.add(t.kind)
  }
  return true
}

export interface EncodeOptions {
  /**
   * The fused type of the values, which SuperDB's type checker uses to
   * check queries on a BSUP file.  By default it's the type of the values
   * when they all have one type that is its own fused type (see
   * isFusedType).  Otherwise it's left out of the super footer, since
   * computing it takes SuperDB's type fusion, and queries on the file are
   * checked as they run instead.
   */
  fusedType?: Type
  /** The most values to put in one frame (default 8192). */
  frameLength?: number
  /** A context for the types this encoder makes (default: a new context). */
  context?: TypeContext
}

/** Encodes values as one row frame (or as a control frame). */
export function encodeRowFrame(
  values: readonly Value[],
  opts: { control?: boolean; fusedType?: Type; context?: TypeContext } = {},
): Uint8Array {
  const defs = new TypeDefsEncoder()
  const data = new ByteWriter(1024)
  const types = new Set<Type>()
  for (const v of values) {
    types.add(v.type)
    data.uvarint(defs.lookup(v.type)).value(encodeBody(v))
  }
  // A frame's header needs a type for all of its values.  Lacking type
  // fusion, a union of their types stands in when they have several.
  let fused = opts.fusedType
  if (!fused && types.size > 0) fused = (opts.context ?? new TypeContext()).unionOf([...types].flatMap(members))
  const fusedID = fused ? defs.lookup(fused) : 0
  const typedefs = defs.bytes()
  return new ByteWriter(26 + typedefs.length + data.length)
    .bytes(magic(opts.control ? CONTROL_MAGIC : ROW_MAGIC))
    .le(VERSION, 2)
    .le(26 + typedefs.length + data.length, 8)
    .le(fusedID, 4)
    .le(typedefs.length, 8)
    .bytes(typedefs)
    .bytes(data.out())
    .out()
}

function members(t: Type): readonly Type[] {
  return t.kind === "union" ? t.types : [t]
}

/** Encodes the super footer that ends a super frame of the given size. */
export function encodeSuperFooter(superFrameSize: number, fusedType?: Type): Uint8Array {
  const ft = fusedType ? encodeTypeValue(fusedType) : EMPTY
  const footerSize = 38 + 8 + ft.length
  return new ByteWriter(footerSize)
    .bytes(magic(SUPER_MAGIC))
    .le(VERSION, 2)
    .le(footerSize, 8)
    .le(ft.length, 8)
    .le(0, 8)
    .le(superFrameSize, 8)
    .bytes(ft)
    .le(footerSize, 8)
    .out()
}

/**
 * Encodes values as BSUP: row frames followed by a super footer.  The
 * result can be written to a file for the super command, loaded into a
 * database, or decoded with decodeBSUP.
 */
export function encodeBSUP(values: Iterable<Value>, opts: EncodeOptions = {}): Uint8Array {
  const all = Array.isArray(values) ? (values as Value[]) : [...values]
  const frameLength = Math.max(1, opts.frameLength ?? 8192)
  let fused = opts.fusedType
  if (!fused && all.length > 0) {
    const t = all[0].type
    if (all.every((v) => v.type === t) && isFusedType(t)) fused = t
  }
  const parts: Uint8Array[] = []
  let size = 0
  for (let k = 0; k < all.length; k += frameLength) {
    const frame = encodeRowFrame(all.slice(k, k + frameLength), { fusedType: fused, context: opts.context })
    parts.push(frame)
    size += frame.length
  }
  parts.push(encodeSuperFooter(size, fused))
  return concat(parts)
}
