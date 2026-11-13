// Super-structured values.
//
// Every value carries its type.  The class of a value is determined by the
// type underneath any named types, so a value of type `port=uint16` is a
// UintValue whose `type` is the named type `port`.

import {
  type Type,
  type TypeRecord,
  type TypeEnum,
  type TypeFusion,
  type TypeUnion,
  formatType,
  recordOf,
  under,
} from "./types.ts"
import { formatValue } from "./sup.ts"
import { formatIP, formatNet, formatTimestamp, formatUUID } from "./format.ts"

export type ValueKind =
  | "uint"
  | "int"
  | "float"
  | "bool"
  | "bytes"
  | "string"
  | "ip"
  | "net"
  | "uuid"
  | "duration"
  | "timestamp"
  | "type"
  | "null"
  | "missing"
  | "none"
  | "unimplemented"
  | "record"
  | "array"
  | "set"
  | "map"
  | "union"
  | "enum"
  | "error"
  | "option"
  | "fusion"

export type Value =
  | UintValue
  | IntValue
  | FloatValue
  | BoolValue
  | BytesValue
  | StringValue
  | IPValue
  | NetValue
  | UUIDValue
  | DurationValue
  | TimestampValue
  | TypeValue
  | NullValue
  | MissingValue
  | NoneValue
  | UnimplementedValue
  | RecordValue
  | ArrayValue
  | SetValue
  | MapValue
  | UnionValue
  | EnumValue
  | ErrorValue
  | OptionValue
  | FusionValue

abstract class ValueBase {
  readonly type: Type
  constructor(type: Type) {
    this.type = type
  }
  abstract readonly kind: ValueKind
  /** The value in SUP syntax. */
  toString(): string {
    return formatValue(this as unknown as Value)
  }
  /** A plain JavaScript representation of the value (lossy). */
  abstract toJS(): unknown
  /** True for null values. */
  isNull(): boolean {
    return false
  }
  /**
   * True for values that are absent: null, missing, none, and option
   * nones.  A table view renders these as empty cells.
   */
  isUnset(): boolean {
    return false
  }
  /** The value with any options and unions unwrapped. */
  unwrap(): Value {
    return this as unknown as Value
  }
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER)

/** n as a number if it fits without loss, otherwise as a bigint. */
export function compactInt(n: bigint): number | bigint {
  return n >= MIN_SAFE && n <= MAX_SAFE ? Number(n) : n
}

export class UintValue extends ValueBase {
  readonly kind = "uint"
  /** A number when the value is a safe integer, otherwise a bigint. */
  readonly value: number | bigint
  constructor(type: Type, value: number | bigint) {
    super(type)
    this.value = value
  }
  toBigInt(): bigint {
    return BigInt(this.value)
  }
  toNumber(): number {
    return Number(this.value)
  }
  toJS(): number | bigint {
    return this.value
  }
}

export class IntValue extends ValueBase {
  readonly kind = "int"
  /** A number when the value is a safe integer, otherwise a bigint. */
  readonly value: number | bigint
  constructor(type: Type, value: number | bigint) {
    super(type)
    this.value = value
  }
  toBigInt(): bigint {
    return BigInt(this.value)
  }
  toNumber(): number {
    return Number(this.value)
  }
  toJS(): number | bigint {
    return this.value
  }
}

export class FloatValue extends ValueBase {
  readonly kind = "float"
  readonly value: number
  constructor(type: Type, value: number) {
    super(type)
    this.value = value
  }
  toNumber(): number {
    return this.value
  }
  toJS(): number {
    return this.value
  }
}

export class BoolValue extends ValueBase {
  readonly kind = "bool"
  readonly value: boolean
  constructor(type: Type, value: boolean) {
    super(type)
    this.value = value
  }
  toJS(): boolean {
    return this.value
  }
}

export class BytesValue extends ValueBase {
  readonly kind = "bytes"
  readonly value: Uint8Array
  constructor(type: Type, value: Uint8Array) {
    super(type)
    this.value = value
  }
  toJS(): Uint8Array {
    return this.value
  }
}

export class StringValue extends ValueBase {
  readonly kind = "string"
  readonly value: string
  constructor(type: Type, value: string) {
    super(type)
    this.value = value
  }
  toJS(): string {
    return this.value
  }
}

export class IPValue extends ValueBase {
  readonly kind = "ip"
  /** 4 bytes for IPv4 or 16 bytes for IPv6, in network order. */
  readonly bytes: Uint8Array
  constructor(type: Type, bytes: Uint8Array) {
    super(type)
    this.bytes = bytes
  }
  /** The address as text, e.g., `10.0.0.1` or `fe80::1`. */
  get value(): string {
    return formatIP(this.bytes)
  }
  toJS(): string {
    return this.value
  }
}

