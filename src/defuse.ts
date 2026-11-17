// Defusing: turning values that contain fusion values back into the values
// they were before they were fused.
//
// A fusion value holds a value of its fusion type's supertype together with
// its subtype, the type it had before fusion.  Defusing downcasts the value
// to its subtype, so, e.g., a field of type fusion(string|missing) whose
// subtype is missing disappears from its record.  This is a port of the Go
// implementation's row-based defuse and downcast (runtime/sam/expr/function),
// with records dropping missing fields as its vector-based defuse does (the
// one the super command uses for output).

import {
  type Type,
  type TypeArray,
  type TypeContext,
  type TypeEnum,
  type TypeError,
  type TypeMap,
  type TypeOption,
  type TypeRecord,
  type TypeSet,
  type TypeUnion,
  TypeAll,
  TypeMissing,
  TypeNone,
  TypeNull,
  TypeString,
  formatType,
  under,
} from "./types.ts"
import {
  type Value,
  ArrayValue,
  EnumValue,
  ErrorValue,
  MapValue,
  OptionValue,
  RecordValue,
  SetValue,
  StringValue,
  UnionValue,
} from "./values.ts"

const fusionCache = new WeakMap<Type, boolean>()

/** True if a value of type t can contain a fusion value (so defusing changes it). */
export function hasFusion(t: Type): boolean {
  let has = fusionCache.get(t)
  if (has !== undefined) return has
  // Named types are a barrier to defusing.  Mark t first in case it's
  // reached again through a recursive type.
  fusionCache.set(t, false)
  switch (t.kind) {
    case "record":
      has = t.fields.some((f) => hasFusion(f.type))
      break
    case "array":
    case "set":
    case "error":
      has = hasFusion(t.type)
      break
    case "union":
      has = t.types.some(hasFusion)
      break
    case "map":
      has = hasFusion(t.keyType) || hasFusion(t.valType)
      break
    case "fusion":
      has = true
      break
    default:
      has = false
  }
  fusionCache.set(t, has)
  return has
}

class DowncastError extends Error {}

/** Defuses values, creating their types in a context. */
export class Defuser {
  readonly context: TypeContext

  constructor(context: TypeContext) {
    this.context = context
  }

  /**
   * v with every fusion value inside it replaced by its value as its
   * subtype.  Values without fusion values are returned as is.  A value that
   * can't be downcast to its subtype (which means the BSUP was malformed)
   * becomes an error value.
   */
  defuse(v: Value): Value {
    return this.eval(v)
  }

  private errorValue(message: string): Value {
    return new ErrorValue(this.context.error(TypeString), new StringValue(TypeString, message))
  }

  private eval(v: Value): Value {
    const t = v.type
    if (!hasFusion(t)) return v
    const ctx = this.context
    switch (t.kind) {
      case "record": {
        const rec = v as RecordValue
        const fields: { name: string; type: Type }[] = []
        const values: Value[] = []
        t.fields.forEach((f, k) => {
          const fv = this.eval(rec.values[k])
          // A missing field (e.g., of type fusion(string|missing) with
          // subtype missing) isn't in the defused record.
          if (fv.kind === "missing") return
          fields.push({ name: f.name, type: fv.type })
          values.push(fv)
        })
        return new RecordValue(ctx.record(fields), values)
      }
      case "array":
      case "set": {
        const items = (v as ArrayValue | SetValue).items.map((x) => this.eval(x))
        const [elemType, elems] = this.unify(items, TypeNone)
        return t.kind === "array"
          ? new ArrayValue(ctx.array(elemType), elems)
          : new SetValue(ctx.set(elemType), elems)
      }
      case "map": {
        const entries = (v as MapValue).entries
        const keys = entries.map(([k]) => this.eval(k))
        const vals = entries.map(([, x]) => this.eval(x))
        const [keyType, ks] = this.unify(keys, TypeNull)
        const [valType, vs] = this.unify(vals, TypeNull)
        return new MapValue(
          ctx.map(keyType, valType),
          ks.map((k, i) => [k, vs[i]] as const),
        )
      }
      case "union":
        return this.eval((v as UnionValue).value)
      case "error": {
        const inner = this.eval((v as ErrorValue).value)
        return new ErrorValue(ctx.error(inner.type), inner)
      }
      case "fusion": {
        if (v.kind !== "fusion") throw new DowncastError("defuse: expected a fusion value")
        // A fusion(all) value is already decoded as its subtype.
        if (t.type === TypeAll) return v.value
        // A value that can't be downcast (which means the BSUP was
        // malformed) becomes an error, as in the Go implementation.
        try {
          return this.downcast(v.value, v.subtype)
        } catch (e) {
          if (e instanceof DowncastError) return this.errorValue(e.message)
          throw e
        }
      }
      default:
        return v
    }
  }

