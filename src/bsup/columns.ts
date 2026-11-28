// Decoding of BSUP column frames.
//
// A column frame holds vectors described by a locators section that refers
// to segments of the frame's data section.  LazyColumnFrame reads the
// locators up front into a tree of vector readers, which costs little, and
// decodes values only when they're asked for: value i of the frame is built
// from element i (or the elements it refers to) of each vector, and each
// segment is decompressed and decoded the first time it's needed.  Decoded
// segments are kept in a SegmentCache, which drops the least recently used
// ones when it gets too big (except those that the last two frames read have
// used), so a result with a lot of data can be browsed without decoding all
// of it or keeping it all decoded.
//
// decodeColumnFrame decodes all of a frame's values.

import { type Type, type TypeContext, ID, ID_COMPLEX, primitiveType } from "../types.ts"
import {
  type Value,
  ArrayValue,
  BoolValue,
  DurationValue,
  EnumValue,
  ErrorValue,
  FloatValue,
  FusionValue,
  IntValue,
  MapValue,
  NullValue,
  OptionValue,
  RecordValue,
  SetValue,
  TimestampValue,
  TypeValue,
  UintValue,
  UnimplementedValue,
  UnionValue,
  compactInt,
} from "../values.ts"
import { decodeBody, decodePrimitive } from "./body.ts"
import { uncompressInt64, uncompressUint32, uncompressUint64 } from "./intcomp.ts"
import { lz4Uncompress } from "./lz4.ts"
import { BSUPFormatError, ByteReader, readSizeLE, readUint32LE } from "./reader.ts"
import { TypeDefCode, TypeDefs } from "./typedefs.ts"

export const COLUMN_HEADER_SIZE = 42

const KIND_PLAIN = 0
const KIND_CONST = 1
const KIND_DICT = 2
const KIND_NONE = 3

const IN_VECTOR = 0
const IN_OPTION = 1
const IN_DICT = 2

const MAX_DEPTH = 10_000

/**
 * A cache of decoded segments (and other data derived from a frame) that
 * drops the least recently used entries when their total size exceeds its
 * budget, except for entries that the last two frames read have used.  So
 * the cache can hold up to those two frames' decoded segments, even if
 * that's more than the budget, but a frame bigger than the budget isn't
 * decoded again for every value.  Share one cache among the frames of a
 * result so the budget applies to all of them.
 */
export class SegmentCache {
  /** The most bytes to keep (approximately), except for what the last two frames read have used. */
  readonly budget: number
  private entries = new Map<object, { value: unknown; size: number; visit: number }>()
  private total = 0
  private current: object | undefined
  // visit counts the times reading switched to another frame.
  private visit = 0

  constructor(budget = 256 * 1024 * 1024) {
    this.budget = budget
  }

  /** Notes that frame is being read (LazyColumnFrame calls this for each value). */
  reading(frame: object) {
    if (frame !== this.current) {
      this.current = frame
      this.visit++
    }
  }

  /** The cached value for key, made with make (which also returns its size in bytes) if it isn't cached. */
  get<T>(key: object, make: () => [T, number]): T {
    const e = this.entries.get(key)
    if (e) {
      if (e.visit !== this.visit) {
        // Move it to the end, the most recently used.
        this.entries.delete(key)
        e.visit = this.visit
        this.entries.set(key, e)
      }
      return e.value as T
    }
    const [value, size] = make()
    this.entries.set(key, { value, size, visit: this.visit })
    this.total += size
    // The entries are in order of the visit that last used them, so the
    // ones used in the last two visits come last.
    for (const [k, old] of this.entries) {
      if (this.total <= this.budget || old.visit >= this.visit - 1) break
      this.entries.delete(k)
      this.total -= old.size
    }
    return value
  }

  /** The bytes cached now. */
  get size(): number {
    return this.total
  }

  clear() {
    this.entries.clear()
    this.total = 0
  }
}

// A segment of a frame's data section.
class Segment {
  readonly data: Uint8Array
  readonly format: number
  readonly memLen: number
  readonly cache: SegmentCache

  constructor(data: Uint8Array, format: number, memLen: number, cache: SegmentCache) {
    this.data = data
    this.format = format
    this.memLen = memLen
    this.cache = cache
  }