export class NetValue extends ValueBase {
  readonly kind = "net"
  /** The address followed by the mask. */
  readonly bytes: Uint8Array
  constructor(type: Type, bytes: Uint8Array) {
    super(type)
    this.bytes = bytes
  }
  /** The network in CIDR notation, e.g., `10.0.0.0/8`. */
  get value(): string {
    return formatNet(this.bytes)
  }
  toJS(): string {
    return this.value
  }
}

export class UUIDValue extends ValueBase {
  readonly kind = "uuid"
  readonly bytes: Uint8Array
  constructor(type: Type, bytes: Uint8Array) {
    super(type)
    this.bytes = bytes
  }
  get value(): string {
    return formatUUID(this.bytes)
  }
  toJS(): string {
    return this.value
  }
}

export class DurationValue extends ValueBase {
  readonly kind = "duration"
  /** Nanoseconds. */
  readonly ns: bigint
  constructor(type: Type, ns: bigint) {
    super(type)
    this.ns = ns
  }
  /** Milliseconds as a (possibly fractional) number. */
  toMillis(): number {
    return Number(this.ns) / 1e6
  }
  toJS(): bigint {
    return this.ns
  }
}

export class TimestampValue extends ValueBase {
  readonly kind = "timestamp"
  /** Nanoseconds since the Unix epoch. */
  readonly ns: bigint
  constructor(type: Type, ns: bigint) {
    super(type)
    this.ns = ns
  }
  /** The time as a Date (truncated to milliseconds). */
  toDate(): Date {
    return new Date(Number(this.ns / 1_000_000n))
  }
  /** RFC 3339 text in UTC with nanosecond precision. */
  toISOString(): string {
    return formatTimestamp(this.ns)
  }
  toJS(): Date {
    return this.toDate()
  }
}

export class TypeValue extends ValueBase {
  readonly kind = "type"
  /** The type this value represents. */
  readonly value: Type
  constructor(type: Type, value: Type) {
    super(type)
    this.value = value
  }
  toJS(): string {
    return formatType(this.value)
  }
}

export class NullValue extends ValueBase {
  readonly kind = "null"
  override isNull(): boolean {
    return true
  }
  override isUnset(): boolean {
    return true
  }
  toJS(): null {
    return null
  }
}

export class MissingValue extends ValueBase {
  readonly kind = "missing"
  override isUnset(): boolean {
    return true
  }
  toJS(): undefined {
    return undefined
  }
}

export class NoneValue extends ValueBase {
  readonly kind = "none"
  override isUnset(): boolean {
    return true
  }
  toJS(): undefined {
    return undefined
  }
}

/**
 * A value of a reserved type that isn't implemented yet (e.g., date), or a
 * stray value of type all.  Its body is kept as bytes.
 */
export class UnimplementedValue extends ValueBase {
  readonly kind = "unimplemented"
  readonly bytes: Uint8Array
  constructor(type: Type, bytes: Uint8Array) {
    super(type)
    this.bytes = bytes
  }
  toJS(): Uint8Array {
    return this.bytes
  }
}

export interface FieldValue {
  readonly name: string
  readonly value: Value
}

export class RecordValue extends ValueBase {
  readonly kind = "record"
  /** The field values in the order of the record type's fields. */
  readonly values: readonly Value[]
  constructor(type: Type, values: readonly Value[]) {
    super(type)
    this.values = values
  }
  /** The record type (under any names). */
  get recordType(): TypeRecord {
    return under(this.type) as TypeRecord
  }
  get fields(): FieldValue[] {
    const fields = this.recordType.fields
    return this.values.map((value, k) => ({ name: fields[k].name, value }))
  }
  get length(): number {
    return this.values.length
  }
  has(name: string): boolean {
    return this.recordType.indexOf(name) >= 0
  }
  /** The value of the field named name or undefined. */
  get(name: string): Value | undefined {
    const k = this.recordType.indexOf(name)
    return k < 0 ? undefined : this.values[k]
  }
  /** The value of the kth field. */
  at(k: number): Value | undefined {
    return this.values[k]
  }
  /**
   * The value at indexPath, descending through nested records (looking
   * through options), or undefined if the path doesn't exist in this value.
   */
  fieldAt(indexPath: readonly number[]): Value | undefined {
    let v: Value | undefined = this as unknown as Value
    for (const k of indexPath) {
      if (v && v.kind === "option") v = v.value ?? undefined
      if (!v || v.kind !== "record") return undefined
      v = v.values[k]
    }
    return v
  }
  /** The value at a path of field names (like fieldAt). */
  getPath(path: readonly string[]): Value | undefined {
    let v: Value | undefined = this as unknown as Value
    for (const name of path) {
      if (v && v.kind === "option") v = v.value ?? undefined
      if (!v || v.kind !== "record") return undefined
      v = v.get(name)
    }
    return v
  }
  toJS(): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    const fields = this.recordType.fields
    this.values.forEach((v, k) => {
      if (v.kind === "option" && v.value === null) return
      obj[fields[k].name] = v.toJS()
    })
    return obj
  }
}

