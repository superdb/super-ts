// Decoding of value bodies (the row encoding of values).

import { type Type, type TypeContext, ID, TypeAll, under } from "../types.ts"
import {
  type Value,
  ArrayValue,
  BoolValue,
  BytesValue,
  DurationValue,
  EnumValue,
  ErrorValue,
  FloatValue,
  FusionValue,
  IntValue,
  IPValue,
  MapValue,
  MissingValue,
  NetValue,
  NoneValue,
  NullValue,
  OptionValue,
  RecordValue,
  SetValue,
  StringValue,
  TimestampValue,
  TypeValue,
  UintValue,
  UnimplementedValue,
  UnionValue,
  UUIDValue,
  compactInt,
} from "../values.ts"
import { BSUPFormatError, ByteReader, decodeInt, decodeUint, decodeUintNumber, decodeUTF8 } from "./reader.ts"
import { decodeTypeValue } from "./typedefs.ts"

/** Converts IEEE 754 binary16 bits to a number. */
export function float16ToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exp = (bits >>> 10) & 0x1f
  const frac = bits & 0x3ff
  if (exp === 0) return sign * frac * 2 ** -24
  if (exp === 0x1f) return frac ? NaN : sign * Infinity
  return sign * (1 + frac / 1024) * 2 ** (exp - 15)
}

function decodeFloat(b: Uint8Array): number {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  switch (b.length) {
    case 2:
      return float16ToNumber(dv.getUint16(0, true))
    case 4:
      return dv.getFloat32(0, true)
    case 8:
      return dv.getFloat64(0, true)
  }
  throw new BSUPFormatError(`float body of length ${b.length}`)
}

/** Creates a primitive value of type typ (whose underlying ID is id) from its body. */
export function decodePrimitive(ctx: TypeContext, typ: Type, id: number, b: Uint8Array): Value {
  switch (id) {
    case ID.uint8:
    case ID.uint16:
    case ID.uint32:
    case ID.uint64:
      if (b.length > 8) throw new BSUPFormatError("integer body too long")
      return new UintValue(typ, b.length <= 6 ? decodeUintNumber(b) : compactInt(decodeUint(b)))
    case ID.int8:
    case ID.int16:
    case ID.int32:
    case ID.int64:
      if (b.length > 8) throw new BSUPFormatError("integer body too long")
      return new IntValue(typ, compactInt(decodeInt(b)))
    case ID.duration:
      return new DurationValue(typ, decodeInt(b))
    case ID.timestamp:
      return new TimestampValue(typ, decodeInt(b))
    case ID.float16:
    case ID.float32:
    case ID.float64:
      return new FloatValue(typ, decodeFloat(b))
    case ID.bool:
      return new BoolValue(typ, b.length > 0 && b[0] !== 0)
    case ID.bytes:
      return new BytesValue(typ, b.slice())
    case ID.string:
      return new StringValue(typ, decodeUTF8(b))
    case ID.ip:
      return new IPValue(typ, b.slice())
    case ID.net:
      return new NetValue(typ, b.slice())
    case ID.uuid:
      return new UUIDValue(typ, b.slice())
    case ID.type:
      return new TypeValue(typ, decodeTypeValue(ctx, b))
    case ID.null:
      return new NullValue(typ)
    case ID.missing:
      return new MissingValue(typ)
    case ID.none:
      return new NoneValue(typ)
    case ID.any:
      throw new BSUPFormatError("no value has type any")
    default:
      // Reserved types and stray values of type all.
      return new UnimplementedValue(typ, b.slice())
  }
}

/** Decodes the body of a value of type typ. */
export function decodeBody(ctx: TypeContext, typ: Type, b: Uint8Array): Value {
  const t = under(typ)
  switch (t.kind) {
    case "primitive":
      return decodePrimitive(ctx, typ, t.id, b)
    case "record": {
      const r = new ByteReader(b)
      const values = t.fields.map((f) => decodeBody(ctx, f.type, r.value()))
      if (!r.done()) throw new BSUPFormatError("extra bytes in record value")
      return new RecordValue(typ, values)
    }
    case "array":
    case "set": {
      const r = new ByteReader(b)
      const items: Value[] = []
      while (!r.done()) items.push(decodeBody(ctx, t.type, r.value()))
      return t.kind === "array" ? new ArrayValue(typ, items) : new SetValue(typ, items)
    }
    case "map": {
      const r = new ByteReader(b)
      const entries: [Value, Value][] = []
      while (!r.done()) {
        const k = decodeBody(ctx, t.keyType, r.value())
        entries.push([k, decodeBody(ctx, t.valType, r.value())])
      }
      return new MapValue(typ, entries)
    }
    case "union": {
      const r = new ByteReader(b)
      const tag = decodeUintNumber(r.value())
      const member = t.types[tag]
      if (!member) throw new BSUPFormatError(`union tag ${tag} out of range`)
      return new UnionValue(typ, tag, decodeBody(ctx, member, r.value()))
    }
    case "enum":
      return new EnumValue(typ, decodeUintNumber(b))
    case "error":
      return new ErrorValue(typ, decodeBody(ctx, t.type, b))
    case "option": {
      const r = new ByteReader(b)
      const tag = decodeUintNumber(r.value())
      if (tag === 0) return new OptionValue(typ, decodeBody(ctx, t.type, r.value()))
      if (tag === 1) return new OptionValue(typ, null)
      throw new BSUPFormatError(`bad option tag ${tag}`)
    }
    case "fusion": {
      const r = new ByteReader(b)
      const body = r.value()
      const subtype = decodeTypeValue(ctx, r.value())
      const value = decodeBody(ctx, t.type === TypeAll ? subtype : t.type, body)
      return new FusionValue(typ, value, subtype)
    }
    case "decimal":
      return new UnimplementedValue(typ, b.slice())
  }
}
