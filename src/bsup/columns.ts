// Decoding of BSUP column frames into values.
//
// A column frame holds vectors described by a locators section that refers
// to segments of the frame's data section.  This decoder materializes every
// value of the frame, which is what a viewer of query results wants.  (A
// future version could decode projections of a frame lazily.)

import { type Type, type TypeContext, ID, ID_COMPLEX, primitiveType } from "../types.ts"
import {
  type Value,
  ArrayValue,
  BoolValue,
  EnumValue,
  ErrorValue,
  FloatValue,
  FusionValue,
  IntValue,
  DurationValue,
  TimestampValue,
  MapValue,
  OptionValue,
  RecordValue,
  SetValue,
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

const MAX_DEPTH = 10_000

// The values of an option vector whose values are all none.
class NoneVector {
  readonly length: number
  constructor(length: number) {
    this.length = length
  }
}

type Vec = Value[] | NoneVector

const IN_VECTOR = 0
const IN_OPTION = 1
const IN_DICT = 2

export interface ColumnFrame {
  values: Value[]
  /** The fused type of the frame's values, if the frame has values. */
  fusedType: Type | undefined
}

/** Decodes a column frame (the whole frame, starting with its header). */
export function decodeColumnFrame(ctx: TypeContext, frame: Uint8Array): ColumnFrame {
  return new ColumnDecoder(ctx, frame).decode()
}

class ColumnDecoder {
  private ctx: TypeContext
  private vdefs: TypeDefs
  private tdefsBytes: Uint8Array
  private tdefsCache: TypeDefs | undefined
  private loc: ByteReader
  private data: Uint8Array
  private dataPos = 0
  private fusedTypeID: number
  private depth = 0

  constructor(ctx: TypeContext, frame: Uint8Array) {
    if (frame.length < COLUMN_HEADER_SIZE) throw new BSUPFormatError("short column frame")
    this.ctx = ctx
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

  private get tdefs(): TypeDefs {
    if (!this.tdefsCache) this.tdefsCache = new TypeDefs(this.ctx, this.tdefsBytes)
    return this.tdefsCache
  }

  decode(): ColumnFrame {
    const loc = this.loc
    const nroots = loc.uvarint()
    if (nroots === 0 || nroots > loc.remaining) throw new BSUPFormatError("bad number of root vectors")
    const ids: number[] = []
    for (let k = 0; k < nroots; k++) ids.push(loc.uvarint())
    let values: Value[]
    if (nroots === 1) {
      values = this.values(this.vector(ids[0], IN_VECTOR))
    } else {
      const tagsSeg = this.segment()
      const roots = ids.map((id) => this.values(this.vector(id, IN_VECTOR)))
      const total = roots.reduce((n, r) => n + r.length, 0)
      const tags = uncompressUint32(tagsSeg, total)
      const cursors = new Array<number>(roots.length).fill(0)
      values = new Array<Value>(total)
      for (let k = 0; k < total; k++) {
        const tag = tags[k]
        const root = roots[tag]
        if (!root || cursors[tag] >= root.length) throw new BSUPFormatError("bad dynamic tag")
        values[k] = root[cursors[tag]++]
      }
    }
    if (!loc.done()) throw new BSUPFormatError("extra bytes in locators section")
    if (this.dataPos !== this.data.length) throw new BSUPFormatError("segments don't fill the data section")
    const fusedType = values.length > 0 ? this.tdefs.lookup(this.fusedTypeID) : undefined
    return { values, fusedType }
  }

  private values(v: Vec): Value[] {
    if (v instanceof NoneVector) throw new BSUPFormatError("none vector outside of an option")
    return v
  }

  // Reads a segment from the locators and returns its uncompressed data.
  private segment(): Uint8Array {
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
    return format === 0 ? b : lz4Uncompress(b, memLen)
  }

  private count(): number {
    const n = this.loc.uvarint()
    if (n > 0xffffffff) throw new BSUPFormatError("vector too long")
    return n
  }

  private uint32s(count: number): Uint32Array {
    return uncompressUint32(this.segment(), count)
  }

  // offsets reads a segment of count+1 offsets (empty when count is 0).
  private offsets(count: number): Uint32Array {
    const seg = this.segment()
    if (count === 0 && seg.length === 0) return new Uint32Array([0])
    const offs = uncompressUint32(seg, count + 1)
    for (let k = 0; k < count; k++) {
      if (offs[k] > offs[k + 1]) throw new BSUPFormatError("offsets out of order")
    }
    return offs
  }

  private vector(id: number, mode: number, outer?: Type): Vec {
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
          return new NoneVector(this.count())
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

  private constVector(id: number, outer?: Type): Value[] {
    const n = this.count()
    const len = this.loc.uvarint()
    const body = len === 0 ? new Uint8Array(0) : this.loc.bytes(len - 1)
    if (n === 0) return []
    const v = decodeBody(this.ctx, this.typeOf(id, outer), body)
    return new Array<Value>(n).fill(v)
  }

  private dictVector(id: number, outer?: Type): Value[] {
    if (id >= ID_COMPLEX) throw new BSUPFormatError(`dict vector of complex type ${id}`)
    const distinct = this.values(this.vector(id, IN_DICT, outer))
    this.segment() // The counts of each distinct value aren't needed here.
    const index = this.segment()
    const out = new Array<Value>(index.length)
    for (let k = 0; k < index.length; k++) {
      const v = distinct[index[k]]
      if (!v) throw new BSUPFormatError("dict index out of range")
      out[k] = v
    }
    return out
  }

  private primitive(id: number, outer?: Type): Value[] {
    const typ = outer ?? primitiveType(id)
    const n = this.count()
    switch (id) {
      case ID.uint8:
      case ID.uint16:
      case ID.uint32:
      case ID.uint64: {
        const vals = uncompressUint64(this.segment(), n)
        return Array.from(vals, (v) => new UintValue(typ, compactInt(v)))
      }
      case ID.int8:
      case ID.int16:
      case ID.int32:
      case ID.int64: {
        const vals = uncompressInt64(this.segment(), n)
        return Array.from(vals, (v) => new IntValue(typ, compactInt(v)))
      }
      case ID.duration:
        return Array.from(uncompressInt64(this.segment(), n), (v) => new DurationValue(typ, v))
      case ID.timestamp:
        return Array.from(uncompressInt64(this.segment(), n), (v) => new TimestampValue(typ, v))
      case ID.float16:
      case ID.float32:
      case ID.float64: {
        const seg = this.segment()
        if (seg.length < n * 8) throw new BSUPFormatError("float segment too short")
        const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength)
        const out = new Array<Value>(n)
        for (let k = 0; k < n; k++) out[k] = new FloatValue(typ, dv.getFloat64(k * 8, true))
        return out
      }
      case ID.bool: {
        const seg = this.segment()
        if (seg.length * 8 < n) throw new BSUPFormatError("bool segment too short")
        const out = new Array<Value>(n)
        for (let k = 0; k < n; k++) out[k] = new BoolValue(typ, ((seg[k >>> 3] >>> (k & 7)) & 1) === 1)
        return out
      }
      case ID.type: {
        const ids = this.uint32s(n)
        return Array.from(ids, (tid) => new TypeValue(typ, this.tdefs.lookup(tid)))
      }
      case ID.bytes:
      case ID.string:
      case ID.uuid:
      case ID.all:
      case ID.ip:
      case ID.net: {
        const bytes = this.segment()
        const offs = this.offsets(n)
        if (offs[n] > bytes.length) throw new BSUPFormatError("bytes table offsets out of range")
        const out = new Array<Value>(n)
        for (let k = 0; k < n; k++) {
          let b = bytes.subarray(offs[k], offs[k + 1])
          if (id === ID.net) b = netFromPrefix(b)
          out[k] = id === ID.all ? new UnimplementedValue(typ, b) : decodePrimitive(this.ctx, typ, id, b)
        }
        return out
      }
      case ID.null:
      case ID.missing:
      case ID.none: {
        if (n === 0) return []
        return new Array<Value>(n).fill(decodePrimitive(this.ctx, typ, id, new Uint8Array(0)))
      }
      default:
        throw new BSUPFormatError(`type ${primitiveType(id).name} has no vector encoding`)
    }
  }

  private complex(id: number, outer?: Type): Value[] {
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
        if (nfields === 0) {
          const n = this.count()
          return Array.from({ length: n }, () => new RecordValue(typ, []))
        }
        const columns: Value[][] = []
        for (let k = 0; k < nfields; k++) {
          td.string()
          const col = this.values(this.vector(child(), IN_VECTOR))
          if (k > 0 && col.length !== columns[0].length) throw new BSUPFormatError("record fields of different lengths")
          columns.push(col)
        }
        const n = columns[0].length
        const out = new Array<Value>(n)
        for (let i = 0; i < n; i++) {
          const vals = new Array<Value>(nfields)
          for (let k = 0; k < nfields; k++) vals[k] = columns[k][i]
          out[i] = new RecordValue(typ, vals)
        }
        return out
      }
      case TypeDefCode.array:
      case TypeDefCode.set: {
        const inner = child()
        const n = this.count()
        const offs = this.offsets(n)
        const elems = this.values(this.vector(inner, IN_VECTOR))
        if (offs[n] > elems.length) throw new BSUPFormatError("array offsets out of range")
        const out = new Array<Value>(n)
        for (let k = 0; k < n; k++) {
          const items = elems.slice(offs[k], offs[k + 1])
          out[k] = code === TypeDefCode.array ? new ArrayValue(typ, items) : new SetValue(typ, items)
        }
        return out
      }
      case TypeDefCode.map: {
        const keyID = child()
        const valID = child()
        const n = this.count()
        const offs = this.offsets(n)
        const keys = this.values(this.vector(keyID, IN_VECTOR))
        const vals = this.values(this.vector(valID, IN_VECTOR))
        if (keys.length !== vals.length || offs[n] > keys.length) throw new BSUPFormatError("bad map vector")
        const out = new Array<Value>(n)
        for (let k = 0; k < n; k++) {
          const entries: [Value, Value][] = []
          for (let j = offs[k]; j < offs[k + 1]; j++) entries.push([keys[j], vals[j]])
          out[k] = new MapValue(typ, entries)
        }
        return out
      }
      case TypeDefCode.union: {
        const nmembers = td.uvarint()
        const memberIDs: number[] = []
        for (let k = 0; k < nmembers; k++) memberIDs.push(child())
        const n = this.count()
        const tagsSeg = this.segment()
        const members = memberIDs.map((mid) => this.values(this.vector(mid, IN_VECTOR)))
        let tags: Uint32Array
        if (nmembers === 2) {
          tags = runsToTags(uncompressUint32(tagsSeg), n)
        } else {
          tags = n === 0 && tagsSeg.length === 0 ? new Uint32Array(0) : uncompressUint32(tagsSeg, n)
        }
        const cursors = new Array<number>(nmembers).fill(0)
        const out = new Array<Value>(n)
        for (let k = 0; k < n; k++) {
          const tag = tags[k]
          const m = members[tag]
          if (!m || cursors[tag] >= m.length) throw new BSUPFormatError("bad union tag")
          out[k] = new UnionValue(typ, tag, m[cursors[tag]++])
        }
        return out
      }
      case TypeDefCode.enum: {
        const nsyms = td.uvarint()
        for (let k = 0; k < nsyms; k++) td.string()
        const n = this.count()
        const vals = uncompressUint64(this.segment(), n)
        return Array.from(vals, (v) => new EnumValue(typ, Number(v)))
      }
      case TypeDefCode.error: {
        const vals = this.values(this.vector(child(), IN_VECTOR))
        return vals.map((v) => new ErrorValue(typ, v))
      }
      case TypeDefCode.named: {
        td.string()
        const inner = td.uint32BE()
        return this.values(this.vector(inner, IN_VECTOR, typ))
      }
      case TypeDefCode.fusion: {
        const inner = child()
        const vals = this.values(this.vector(inner, IN_VECTOR))
        const subtypes = this.uint32s(vals.length)
        return vals.map((v, k) => {
          const subtype = this.tdefs.lookup(subtypes[k])
          if (inner === ID.all) {
            if (v.kind !== "unimplemented") throw new BSUPFormatError("bad fusion(all) value")
            v = decodeBody(this.ctx, subtype, v.bytes)
          }
          return new FusionValue(typ, v, subtype)
        })
      }
      case TypeDefCode.option: {
        const inner = child()
        const n = this.count()
        const tagsSeg = this.segment()
        const vals = this.vector(inner, IN_OPTION)
        if (vals instanceof NoneVector) {
          return Array.from({ length: n }, () => new OptionValue(typ, null))
        }
        if (vals.length === n) return vals.map((v) => new OptionValue(typ, v))
        const tags = uncompressUint32(tagsSeg, n)
        const out = new Array<Value>(n)
        let j = 0
        for (let k = 0; k < n; k++) {
          if (tags[k] === 0) {
            if (j >= vals.length) throw new BSUPFormatError("option tags out of range")
            out[k] = new OptionValue(typ, vals[j++])
          } else {
            out[k] = new OptionValue(typ, null)
          }
        }
        return out
      }
      case TypeDefCode.decimal:
        throw new BSUPFormatError("decimal vectors have no plain encoding")
      default:
        throw new BSUPFormatError(`unknown typedef code ${code}`)
    }
  }
}

// netFromPrefix converts a net value in a column frame to the body encoding
// (address followed by mask).  The Go implementation (as of BSUP 0.31) writes
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
