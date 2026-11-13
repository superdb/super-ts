// Super-structured types.
//
// Types are immutable and, when created through a TypeContext, interned so
// that two structurally identical types from the same context are the same
// JavaScript object.  This makes `===` a cheap and correct type equality
// test, which is what a table view needs to group values by shape.

// Primitive type IDs as defined by the BSUP spec.
export const ID = {
  uint8: 0,
  uint16: 1,
  uint32: 2,
  uint64: 3,
  uint128: 4,
  int8: 5,
  int16: 6,
  int32: 7,
  int64: 8,
  int128: 9,
  duration: 10,
  timestamp0: 11,
  timestamp3: 12,
  timestamp6: 13,
  timestamp: 14,
  timestampNTZ0: 15,
  timestampNTZ3: 16,
  timestampNTZ6: 17,
  timestampNTZ: 18,
  date: 19,
  time0: 20,
  time3: 21,
  time6: 22,
  time: 23,
  float16: 24,
  float32: 25,
  float64: 26,
  bool: 27,
  bytes: 28,
  string: 29,
  ip: 30,
  net: 31,
  interval: 32,
  uuid: 33,
  geometry: 34,
  geography: 35,
  type: 36,
  null: 37,
  missing: 38,
  none: 39,
  all: 40,
  any: 41,
} as const

/** The first type ID of a complex type in a typedefs table. */
export const ID_COMPLEX = 48

const primitiveNames: string[] = [
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uint128",
  "int8",
  "int16",
  "int32",
  "int64",
  "int128",
  "duration",
  "timestamp(0)",
  "timestamp(3)",
  "timestamp(6)",
  "timestamp",
  "timestamp_ntz(0)",
  "timestamp_ntz(3)",
  "timestamp_ntz(6)",
  "timestamp_ntz",
  "date",
  "time(0)",
  "time(3)",
  "time(6)",
  "time",
  "float16",
  "float32",
  "float64",
  "bool",
  "bytes",
  "string",
  "ip",
  "net",
  "interval",
  "uuid",
  "geometry",
  "geography",
  "type",
  "null",
  "missing",
  "none",
  "all",
  "any",
]

// Primitive types whose values are reserved but not yet defined.
const unimplementedIDs = new Set<number>([
  ID.uint128,
  ID.int128,
  ID.timestamp0,
  ID.timestamp3,
  ID.timestamp6,
  ID.timestampNTZ0,
  ID.timestampNTZ3,
  ID.timestampNTZ6,
  ID.timestampNTZ,
  ID.date,
  ID.time0,
  ID.time3,
  ID.time6,
  ID.time,
  ID.interval,
  ID.geometry,
  ID.geography,
])

export type Type =
  | TypePrimitive
  | TypeRecord
  | TypeArray
  | TypeSet
  | TypeMap
  | TypeUnion
  | TypeEnum
  | TypeError
  | TypeNamed
  | TypeFusion
  | TypeOption
  | TypeDecimal

export type TypeKind = Type["kind"]

// Every type gets a process-unique serial number, which interning keys
// use to refer to child types.
let nextSerial = 1000

abstract class TypeBase {
  /** A process-unique number identifying this type object. */
  readonly serial: number
  constructor(serial?: number) {
    this.serial = serial ?? nextSerial++
  }
  /** The SUP syntax of this type, e.g., `{a:int64,b:[string]}`. */
  toString(): string {
    return formatType(this as unknown as Type)
  }
}

export class TypePrimitive extends TypeBase {
  readonly kind = "primitive"
  readonly id: number
  readonly name: string
  constructor(id: number) {
    super(id)
    this.id = id
    this.name = primitiveNames[id]
  }
  /** True for reserved primitive types whose values aren't defined yet. */
  get isUnimplemented(): boolean {
    return unimplementedIDs.has(this.id)
  }
}

export interface Field {
  readonly name: string
  readonly type: Type
}