  /** The segment's uncompressed bytes. */
  bytes(): Uint8Array {
    if (this.format === 0) return this.data
    return this.cache.get(this, () => [lz4Uncompress(this.data, this.memLen), this.memLen])
  }

  // derived caches something computed from the segment's bytes under key.
  derived<T>(key: object, make: (b: Uint8Array) => [T, number]): T {
    return this.cache.get(key, () => make(this.bytes()))
  }

  uint32s(key: object, count?: number): Uint32Array {
    return this.derived(key, (b) => {
      const a = b.length === 0 && (count === 0 || count === undefined) ? new Uint32Array(0) : uncompressUint32(b, count)
      return [a, a.byteLength]
    })
  }
}

/** A vector of values in a column frame. */
interface Vec {
  readonly length: number
  get(i: number): Value
}

// The values of an option vector whose values are all none.
class NoneVec {
  readonly length: number
  constructor(length: number) {
    this.length = length
  }
}

type AnyVec = Vec | NoneVec

function checkIndex(i: number, n: number) {
  if (!(i >= 0 && i < n)) throw new RangeError(`index ${i} out of range [0,${n})`)
}

class ConstVec implements Vec {
  readonly length: number
  private value: Value
  constructor(length: number, value: Value) {
    this.length = length
    this.value = value
  }
  get(i: number): Value {
    checkIndex(i, this.length)
    return this.value
  }
}

class DictVec implements Vec {
  readonly length: number
  private distinct: Vec
  private index: Segment
  constructor(distinct: Vec, index: Segment) {
    this.distinct = distinct
    this.index = index
    this.length = index.memLen
  }
  get(i: number): Value {
    checkIndex(i, this.length)
    const k = this.index.bytes()[i]
    if (k >= this.distinct.length) throw new BSUPFormatError("dict index out of range")
    return this.distinct.get(k)
  }
}

// A vector of a primitive type.
class PrimVec implements Vec {
  readonly length: number
  private ctx: TypeContext
  private typ: Type
  private id: number
  private segs: Segment[]
  private tdefs: () => TypeDefs

  constructor(ctx: TypeContext, typ: Type, id: number, length: number, segs: Segment[], tdefs: () => TypeDefs) {
    this.ctx = ctx
    this.typ = typ
    this.id = id
    this.length = length
    this.segs = segs
    this.tdefs = tdefs
  }

  get(i: number): Value {
    checkIndex(i, this.length)
    const { typ, id } = this
    switch (id) {
      case ID.uint8:
      case ID.uint16:
      case ID.uint32:
      case ID.uint64:
      case ID.int8:
      case ID.int16:
      case ID.int32:
      case ID.int64:
      case ID.duration:
      case ID.timestamp: {
        const unsigned = id <= ID.uint64
        const seg = this.segs[0]
        const vals = seg.derived(this, (b) => {
          const a = unsigned ? uncompressUint64(b, this.length) : uncompressInt64(b, this.length)
          return [a, a.byteLength]
        })
        const v = vals[i]
        if (id === ID.duration) return new DurationValue(typ, v)
        if (id === ID.timestamp) return new TimestampValue(typ, v)
        return unsigned ? new UintValue(typ, compactInt(v)) : new IntValue(typ, compactInt(v))
      }
      case ID.float16:
      case ID.float32:
      case ID.float64: {
        const b = this.segs[0].bytes()
        if (b.length < this.length * 8) throw new BSUPFormatError("float segment too short")
        return new FloatValue(typ, new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat64(i * 8, true))
      }
      case ID.bool: {
        const b = this.segs[0].bytes()
        if (b.length * 8 < this.length) throw new BSUPFormatError("bool segment too short")
        return new BoolValue(typ, ((b[i >>> 3] >>> (i & 7)) & 1) === 1)
      }
      case ID.type: {
        const ids = this.segs[0].uint32s(this, this.length)
        return new TypeValue(typ, this.tdefs().lookup(ids[i]))
      }
      case ID.bytes:
      case ID.string:
      case ID.uuid:
      case ID.all:
      case ID.ip:
      case ID.net: {
        const bytes = this.segs[0].bytes()
        const offs = this.segs[1].uint32s(this, this.length + 1)
        if (offs[i] > offs[i + 1] || offs[i + 1] > bytes.length) throw new BSUPFormatError("bytes table offsets out of range")
        let b = bytes.subarray(offs[i], offs[i + 1])
        if (id === ID.all) return new UnimplementedValue(typ, b)
        if (id === ID.net) b = netFromPrefix(b)
        return decodePrimitive(this.ctx, typ, id, b)
      }
      case ID.null:
      case ID.missing:
      case ID.none:
        return decodePrimitive(this.ctx, typ, id, new Uint8Array(0))
      default:
        throw new BSUPFormatError(`type ${primitiveType(id).name} has no vector encoding`)
    }
  }
}

