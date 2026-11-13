// Typedefs tables and type values.

import { type Type, type TypeContext, type TypeNamed, ID_COMPLEX, primitiveType } from "../types.ts"
import { BSUPFormatError, ByteReader } from "./reader.ts"

// Typedef codes in a typedefs table.
export const TypeDefCode = {
  record: 0,
  array: 1,
  set: 2,
  map: 3,
  union: 4,
  enum: 5,
  error: 6,
  named: 7,
  fusion: 8,
  option: 9,
  decimal: 10,
} as const

// Codes of complex types in a type value.
export const TypeValueCode = {
  record: 48,
  array: 49,
  set: 50,
  map: 51,
  union: 52,
  enum: 53,
  error: 54,
  nameDef: 55,
  nameRef: 56,
  fusion: 57,
  option: 58,
  decimal: 59,
} as const

/**
 * A typedefs table of a frame, which maps the frame's type IDs to types.
 * Typedefs are decoded on demand.
 */
export class TypeDefs {
  private ctx: TypeContext
  private bytes: Uint8Array
  private offsets: number[]
  private types: (Type | undefined)[]

  constructor(ctx: TypeContext, bytes: Uint8Array) {
    this.ctx = ctx
    this.bytes = new Uint8Array(0)
    this.offsets = [0]
    this.types = []
    if (bytes.length === 0) return
    const r = new ByteReader(bytes)
    const n = r.uvarint()
    if (n > bytes.length) throw new BSUPFormatError("bad typedefs count")
    const offsets: number[] = []
    for (let k = 0; k < n; k++) {
      const off = r.uvarint()
      if ((k === 0 && off !== 0) || (k > 0 && off <= offsets[k - 1])) {
        throw new BSUPFormatError("bad typedef offset")
      }
      offsets.push(off)
    }
    this.bytes = bytes.subarray(r.pos)
    if (n > 0 && this.bytes.length <= offsets[n - 1]) throw new BSUPFormatError("typedefs section too short")
    offsets.push(this.bytes.length)
    this.offsets = offsets
    this.types = new Array(n)
  }

  get length(): number {
    return this.offsets.length - 1
  }

  /** The type with the given ID (primitive or defined in this table). */
  lookup(id: number): Type {
    if (id < ID_COMPLEX) return primitiveType(id)
    const slot = id - ID_COMPLEX
    if (slot >= this.length) throw new BSUPFormatError(`type ID ${id} not in typedefs table`)
    const t = this.types[slot]
    if (t) return t
    return this.decode(id)
  }

  /** The raw typedef of a complex type ID: its code and a reader of the rest. */
  typedef(id: number): [number, ByteReader] {
    const slot = id - ID_COMPLEX
    if (slot < 0 || slot >= this.length) throw new BSUPFormatError(`type ID ${id} not in typedefs table`)
    const r = new ByteReader(this.bytes, this.offsets[slot], this.offsets[slot + 1])
    return [r.byte(), r]
  }

  private child(r: ByteReader, id: number): Type {
    const child = r.uvarint()
    if (child >= id) throw new BSUPFormatError(`typedef ${id} refers to type ${child}`)
    return this.lookup(child)
  }