export class TypeRecord extends TypeBase {
  readonly kind = "record"
  readonly fields: readonly Field[]
  private index: Map<string, number> | undefined
  constructor(fields: readonly Field[]) {
    super()
    this.fields = fields
  }
  /** The position of the field named name or -1. */
  indexOf(name: string): number {
    if (!this.index) {
      this.index = new Map(this.fields.map((f, k) => [f.name, k]))
    }
    return this.index.get(name) ?? -1
  }
  has(name: string): boolean {
    return this.indexOf(name) >= 0
  }
  field(name: string): Field | undefined {
    const k = this.indexOf(name)
    return k < 0 ? undefined : this.fields[k]
  }
  /**
   * The field at indexPath, descending through nested records (looking
   * through named and option types), or undefined.
   */
  fieldAt(indexPath: readonly number[]): Field | undefined {
    let rec: TypeRecord | null = this
    let field: Field | undefined
    for (const k of indexPath) {
      if (!rec) return undefined
      field = rec.fields[k]
      if (!field) return undefined
      rec = recordOf(field.type)
    }
    return field
  }
}

export class TypeArray extends TypeBase {
  readonly kind = "array"
  readonly type: Type
  constructor(type: Type) {
    super()
    this.type = type
  }
}

export class TypeSet extends TypeBase {
  readonly kind = "set"
  readonly type: Type
  constructor(type: Type) {
    super()
    this.type = type
  }
}

export class TypeMap extends TypeBase {
  readonly kind = "map"
  readonly keyType: Type
  readonly valType: Type
  constructor(keyType: Type, valType: Type) {
    super()
    this.keyType = keyType
    this.valType = valType
  }
}

export class TypeUnion extends TypeBase {
  readonly kind = "union"
  /** Member types in canonical order; a member's position is its tag. */
  readonly types: readonly Type[]
  constructor(types: readonly Type[]) {
    super()
    this.types = types
  }
}

export class TypeEnum extends TypeBase {
  readonly kind = "enum"
  readonly symbols: readonly string[]
  constructor(symbols: readonly string[]) {
    super()
    this.symbols = symbols
  }
}

export class TypeError extends TypeBase {
  readonly kind = "error"
  readonly type: Type
  constructor(type: Type) {
    super()
    this.type = type
  }
}

export class TypeNamed extends TypeBase {
  readonly kind = "named"
  readonly name: string
  // Set once after construction so recursive types can refer to
  // themselves.  Treat as readonly.
  type!: Type
  constructor(name: string, type?: Type) {
    super()
    this.name = name
    if (type) this.type = type
  }
}

export class TypeFusion extends TypeBase {
  readonly kind = "fusion"
  /** The supertype to which the fused values conform. */
  readonly type: Type
  constructor(type: Type) {
    super()
    this.type = type
  }
}

export class TypeOption extends TypeBase {
  readonly kind = "option"
  readonly type: Type
  constructor(type: Type) {
    super()
    this.type = type
  }
}

export class TypeDecimal extends TypeBase {
  readonly kind = "decimal"
  readonly precision: number
  readonly scale: number
  constructor(precision: number, scale: number) {
    super()
    this.precision = precision
    this.scale = scale
  }
}

// The primitive types are singletons shared by every context.
const primitives: TypePrimitive[] = primitiveNames.map((_, id) => new TypePrimitive(id))

export const TypeUint8 = primitives[ID.uint8]
export const TypeUint16 = primitives[ID.uint16]
export const TypeUint32 = primitives[ID.uint32]
export const TypeUint64 = primitives[ID.uint64]
export const TypeInt8 = primitives[ID.int8]
export const TypeInt16 = primitives[ID.int16]
export const TypeInt32 = primitives[ID.int32]
export const TypeInt64 = primitives[ID.int64]
export const TypeDuration = primitives[ID.duration]
export const TypeTimestamp = primitives[ID.timestamp]
export const TypeFloat16 = primitives[ID.float16]
export const TypeFloat32 = primitives[ID.float32]
export const TypeFloat64 = primitives[ID.float64]
export const TypeBool = primitives[ID.bool]
export const TypeBytes = primitives[ID.bytes]
export const TypeString = primitives[ID.string]
export const TypeIP = primitives[ID.ip]
export const TypeNet = primitives[ID.net]
export const TypeUUID = primitives[ID.uuid]
export const TypeType = primitives[ID.type]
export const TypeNull = primitives[ID.null]
export const TypeMissing = primitives[ID.missing]
export const TypeNone = primitives[ID.none]
export const TypeAll = primitives[ID.all]
export const TypeAny = primitives[ID.any]

/** The primitive type with the given ID. Throws for an unknown ID. */
export function primitiveType(id: number): TypePrimitive {
  const t = primitives[id]
  if (!t) throw new Error(`unknown primitive type ID ${id}`)
  return t
}

