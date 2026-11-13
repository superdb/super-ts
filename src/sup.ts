// Formatting of values in SUP, the text format of super-structured data.
//
// This is a port of the (non-pretty) formatter of the Go implementation so
// the text matches what `super -f sup` produces, including type decorators
// such as `1::int8` that make the text round-trip to the same typed value.

import {
  type Type,
  type TypeRecord,
  type TypeUnion,
  ID,
  TypeAll,
  formatType,
  quotedName,
  quotedString,
  quotedTypeName,
  under,
} from "./types.ts"
import type { Value, RecordValue, MapValue, UnionValue } from "./values.ts"
import { formatDuration, formatFloat32, formatFloat64, formatTimestamp, hex } from "./format.ts"

/** Formats val in SUP syntax with the decorators needed to preserve its type. */
export function formatValue(val: Value): string {
  const f = new Formatter()
  f.formatValueAndDecorate(val.type, val)
  return f.out
}

/** Formats a primitive value without any decorator, e.g., for a table cell. */
export function formatPrimitive(val: Value): string {
  switch (val.kind) {
    case "uint":
    case "int":
      return String(val.value)
    case "float": {
      const t = under(val.type)
      return t.kind === "primitive" && t.id === ID.float64 ? formatFloat64(val.value) : formatFloat32(val.value)
    }
    case "bool":
      return val.value ? "true" : "false"
    case "bytes":
      return "0x" + hex(val.value)
    case "string":
      return quotedString(val.value)
    case "ip":
    case "net":
    case "uuid":
      return val.value
    case "duration":
      return formatDuration(val.ns)
    case "timestamp":
      return formatTimestamp(val.ns)
    case "type":
      return formatTypeValue(val.value)
    case "null":
      return "null"
    case "missing":
      return "missing"
    case "none":
      return "none"
    case "unimplemented":
      return "0x" + hex(val.bytes)
    default:
      return formatValue(val)
  }
}

/** Formats a type as a SUP type value, e.g., `<{a:int64}>`. */
export function formatTypeValue(typ: Type): string {
  return `<${formatType(typ)}>`
}

/** True if a value of typ needs no decorator for its type to be implied. */
export function implied(typ: Type): boolean {
  switch (typ.kind) {
    case "primitive":
      switch (typ.id) {
        case ID.int64:
        case ID.duration:
        case ID.timestamp:
        case ID.float64:
        case ID.bool:
        case ID.bytes:
        case ID.string:
        case ID.ip:
        case ID.net:
        case ID.uuid:
        case ID.type:
        case ID.null:
        case ID.missing:
        case ID.none:
          return true
      }
      return false
    case "record":
      return typ.fields.every((f) => implied(f.type))
    case "array":
    case "set":
    case "error":
      return implied(typ.type)
    case "map":
      return implied(typ.keyType) && implied(typ.valType)
    case "fusion":
      return true
  }
  return false
}

/** True if a type can be derived entirely from a value of the type. */
export function selfDescribing(typ: Type): boolean {
  if (implied(typ)) return true
  switch (typ.kind) {
    case "record":
    case "array":
    case "set":
    case "map":
    case "error":
      return true
    case "named":
      if (typ.type.kind === "named") return false
      return selfDescribing(typ.type)
  }
  return false
}

function isOptionType(typ: Type): boolean {
  return under(typ).kind === "option"
}

// isOptionNone is true if typ itself (not under a name) is an option and val
// is its none.
function isOptionNone(typ: Type, val: Value): boolean {
  return typ.kind === "option" && val.kind === "option" && val.value === null
}

function innerEmptyType(typ: Type): boolean {
  switch (typ.kind) {
    case "array":
    case "set":
      return typ.type.kind === "primitive" && typ.type.id === ID.none
    case "map":
      return (
        typ.keyType.kind === "primitive" &&
        typ.keyType.id === ID.none &&
        typ.valType.kind === "primitive" &&
        typ.valType.id === ID.none
      )
  }
  return false
}

function quoteHexyString(s: string): string {
  if (s === "" || s.length > 4) return s
  return /^[0-9a-fA-F]+$/.test(s) ? JSON.stringify(s) : s
}

class Formatter {
  out = ""
  private impliedCache = new Map<Type, boolean>()

  private isImplied(typ: Type): boolean {
    let v = this.impliedCache.get(typ)
    if (v === undefined) {
      v = implied(typ)
      this.impliedCache.set(typ, v)
    }
    return v
  }

  formatValueAndDecorate(typ: Type, val: Value) {
    const known = typ.kind === "named"
    if (known && isOptionNone(under(typ), val)) {
      this.out += "none"
    } else {
      this.formatValue(typ, val, known, false, false)
    }
    this.decorate(typ, false, isOptionNone(typ, val))
  }