  private decode(id: number): Type {
    const slot = id - ID_COMPLEX
    const [code, r] = this.typedef(id)
    const ctx = this.ctx
    let t: Type
    switch (code) {
      case TypeDefCode.record: {
        const n = r.uvarint()
        const fields = []
        for (let k = 0; k < n; k++) {
          const name = r.string()
          fields.push({ name, type: this.child(r, id) })
        }
        t = ctx.record(fields)
        break
      }
      case TypeDefCode.array:
        t = ctx.array(this.child(r, id))
        break
      case TypeDefCode.set:
        t = ctx.set(this.child(r, id))
        break
      case TypeDefCode.map: {
        const k = this.child(r, id)
        t = ctx.map(k, this.child(r, id))
        break
      }
      case TypeDefCode.union: {
        const n = r.uvarint()
        const types = []
        for (let k = 0; k < n; k++) types.push(this.child(r, id))
        t = ctx.union(types)
        break
      }
      case TypeDefCode.enum: {
        const n = r.uvarint()
        const symbols = []
        for (let k = 0; k < n; k++) symbols.push(r.string())
        t = ctx.enum(symbols)
        break
      }
      case TypeDefCode.error:
        t = ctx.error(this.child(r, id))
        break
      case TypeDefCode.named: {
        const name = r.string()
        const inner = r.uint32BE()
        const placeholder = ctx.namedPlaceholder(name)
        // Memoize the placeholder first so a recursive reference resolves.
        this.types[slot] = placeholder
        let underlying: Type
        try {
          underlying = this.lookup(inner)
        } catch (e) {
          this.types[slot] = undefined
          throw e
        }
        if (underlying === placeholder) throw new BSUPFormatError(`named type ${name} refers to itself`)
        t = ctx.bindNamed(placeholder, underlying)
        break
      }
      case TypeDefCode.fusion:
        t = ctx.fusion(this.child(r, id))
        break
      case TypeDefCode.option:
        t = ctx.option(this.child(r, id))
        break
      case TypeDefCode.decimal: {
        const p = r.uvarint()
        t = ctx.decimal(p, r.uvarint())
        break
      }
      default:
        throw new BSUPFormatError(`unknown typedef code ${code}`)
    }
    this.types[slot] = t
    return t
  }
}

/** Decodes the body of a type value. */
export function decodeTypeValue(ctx: TypeContext, bytes: Uint8Array): Type {
  const r = new ByteReader(bytes)
  const t = new TypeValueDecoder(ctx, r).decode()
  if (!r.done()) throw new BSUPFormatError("extra bytes after type value")
  return t
}

/** Decodes a type value from r, advancing r past it. */
export function readTypeValue(ctx: TypeContext, r: ByteReader): Type {
  return new TypeValueDecoder(ctx, r).decode()
}

class TypeValueDecoder {
  private ctx: TypeContext
  private r: ByteReader
  private names = new Map<string, TypeNamed>()
  private depth = 0

  constructor(ctx: TypeContext, r: ByteReader) {
    this.ctx = ctx
    this.r = r
  }

  decode(): Type {
    if (++this.depth > 10_000) throw new BSUPFormatError("type value nested too deeply")
    try {
      return this.decodeType()
    } finally {
      this.depth--
    }
  }

  private decodeType(): Type {
    const { ctx, r } = this
    const code = r.byte()
    if (code < ID_COMPLEX) return primitiveType(code)
    switch (code) {
      case TypeValueCode.record: {
        const n = r.uvarint()
        const fields = []
        for (let k = 0; k < n; k++) {
          const name = r.string()
          fields.push({ name, type: this.decode() })
        }
        return ctx.record(fields)
      }
      case TypeValueCode.array:
        return ctx.array(this.decode())
      case TypeValueCode.set:
        return ctx.set(this.decode())
      case TypeValueCode.map: {
        const k = this.decode()
        return ctx.map(k, this.decode())
      }
      case TypeValueCode.union: {
        const n = r.uvarint()
        const types = []
        for (let k = 0; k < n; k++) types.push(this.decode())
        return ctx.union(types)
      }
      case TypeValueCode.enum: {
        const n = r.uvarint()
        const symbols = []
        for (let k = 0; k < n; k++) symbols.push(r.string())
        return ctx.enum(symbols)
      }
      case TypeValueCode.error:
        return ctx.error(this.decode())
      case TypeValueCode.nameDef: {
        const name = r.string()
        const placeholder = ctx.namedPlaceholder(name)
        this.names.set(name, placeholder)
        const underlying = this.decode()
        if (underlying === placeholder) throw new BSUPFormatError(`named type ${name} refers to itself`)
        const named = ctx.bindNamed(placeholder, underlying)
        this.names.set(name, named)
        return named
      }
      case TypeValueCode.nameRef: {
        const name = r.string()
        const named = this.names.get(name)
        if (!named) throw new BSUPFormatError(`type value refers to undefined name ${name}`)
        return named
      }
      case TypeValueCode.fusion:
        return ctx.fusion(this.decode())
      case TypeValueCode.option:
        return ctx.option(this.decode())
      case TypeValueCode.decimal: {
        const p = r.uvarint()
        return ctx.decimal(p, r.uvarint())
      }
      default:
        throw new BSUPFormatError(`unknown type value code ${code}`)
    }
  }
}