/** The primitive type with the given SUP name, or undefined. */
export function primitiveTypeByName(name: string): TypePrimitive | undefined {
  if (name === "timestamp(9)") return TypeTimestamp
  if (name === "timestamp_ntz(9)") return primitives[ID.timestampNTZ]
  if (name === "time(9)") return primitives[ID.time]
  const id = primitiveNames.indexOf(name)
  return id < 0 ? undefined : primitives[id]
}

/**
 * A TypeContext interns types so structurally equal types are the same
 * object.  Share one context across the decoders of an application (e.g.,
 * one per client) so shapes compare by identity across queries.
 */
export class TypeContext {
  private table = new Map<string, Type>()

  private intern<T extends Type>(key: string, make: () => T): T {
    let t = this.table.get(key)
    if (!t) {
      t = make()
      this.table.set(key, t)
    }
    return t as T
  }

  primitive(id: number): TypePrimitive {
    return primitiveType(id)
  }

  record(fields: readonly Field[]): TypeRecord {
    let key = "r"
    for (const f of fields) key += `${JSON.stringify(f.name)}:${f.type.serial},`
    return this.intern(key, () => new TypeRecord(fields.map((f) => ({ name: f.name, type: f.type }))))
  }

  array(type: Type): TypeArray {
    return this.intern(`a${type.serial}`, () => new TypeArray(type))
  }

  set(type: Type): TypeSet {
    return this.intern(`s${type.serial}`, () => new TypeSet(type))
  }

  map(keyType: Type, valType: Type): TypeMap {
    return this.intern(`m${keyType.serial},${valType.serial}`, () => new TypeMap(keyType, valType))
  }

  /** A union of types, which must already be in canonical order. */
  union(types: readonly Type[]): TypeUnion {
    return this.intern(`u${types.map((t) => t.serial).join(",")}`, () => new TypeUnion([...types]))
  }

  enum(symbols: readonly string[]): TypeEnum {
    return this.intern(`e${JSON.stringify(symbols)}`, () => new TypeEnum([...symbols]))
  }

  error(type: Type): TypeError {
    return this.intern(`E${type.serial}`, () => new TypeError(type))
  }

  fusion(type: Type): TypeFusion {
    return this.intern(`f${type.serial}`, () => new TypeFusion(type))
  }

  option(type: Type): TypeOption {
    return this.intern(`o${type.serial}`, () => new TypeOption(type))
  }

  decimal(precision: number, scale: number): TypeDecimal {
    return this.intern(`d${precision},${scale}`, () => new TypeDecimal(precision, scale))
  }

  named(name: string, type: Type): TypeNamed {
    return this.intern(`n${JSON.stringify(name)}=${type.serial}`, () => new TypeNamed(name, type))
  }

  /**
   * Begins a named type whose underlying type isn't known yet, so the
   * underlying type may refer to it (a recursive type).  Complete it with
   * bindNamed.
   */
  namedPlaceholder(name: string): TypeNamed {
    return new TypeNamed(name)
  }

  /**
   * Completes a placeholder from namedPlaceholder.  If an equal named type
   * already exists (and the underlying type doesn't refer to the
   * placeholder), the existing type is returned instead.
   */
  bindNamed(placeholder: TypeNamed, type: Type): TypeNamed {
    const key = `n${JSON.stringify(placeholder.name)}=${type.serial}`
    const existing = this.table.get(key)
    if (existing) return existing as TypeNamed
    placeholder.type = type
    this.table.set(key, placeholder)
    return placeholder
  }
}

// Type predicates and helpers.

/** typ with any named types removed, i.e., the type underneath the names. */
export function under(typ: Type): Exclude<Type, TypeNamed> {
  let t: Type = typ
  // A malformed recursive type could loop; bound the walk.
  for (let k = 0; t.kind === "named" && k < 1000; k++) t = t.type
  if (t.kind === "named") throw new Error(`named type ${t.name} has no underlying type`)
  return t
}

/** The record type under typ, looking through named and option types. */
export function recordOf(typ: Type): TypeRecord | null {
  let t = under(typ)
  if (t.kind === "option") t = under(t.type)
  return t.kind === "record" ? t : null
}

export function isPrimitive(typ: Type): typ is TypePrimitive {
  return typ.kind === "primitive"
}

export function isUnsigned(typ: Type): boolean {
  const t = under(typ)
  return t.kind === "primitive" && t.id <= ID.uint128
}

export function isSigned(typ: Type): boolean {
  const t = under(typ)
  return t.kind === "primitive" && t.id >= ID.int8 && t.id <= ID.int128
}