  formatValue(typ: Type, val: Value, parentKnown: boolean, decorate: boolean, isOptField: boolean) {
    const known = parentKnown || typ.kind === "named"
    let empty = false
    let isNone = false
    switch (typ.kind) {
      case "primitive":
        if (typ.id === ID.type && val.kind === "type") {
          this.out += formatTypeValue(val.value)
        } else {
          this.out += formatPrimitive(val)
        }
        break
      case "named":
        if (!parentKnown && isOptionNone(under(typ), val)) {
          this.out += "none"
        } else {
          this.formatValue(typ.type, val, known, false, isOptField)
        }
        break
      case "record":
        this.formatRecord(typ, val as RecordValue, known)
        break
      case "array":
      case "set":
        if (val.kind !== "array" && val.kind !== "set") throw new Error(`bad ${typ.kind} value`)
        empty = this.formatElems(typ.kind === "set" ? "set[" : "[", "]", typ.type, val.items, known, typ)
        break
      case "union":
        this.formatUnion(val as UnionValue)
        break
      case "map":
        empty = this.formatMap(typ, val as MapValue, known)
        break
      case "enum":
        if (val.kind !== "enum") throw new Error("bad enum value")
        this.out += `"${val.symbol}"`
        break
      case "error":
        if (val.kind !== "error") throw new Error("bad error value")
        this.out += "error("
        this.formatValue(typ.type, val.value, known, true, false)
        this.out += ")"
        break
      case "fusion":
        if (val.kind !== "fusion") throw new Error("bad fusion value")
        if (typ.type === TypeAll) {
          this.formatValue(val.subtype, val.value, false, true, isOptField)
          this.out += "::any"
          return
        }
        this.out += "fusion("
        this.formatValue(typ.type, val.value, known, true, false)
        this.out += ","
        this.out += formatTypeValue(val.subtype)
        this.out += ")"
        // A fusion value's type is always implied by its value.
        return
      case "option":
        if (val.kind !== "option") throw new Error("bad option value")
        if (val.value === null) {
          this.out += "none"
          isNone = true
        } else {
          if (!isOptField) this.out += "some("
          this.formatValue(typ.type, val.value, known, true, false)
          if (!isOptField) this.out += ")"
        }
        break
      case "decimal":
        this.out += formatPrimitive(val)
        break
    }
    if (decorate && !parentKnown) this.decorate(typ, empty, isNone)
  }

  private decorate(typ: Type, empty: boolean, isTypedNone: boolean) {
    if (
      (!empty && this.isImplied(typ)) ||
      (empty && innerEmptyType(typ)) ||
      (isOptionType(typ) && typ.kind !== "named" && !isTypedNone)
    ) {
      return
    }
    if (typ.kind === "named") {
      this.out += "::" + quoteHexyString(quotedTypeName(typ.name))
      return
    }
    if (!empty && selfDescribing(typ) && !isTypedNone) return
    this.out += "::"
    if (isTypedNone && typ.kind === "option") {
      // A decorator on a none implies an option, so decorate with the type
      // under the option, but distinguish an option of a union.
      if (typ.type.kind === "union") this.out += "option"
      typ = typ.type
    }
    this.out += formatType(typ, true)
  }

  private formatRecord(typ: TypeRecord, val: RecordValue, known: boolean) {
    this.out += "{"
    let sep = ""
    typ.fields.forEach((field, k) => {
      const elem = val.values[k]
      // When the record type is implied by a parent decorator, optional
      // fields that are none are omitted as the decorator fills them in.
      if (known && isOptionNone(under(field.type), elem)) return
      this.out += sep + quotedName(field.name)
      const isOptField = isOptionType(field.type)
      if (isOptField) this.out += "?"
      this.out += ":"
      this.formatValue(field.type, elem, known, true, isOptField)
      sep = ","
    })
    this.out += "}"
  }

  private formatElems(open: string, close: string, inner: Type, items: readonly Value[], known: boolean, typ: Type): boolean {
    this.out += open
    if (items.length === 0) {
      this.out += close
      return true
    }
    const elems = new ElemHelper(inner)
    items.forEach((item, k) => {
      if (k > 0) this.out += ","
      const [t, v] = elems.add(item)
      this.formatValue(t, v, known, true, false)
    })
    this.out += close
    if (elems.needsDecoration()) this.decorate(typ, true, false)
    return false
  }

  private formatUnion(val: UnionValue) {
    // Union values are always decorated so the tag can be determined from
    // the value's explicit type.
    this.formatValue(val.value.type, val.value, false, true, false)
  }

  private formatMap(typ: Extract<Type, { kind: "map" }>, val: MapValue, known: boolean): boolean {
    this.out += "map{"
    const keyElems = new ElemHelper(typ.keyType)
    const valElems = new ElemHelper(typ.valType)
    val.entries.forEach(([key, value], k) => {
      if (k > 0) this.out += ","
      const [kt, kv] = keyElems.add(key)
      this.formatValue(kt, kv, known, true, false)
      // Whitespace must separate an IPv6 map key from the colon.
      if (kv.kind === "ip" && kv.bytes.length === 16) this.out += " "
      this.out += ":"
      const [vt, vv] = valElems.add(value)
      this.formatValue(vt, vv, known, true, false)
    })
    this.out += "}"
    if (keyElems.needsDecoration() || valElems.needsDecoration()) this.decorate(typ, true, false)
    return val.entries.length === 0
  }
}

// ElemHelper untags the elements of a container whose element type is a
// union and tracks which members appear so the container can be decorated
// when they don't all appear.
class ElemHelper {
  private typ: Type
  private union: TypeUnion | null
  private seen = new Set<number>()
  constructor(typ: Type) {
    this.typ = typ
    const u = under(typ)
    this.union = u.kind === "union" ? u : null
  }
  add(v: Value): [Type, Value] {
    if (!this.union || v.kind !== "union") return [this.typ, v]
    this.seen.add(v.tag)
    return [v.value.type, v.value]
  }
  needsDecoration(): boolean {
    return this.union !== null && (this.typ.kind === "named" || this.seen.size < this.union.types.length)
  }
}