class RecordVec implements Vec {
  readonly length: number
  private typ: Type
  private fields: Vec[]
  constructor(typ: Type, fields: Vec[], length: number) {
    this.typ = typ
    this.fields = fields
    this.length = length
  }
  get(i: number): Value {
    checkIndex(i, this.length)
    return new RecordValue(
      this.typ,
      this.fields.map((f) => f.get(i)),
    )
  }
}

class ListVec implements Vec {
  readonly length: number
  private typ: Type
  private set: boolean
  private offsets: Segment
  private elems: Vec
  constructor(typ: Type, set: boolean, length: number, offsets: Segment, elems: Vec) {
    this.typ = typ
    this.set = set
    this.length = length
    this.offsets = offsets
    this.elems = elems
  }
  get(i: number): Value {
    checkIndex(i, this.length)
    const [from, to] = range(this.offsets, this, this.length, i, this.elems.length)
    const items: Value[] = []
    for (let j = from; j < to; j++) items.push(this.elems.get(j))
    return this.set ? new SetValue(this.typ, items) : new ArrayValue(this.typ, items)
  }
}

// range is the range of child elements of element i of a list or map vector.
function range(seg: Segment, key: object, n: number, i: number, childLen: number): [number, number] {
  const offs = seg.uint32s(key, n === 0 ? 0 : n + 1)
  const from = offs[i]
  const to = offs[i + 1]
  if (from > to || to > childLen) throw new BSUPFormatError("offsets out of range")
  return [from, to]
}

class MapVec implements Vec {
  readonly length: number
  private typ: Type
  private offsets: Segment
  private keys: Vec
  private vals: Vec
  constructor(typ: Type, length: number, offsets: Segment, keys: Vec, vals: Vec) {
    this.typ = typ
    this.length = length
    this.offsets = offsets
    this.keys = keys
    this.vals = vals
  }
  get(i: number): Value {
    checkIndex(i, this.length)
    const [from, to] = range(this.offsets, this, this.length, i, Math.min(this.keys.length, this.vals.length))
    const entries: [Value, Value][] = []
    for (let j = from; j < to; j++) entries.push([this.keys.get(j), this.vals.get(j)])
    return new MapValue(this.typ, entries)
  }
}

// Tags with, for each element, its position among the elements with the
// same tag, so element i of a union (or dynamic) vector is element rank[i]
// of member tags[i].
interface Ranked {
  tags: Uint32Array
  rank: Uint32Array
}

function rankTags(tags: Uint32Array, nmembers: number, lengths: number[]): Ranked {
  const counts = new Uint32Array(nmembers)
  const rank = new Uint32Array(tags.length)
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i]
    if (t >= nmembers || counts[t] >= lengths[t]) throw new BSUPFormatError("bad union tag")
    rank[i] = counts[t]++
  }
  return { tags, rank }
}

class UnionVec implements Vec {
  readonly length: number
  private typ: Type
  private tagsSeg: Segment
  private members: Vec[]
  private rle: boolean
  constructor(typ: Type, length: number, tagsSeg: Segment, members: Vec[]) {
    this.typ = typ
    this.length = length
    this.tagsSeg = tagsSeg
    this.members = members
    // A union of two members stores its tags as run lengths.
    this.rle = members.length === 2
  }
  private ranked(): Ranked {
    return this.tagsSeg.derived(this, (b) => {
      let tags: Uint32Array
      if (this.rle) tags = runsToTags(b.length === 0 ? new Uint32Array(0) : uncompressUint32(b), this.length)
      else tags = b.length === 0 && this.length === 0 ? new Uint32Array(0) : uncompressUint32(b, this.length)
      const r = rankTags(
        tags,
        this.members.length,
        this.members.map((m) => m.length),
      )
      return [r, tags.byteLength * 2]
    })
  }
  get(i: number): Value {
    checkIndex(i, this.length)
    const { tags, rank } = this.ranked()
    const tag = tags[i]
    return new UnionValue(this.typ, tag, this.members[tag].get(rank[i]))
  }
}