export function isInteger(typ: Type): boolean {
  const t = under(typ)
  return t.kind === "primitive" && t.id <= ID.int128
}

export function isFloat(typ: Type): boolean {
  const t = under(typ)
  return t.kind === "primitive" && t.id >= ID.float16 && t.id <= ID.float64
}

/** True for integers, floats, durations, and times. */
export function isNumber(typ: Type): boolean {
  const t = under(typ)
  return t.kind === "primitive" && t.id <= ID.float64
}

export function isStringy(typ: Type): boolean {
  const t = under(typ)
  return t.kind === "primitive" && (t.id === ID.string || t.id === ID.bytes)
}

export function isContainer(typ: Type): boolean {
  const k = under(typ).kind
  return k === "record" || k === "array" || k === "set" || k === "map"
}

export function isNamed(typ: Type): typ is TypeNamed {
  return typ.kind === "named"
}

export function isFusionAll(typ: Type): boolean {
  const t = under(typ)
  return t.kind === "fusion" && t.type === TypeAll
}

// Type formatting in SUP syntax.

const identRE = /^[\p{L}_$][\p{L}\p{Nd}_$]*$/u
const typeNameRE = /^[\p{L}_$.][\p{L}\p{Nd}_$.]*$/u

/** name quoted as a SUP string if it isn't an identifier. */
export function quotedName(name: string): string {
  return identRE.test(name) ? name : quotedString(name)
}

/** name quoted as a SUP string if it isn't a valid type name. */
export function quotedTypeName(name: string): string {
  return name === "" || typeNameRE.test(name) ? name : quotedString(name)
}

/** s as a quoted and escaped SUP string. */
export function quotedString(s: string): string {
  let out = '"'
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k)
    if (c >= 0x20 && c !== 0x22 && c !== 0x5c) {
      out += s[k]
      continue
    }
    switch (c) {
      case 0x22:
        out += '\\"'
        break
      case 0x5c:
        out += "\\\\"
        break
      case 0x08:
        out += "\\b"
        break
      case 0x0c:
        out += "\\f"
        break
      case 0x0a:
        out += "\\n"
        break
      case 0x0d:
        out += "\\r"
        break
      case 0x09:
        out += "\\t"
        break
      default:
        out += "\\u00" + c.toString(16).padStart(2, "0")
    }
  }
  return out + '"'
}

/** A "short" type is formatted inline (e.g., inside a type value). */
export function isShortType(typ: Type): boolean {
  switch (typ.kind) {
    case "named":
      return typ.name.length < 20
    case "primitive":
    case "decimal":
      return true
    case "record":
      return typ.fields.length <= 4 && typ.fields.every((f) => isShortType(f.type) && f.name.length <= 12)
    case "array":
    case "set":
    case "error":
    case "fusion":
    case "option":
      return isShortType(typ.type)
    case "map":
      return isShortType(typ.keyType) && isShortType(typ.valType)
    case "union":
      return typ.types.length <= 6 && typ.types.every(isShortType)
    case "enum":
      return false
  }
}

/**
 * Formats typ in SUP type syntax.  Named types are formatted by name.  When
 * parens is true, a union is wrapped in parentheses (as needed, e.g., in a
 * value decorator).
 */
export function formatType(typ: Type, parens = false): string {
  switch (typ.kind) {
    case "primitive":
      return typ.name
    case "named":
      return quotedName(typ.name)
    case "record":
      return (
        "{" +
        typ.fields
          .map((f) => {
            let t = f.type
            let q = ""
            if (t.kind === "option") {
              q = "?"
              t = t.type
            }
            return `${quotedName(f.name)}${q}:${formatType(t)}`
          })
          .join(",") +
        "}"
      )
    case "array":
      return `[${formatType(typ.type)}]`
    case "set":
      return `set[${formatType(typ.type)}]`
    case "map":
      return `map{${formatType(typ.keyType)}:${formatType(typ.valType)}}`
    case "union": {
      const s = typ.types.map((t) => formatType(t)).join("|")
      return parens ? `(${s})` : s
    }
    case "enum":
      return `enum(${typ.symbols.map(quotedName).join(",")})`
    case "error":
      return `error(${formatType(typ.type)})`
    case "fusion":
      return `fusion(${formatType(typ.type)})`
    case "option":
      return `option(${formatType(typ.type)})`
    case "decimal":
      return `decimal(${typ.precision},${typ.scale})`
  }
}