export class ArrayValue extends ValueBase {
  readonly kind = "array"
  readonly items: readonly Value[]
  constructor(type: Type, items: readonly Value[]) {
    super(type)
    this.items = items
  }
  get length(): number {
    return this.items.length
  }
  at(k: number): Value | undefined {
    return this.items[k]
  }
  toJS(): unknown[] {
    return this.items.map((v) => v.toJS())
  }
}

export class SetValue extends ValueBase {
  readonly kind = "set"
  readonly items: readonly Value[]
  constructor(type: Type, items: readonly Value[]) {
    super(type)
    this.items = items
  }
  get length(): number {
    return this.items.length
  }
  at(k: number): Value | undefined {
    return this.items[k]
  }
  toJS(): unknown[] {
    return this.items.map((v) => v.toJS())
  }
}

export class MapValue extends ValueBase {
  readonly kind = "map"
  readonly entries: readonly (readonly [Value, Value])[]
  constructor(type: Type, entries: readonly (readonly [Value, Value])[]) {
    super(type)
    this.entries = entries
  }
  get length(): number {
    return this.entries.length
  }
  get keys(): Value[] {
    return this.entries.map((e) => e[0])
  }
  get values(): Value[] {
    return this.entries.map((e) => e[1])
  }
  /** The value whose key formats the same as key (SUP text comparison). */
  get(key: Value | string): Value | undefined {
    const s = typeof key === "string" ? key : key.toString()
    for (const [k, v] of this.entries) {
      if ((typeof key === "string" && k.kind === "string" && k.value === key) || k.toString() === s) return v
    }
    return undefined
  }
  toJS(): Map<unknown, unknown> {
    return new Map(this.entries.map(([k, v]) => [k.toJS(), v.toJS()]))
  }
}

export class UnionValue extends ValueBase {
  readonly kind = "union"
  readonly tag: number
  /** The member value, whose type is the member type for tag. */
  readonly value: Value
  constructor(type: Type, tag: number, value: Value) {
    super(type)
    this.tag = tag
    this.value = value
  }
  get unionType(): TypeUnion {
    return under(this.type) as TypeUnion
  }
  override unwrap(): Value {
    return this.value.unwrap()
  }
  toJS(): unknown {
    return this.value.toJS()
  }
}

export class EnumValue extends ValueBase {
  readonly kind = "enum"
  readonly index: number
  constructor(type: Type, index: number) {
    super(type)
    this.index = index
  }
  get symbol(): string {
    return (under(this.type) as TypeEnum).symbols[this.index] ?? `#${this.index}`
  }
  toJS(): string {
    return this.symbol
  }
}

export class ErrorValue extends ValueBase {
  readonly kind = "error"
  readonly value: Value
  constructor(type: Type, value: Value) {
    super(type)
    this.value = value
  }
  /** The error's value as text if it's a string, otherwise its SUP text. */
  get message(): string {
    const v = this.value.unwrap()
    return v.kind === "string" ? v.value : v.toString()
  }
  toJS(): { error: unknown } {
    return { error: this.value.toJS() }
  }
}

export class OptionValue extends ValueBase {
  readonly kind = "option"
  /** The value, or null if the option is none. */
  readonly value: Value | null
  constructor(type: Type, value: Value | null) {
    super(type)
    this.value = value
  }
  isNone(): boolean {
    return this.value === null
  }
  override isUnset(): boolean {
    return this.value === null || this.value.isUnset()
  }
  override unwrap(): Value {
    return this.value ? this.value.unwrap() : (this as unknown as Value)
  }
  toJS(): unknown {
    return this.value ? this.value.toJS() : undefined
  }
}

export class FusionValue extends ValueBase {
  readonly kind = "fusion"
  /**
   * The value as a value of the fusion's supertype, or for fusion(all), as
   * a value of its subtype.
   */
  readonly value: Value
  /** The actual type of the value before it was fused. */
  readonly subtype: Type
  constructor(type: Type, value: Value, subtype: Type) {
    super(type)
    this.value = value
    this.subtype = subtype
  }
  get fusionType(): TypeFusion {
    return under(this.type) as TypeFusion
  }
  override unwrap(): Value {
    return this.value.unwrap()
  }
  toJS(): unknown {
    return this.value.toJS()
  }
}

/** True if v is a container value (record, array, set, or map). */
export function isContainerValue(v: Value): v is RecordValue | ArrayValue | SetValue | MapValue {
  return v.kind === "record" || v.kind === "array" || v.kind === "set" || v.kind === "map"
}

/** The record under v (looking through options and unions) or null. */
export function recordValueOf(v: Value): RecordValue | null {
  const u = v.unwrap()
  return u.kind === "record" ? u : null
}

/** The record type of v's type, looking through names and options, or null. */
export function recordTypeOf(v: Value): TypeRecord | null {
  return recordOf(v.type)
}