class EnumVec implements Vec {
  readonly length: number
  private typ: Type
  private seg: Segment
  constructor(typ: Type, length: number, seg: Segment) {
    this.typ = typ
    this.length = length
    this.seg = seg
  }
  get(i: number): Value {
    checkIndex(i, this.length)
    const vals = this.seg.derived(this, (b) => {
      const a = uncompressUint64(b, this.length)
      return [a, a.byteLength]
    })
    return new EnumValue(this.typ, Number(vals[i]))
  }
}

class ErrorVec implements Vec {
  readonly length: number
  private typ: Type
  private inner: Vec
  constructor(typ: Type, inner: Vec) {
    this.typ = typ
    this.inner = inner
    this.length = inner.length
  }
  get(i: number): Value {
    return new ErrorValue(this.typ, this.inner.get(i))
  }
}

class FusionVec implements Vec {
  readonly length: number
  private ctx: TypeContext
  private typ: Type
  private inner: Vec
  private all: boolean
  private subtypes: Segment
  private tdefs: () => TypeDefs
  constructor(ctx: TypeContext, typ: Type, inner: Vec, all: boolean, subtypes: Segment, tdefs: () => TypeDefs) {
    this.ctx = ctx
    this.typ = typ
    this.inner = inner
    this.all = all
    this.subtypes = subtypes
    this.tdefs = tdefs
    this.length = inner.length
  }
  get(i: number): Value {
    checkIndex(i, this.length)
    const ids = this.subtypes.uint32s(this, this.length)
    const subtype = this.tdefs().lookup(ids[i])
    let v = this.inner.get(i)
    if (this.all) {
      if (v.kind !== "unimplemented") throw new BSUPFormatError("bad fusion(all) value")
      v = decodeBody(this.ctx, subtype, v.bytes)
    }
    return new FusionValue(this.typ, v, subtype)
  }
}

class OptionVec implements Vec {
  readonly length: number
  private typ: Type
  private tagsSeg: Segment
  private inner: AnyVec
  constructor(typ: Type, length: number, tagsSeg: Segment, inner: AnyVec) {
    this.typ = typ
    this.length = length
    this.tagsSeg = tagsSeg
    this.inner = inner
  }
  get(i: number): Value {
    checkIndex(i, this.length)
    const inner = this.inner
    if (inner instanceof NoneVec) return new OptionValue(this.typ, null)
    if (inner.length === this.length) return new OptionValue(this.typ, inner.get(i))
    // Tags are 0 for a value and 1 for none, and rank[i] is the position of
    // element i's value in the inner vector.
    const { tags, rank } = this.tagsSeg.derived(this, (b) => {
      const tags = uncompressUint32(b, this.length)
      const rank = new Uint32Array(tags.length)
      let j = 0
      for (let k = 0; k < tags.length; k++) {
        rank[k] = j
        if (tags[k] === 0) j++
      }
      if (j !== inner.length) throw new BSUPFormatError("option tags don't match its values")
      return [{ tags, rank }, tags.byteLength * 2]
    })
    return new OptionValue(this.typ, tags[i] === 0 ? inner.get(rank[i]) : null)
  }
}

// The roots of a frame: one vector, or several with tags saying which one
// each value comes from.
class DynamicVec implements Vec {
  readonly length: number
  private tagsSeg: Segment
  private roots: Vec[]
  constructor(tagsSeg: Segment, roots: Vec[]) {
    this.tagsSeg = tagsSeg
    this.roots = roots
    this.length = roots.reduce((n, r) => n + r.length, 0)
  }
  get(i: number): Value {
    checkIndex(i, this.length)
    const { tags, rank } = this.tagsSeg.derived(this, (b) => {
      const r = rankTags(
        uncompressUint32(b, this.length),
        this.roots.length,
        this.roots.map((v) => v.length),
      )
      return [r, r.tags.byteLength * 2]
    })
    return this.roots[tags[i]].get(rank[i])
  }
}