  // unify gives values one type: theirs if they all have the same one,
  // otherwise the union of their types (with the values tagged).  empty is
  // the type for no values.
  private unify(vals: Value[], empty: Type): [Type, Value[]] {
    if (vals.length === 0) return [empty, vals]
    const types = [...new Set(vals.map((x) => x.type))]
    if (types.length === 1) return [types[0], vals]
    const u = this.context.unionOf(types) as TypeUnion
    return [u, vals.map((x) => new UnionValue(u, u.types.indexOf(x.type), x))]
  }

  // downcast converts v, a value that was fused from a value of type to,
  // back to type to.  It's a port of the Go implementation's vector-based
  // Downcast.downcast for a single value.
  private downcast(v: Value, to: Type): Value {
    if (v.type === to) return v
    const t = v.type
    if (t.kind === "fusion" && t.type === TypeAll && v.kind === "fusion") return v.value
    if (to.kind !== "union" && v.kind === "fusion") {
      const out = this.downcast(v.value, v.subtype)
      if (out.type !== to) throw this.errSubtype(to)
      return out
    }
    if (v.kind === "union") return this.downcast(v.value, to)
    if (v.kind === "option" && under(to).kind !== "option") {
      if (v.value === null) throw new DowncastError(`downcast: none value in non-option type: ${formatType(to)}`)
      return this.downcast(v.value, to)
    }
    switch (to.kind) {
      case "record":
        return this.toRecord(v, to)
      case "array":
      case "set":
        return this.toList(v, to)
      case "map":
        return this.toMap(v, to)
      case "union":
        return this.toUnion(v, to)
      case "option":
        return this.toOption(v, to)
      case "enum":
        return this.toEnum(v, to)
      case "error":
        return this.toError(v, to)
      case "fusion":
        throw new DowncastError("downcast: cannot downcast to a fusion type")
      default:
        throw this.errMismatch(to)
    }
  }

  private toRecord(v: Value, to: TypeRecord): Value {
    if (v.kind !== "record") throw this.errMismatch(to)
    const from = v.recordType
    const values = to.fields.map((tf) => {
      const k = from.indexOf(tf.name)
      if (k < 0) throw this.errSubtype(to)
      return this.downcast(v.values[k], tf.type)
    })
    return new RecordValue(to, values)
  }

  private toList(v: Value, to: TypeArray | TypeSet): Value {
    if (v.kind !== to.kind || (v.kind !== "array" && v.kind !== "set")) throw this.errMismatch(to)
    const items = v.items.map((x) => this.downcast(x, to.type))
    return to.kind === "array" ? new ArrayValue(to, items) : new SetValue(to, items)
  }

  private toMap(v: Value, to: TypeMap): Value {
    if (v.kind !== "map") throw this.errMismatch(to)
    return new MapValue(
      to,
      v.entries.map(([k, x]) => [this.downcast(k, to.keyType), this.downcast(x, to.valType)] as const),
    )
  }

  private toUnion(v: Value, to: TypeUnion): Value {
    // The member is the type of the value once it's defused.
    const d = this.eval(v)
    const tag = subtypeIndex(to.types, d.type)
    if (tag < 0) {
      if (d.kind === "union") return this.downcast(d, to)
      throw this.errSubtype(to)
    }
    const out = this.downcast(d, to.types[tag])
    if (out.type !== to.types[tag]) throw this.errSubtype(to)
    return new UnionValue(to, tag, out)
  }

  private toOption(v: Value, to: TypeOption): Value {
    const u = v.kind === "option" ? v : null
    if (u) return new OptionValue(to, u.value === null ? null : this.downcast(u.value, to.type))
    return new OptionValue(to, this.downcast(v, to.type))
  }

  private toEnum(v: Value, to: TypeEnum): Value {
    if (v.kind !== "enum") throw this.errMismatch(to)
    const i = to.symbols.indexOf(v.symbol)
    if (i < 0) throw this.errMismatch(to)
    return new EnumValue(to, i)
  }

  private toError(v: Value, to: TypeError): Value {
    if (v.kind !== "error") throw this.errMismatch(to)
    return new ErrorValue(to, this.downcast(v.value, to.type))
  }

  private errMismatch(to: Type): DowncastError {
    return new DowncastError(`downcast: type mismatch to ${formatType(to)}`)
  }

  private errSubtype(to: Type): DowncastError {
    return new DowncastError(`downcast: invalid subtype ${formatType(to)}`)
  }
}

function deunion(v: Value): Value {
  while (v.type.kind === "union" && v.kind === "union") v = v.value
  return v
}

// subtypeIndex is the index of t in types, or for a record, of the first
// record type in types that has all of its required fields
// (DowncastSubtypeIndex in Go).
function subtypeIndex(types: readonly Type[], t: Type): number {
  const i = types.indexOf(t)
  if (i >= 0 || t.kind !== "record") return i
  return types.findIndex((m) => m.kind === "record" && hasRequiredFields(t, m))
}

function hasRequiredFields(from: TypeRecord, to: TypeRecord): boolean {
  return from.fields.every((f) => under(f.type).kind === "option" || to.field(f.name)?.type === f.type)
}