export interface ColumnFrame {
  values: Value[]
  /** The fused type of the frame's values, if the frame has values. */
  fusedType: Type | undefined
}

export interface ColumnFrameOptions {
  /** The cache for decoded segments (default: a new cache for the frame). */
  cache?: SegmentCache
}

/**
 * A column frame whose values are decoded as they're asked for.  The frame
 * keeps a reference to its bytes.
 */
export class LazyColumnFrame {
  /** The number of values in the frame. */
  readonly length: number
  /** The fused type of the frame's values, if the frame has values. */
  readonly fusedType: Type | undefined
  private root: Vec
  private cache: SegmentCache

  constructor(ctx: TypeContext, frame: Uint8Array, opts: ColumnFrameOptions = {}) {
    this.cache = opts.cache ?? new SegmentCache()
    const parser = new LocatorParser(ctx, frame, this.cache)
    this.root = parser.parse()
    this.length = this.root.length
    this.fusedType = this.length > 0 ? parser.fusedType() : undefined
  }

  /** Value i of the frame. */
  get(i: number): Value {
    this.cache.reading(this)
    return this.root.get(i)
  }
}

/** Decodes all of the values of a column frame (the whole frame, starting with its header). */
export function decodeColumnFrame(ctx: TypeContext, frame: Uint8Array): ColumnFrame {
  const lazy = new LazyColumnFrame(ctx, frame)
  const values = new Array<Value>(lazy.length)
  for (let i = 0; i < lazy.length; i++) values[i] = lazy.get(i)
  return { values, fusedType: lazy.fusedType }
}

// LocatorParser reads a frame's locators into a tree of vectors without
// decoding any segments.
class LocatorParser {
  private ctx: TypeContext
  private cache: SegmentCache
  private vdefs: TypeDefs
  private tdefsBytes: Uint8Array
  private tdefsCache: TypeDefs | undefined
  private loc: ByteReader
  private data: Uint8Array
  private dataPos = 0
  private fusedTypeID: number
  private depth = 0

  constructor(ctx: TypeContext, frame: Uint8Array, cache: SegmentCache) {
    if (frame.length < COLUMN_HEADER_SIZE) throw new BSUPFormatError("short column frame")
    this.ctx = ctx
    this.cache = cache
    const frameSize = readSizeLE(frame, 6)
    this.fusedTypeID = readUint32LE(frame, 14)
    const vtSize = readSizeLE(frame, 18)
    const locSize = readSizeLE(frame, 26)
    const tdSize = readSizeLE(frame, 34)
    let off = COLUMN_HEADER_SIZE
    const section = (n: number) => {
      if (off + n > frameSize || off + n > frame.length) throw new BSUPFormatError("column frame section out of range")
      const b = frame.subarray(off, off + n)
      off += n
      return b
    }
    this.vdefs = new TypeDefs(ctx, section(vtSize))
    this.loc = new ByteReader(section(locSize))
    this.tdefsBytes = section(tdSize)
    this.data = frame.subarray(off, frameSize)
  }

  // The type values table, decoded when first needed.
  private tdefs = (): TypeDefs => {
    if (!this.tdefsCache) this.tdefsCache = new TypeDefs(this.ctx, this.tdefsBytes)
    return this.tdefsCache
  }

  fusedType(): Type {
    return this.tdefs().lookup(this.fusedTypeID)
  }

  parse(): Vec {
    const loc = this.loc
    const nroots = loc.uvarint()
    if (nroots === 0 || nroots > loc.remaining) throw new BSUPFormatError("bad number of root vectors")
    const ids: number[] = []
    for (let k = 0; k < nroots; k++) ids.push(loc.uvarint())
    let root: Vec
    if (nroots === 1) {
      root = this.values(this.vector(ids[0], IN_VECTOR))
    } else {
      const tags = this.segment()
      root = new DynamicVec(
        tags,
        ids.map((id) => this.values(this.vector(id, IN_VECTOR))),
      )
    }
    if (!loc.done()) throw new BSUPFormatError("extra bytes in locators section")
    if (this.dataPos !== this.data.length) throw new BSUPFormatError("segments don't fill the data section")
    return root
  }

  private values(v: AnyVec): Vec {
    if (v instanceof NoneVec) throw new BSUPFormatError("none vector outside of an option")
    return v
  }

  // Reads a segment's locator and returns the segment, undecoded.
  private segment(): Segment {
    const loc = this.loc
    const format = loc.byte()
    const memLen = loc.uvarint()
    let fileLen = memLen
    if (format !== 0) {
      if (format !== 1) throw new BSUPFormatError(`unknown compression format ${format}`)
      fileLen = loc.uvarint()
    }
    if (this.dataPos + fileLen > this.data.length) throw new BSUPFormatError("segment past end of data section")
    const b = this.data.subarray(this.dataPos, this.dataPos + fileLen)
    this.dataPos += fileLen
    return new Segment(b, format, memLen, this.cache)
  }

  private count(): number {
    const n = this.loc.uvarint()
    if (n > 0xffffffff) throw new BSUPFormatError("vector too long")
    return n
  }

  private vector(id: number, mode: number, outer?: Type): AnyVec {
    if (++this.depth > MAX_DEPTH) throw new BSUPFormatError("vectors nested too deeply")
    try {
      const kind = this.loc.byte()
      if ((kind === KIND_NONE && mode !== IN_OPTION) || (kind !== KIND_PLAIN && mode === IN_DICT)) {
        throw new BSUPFormatError(`vector kind ${kind} not allowed here`)
      }
      switch (kind) {
        case KIND_CONST:
          return this.constVector(id, outer)
        case KIND_NONE:
          return new NoneVec(this.count())
        case KIND_DICT:
          return this.dictVector(id, outer)
        case KIND_PLAIN:
          return id < ID_COMPLEX ? this.primitive(id, outer) : this.complex(id, outer)
        default:
          throw new BSUPFormatError(`unknown vector kind ${kind}`)
      }
    } finally {
      this.depth--
    }
  }

  private typeOf(id: number, outer?: Type): Type {
    return outer ?? this.vdefs.lookup(id)
  }

  private constVector(id: number, outer?: Type): Vec {
    const n = this.count()
    const len = this.loc.uvarint()
    const body = len === 0 ? new Uint8Array(0) : this.loc.bytes(len - 1)
    const typ = this.typeOf(id, outer)
    // super writes a const of no values with no value for an empty vector
    // (e.g., a named type that head, tail, or a filter left with no values),
    // so there's nothing to decode. A const of no values never returns its value.
    if (n === 0) return new ConstVec(0, new NullValue(typ))
    return new ConstVec(n, decodeBody(this.ctx, typ, body))
  }

  private dictVector(id: number, outer?: Type): Vec {
    if (id >= ID_COMPLEX) throw new BSUPFormatError(`dict vector of complex type ${id}`)
    const distinct = this.values(this.vector(id, IN_DICT, outer))
    this.segment() // The counts of each distinct value aren't needed here.
    return new DictVec(distinct, this.segment())
  }

  private primitive(id: number, outer?: Type): Vec {
    const typ = outer ?? primitiveType(id)
    const n = this.count()
    const segs: Segment[] = []
    switch (id) {
      case ID.bytes:
      case ID.string:
      case ID.uuid:
      case ID.all:
      case ID.ip:
      case ID.net:
        segs.push(this.segment(), this.segment())
        break
      case ID.null:
      case ID.missing:
      case ID.none:
        break
      case ID.uint8:
      case ID.uint16:
      case ID.uint32:
      case ID.uint64:
      case ID.int8:
      case ID.int16:
      case ID.int32:
      case ID.int64:
      case ID.duration:
      case ID.timestamp:
      case ID.float16:
      case ID.float32:
      case ID.float64:
      case ID.bool:
      case ID.type:
        segs.push(this.segment())
        break
      default:
        throw new BSUPFormatError(`type ${primitiveType(id).name} has no vector encoding`)
    }
    return new PrimVec(this.ctx, typ, id, n, segs, this.tdefs)
  }

  private complex(id: number, outer?: Type): Vec {
    const typ = this.typeOf(id, outer)
    const [code, td] = this.vdefs.typedef(id)
    const child = () => {
      const c = td.uvarint()
      if (c >= id) throw new BSUPFormatError(`typedef ${id} refers to type ${c}`)
      return c
    }
    switch (code) {
      case TypeDefCode.record: {
        const nfields = td.uvarint()
        if (nfields === 0) return new RecordVec(typ, [], this.count())
        const fields: Vec[] = []
        for (let k = 0; k < nfields; k++) {
          td.string()
          const f = this.values(this.vector(child(), IN_VECTOR))
          if (k > 0 && f.length !== fields[0].length) throw new BSUPFormatError("record fields of different lengths")
          fields.push(f)
        }
        return new RecordVec(typ, fields, fields[0].length)
      }
      case TypeDefCode.array:
      case TypeDefCode.set: {
        const inner = child()
        const n = this.count()
        const offsets = this.segment()
        const elems = this.values(this.vector(inner, IN_VECTOR))
        return new ListVec(typ, code === TypeDefCode.set, n, offsets, elems)
      }
      case TypeDefCode.map: {
        const keyID = child()
        const valID = child()
        const n = this.count()
        const offsets = this.segment()
        const keys = this.values(this.vector(keyID, IN_VECTOR))
        const vals = this.values(this.vector(valID, IN_VECTOR))
        if (keys.length !== vals.length) throw new BSUPFormatError("bad map vector")
        return new MapVec(typ, n, offsets, keys, vals)
      }
      case TypeDefCode.union: {
        const nmembers = td.uvarint()
        const memberIDs: number[] = []
        for (let k = 0; k < nmembers; k++) memberIDs.push(child())
        const n = this.count()
        const tags = this.segment()
        const members = memberIDs.map((mid) => this.values(this.vector(mid, IN_VECTOR)))
        return new UnionVec(typ, n, tags, members)
      }
      case TypeDefCode.enum: {
        const nsyms = td.uvarint()
        for (let k = 0; k < nsyms; k++) td.string()
        const n = this.count()
        return new EnumVec(typ, n, this.segment())
      }
      case TypeDefCode.error:
        return new ErrorVec(typ, this.values(this.vector(child(), IN_VECTOR)))
      case TypeDefCode.named: {
        td.string()
        const inner = td.uint32BE()
        return this.values(this.vector(inner, IN_VECTOR, typ))
      }
      case TypeDefCode.fusion: {
        const inner = child()
        const vals = this.values(this.vector(inner, IN_VECTOR))
        return new FusionVec(this.ctx, typ, vals, inner === ID.all, this.segment(), this.tdefs)
      }
      case TypeDefCode.option: {
        const inner = child()
        const n = this.count()
        const tags = this.segment()
        const vals = this.vector(inner, IN_OPTION)
        if (!(vals instanceof NoneVec) && vals.length > n) throw new BSUPFormatError("option has too many values")
        return new OptionVec(typ, n, tags, vals)
      }
      case TypeDefCode.decimal:
        throw new BSUPFormatError("decimal vectors have no plain encoding")
      default:
        throw new BSUPFormatError(`unknown typedef code ${code}`)
    }
  }
}

// netFromPrefix converts a net value in a column frame to the body encoding
// (address followed by mask).  The Go implementation (as of BSUP 2.0) writes
// net vectors with netip.Prefix.AppendBinary, i.e., the address followed by
// a 1-byte prefix length, rather than the body encoding given by the spec.
function netFromPrefix(b: Uint8Array): Uint8Array {
  if (b.length !== 5 && b.length !== 17) return b
  const n = b.length - 1
  const bits = b[n]
  if (bits > n * 8) throw new BSUPFormatError(`bad net prefix length ${bits}`)
  const out = new Uint8Array(2 * n)
  out.set(b.subarray(0, n))
  for (let k = 0; k < n; k++) {
    const ones = Math.min(8, Math.max(0, bits - 8 * k))
    out[n + k] = (0xff << (8 - ones)) & 0xff
  }
  return out
}

// runsToTags expands the run lengths of a two-member union's tags, which
// alternate between runs of tag 1 and tag 0 starting with tag 1.  No runs
// means every tag is 0.
function runsToTags(runs: Uint32Array, n: number): Uint32Array {
  const tags = new Uint32Array(n)
  let off = 0
  for (let k = 0; k < runs.length; k += 2) {
    const ones = runs[k]
    if (off + ones > n) throw new BSUPFormatError("union runs out of range")
    tags.fill(1, off, off + ones)
    off += ones
    if (k + 1 < runs.length) off += runs[k + 1]
  }
  return tags
}
