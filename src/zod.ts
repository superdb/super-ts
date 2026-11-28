// Zod integration: TypeScript values, described by a Zod schema, as
// super-structured values.
//
// A SuperCodec maps a Zod schema to a super type and converts the values
// the schema describes to and from super values, SUP, and BSUP.  Objects
// become records, unions become unions (a discriminated union becomes a
// union of named types), and so on, so data keeps its TypeScript types in
// SuperDB and comes back out of a query as the same TypeScript values.
//
// This module imports Zod and is published as "@superdb/super-ts/zod", so
// the rest of the library has no dependencies.  It uses "zod/v4/core",
// which the schemas of both "zod" and "zod/mini" are built on (Zod 3.25 or
// later).

import * as core from "zod/v4/core"
import {
  type Type,
  type TypeNamed,
  ID,
  TypeBool,
  TypeContext,
  TypeFloat32,
  TypeFloat64,
  TypeInt32,
  TypeInt64,
  TypeNull,
  TypeString,
  TypeTimestamp,
  TypeUint32,
  TypeUint64,
  formatType,
  primitiveTypeByName,
  quotedName,
  under,
} from "./types.ts"
import {
  type Value,
  ArrayValue,
  BoolValue,
  EnumValue,
  FloatValue,
  IntValue,
  MapValue,
  NullValue,
  OptionValue,
  RecordValue,
  SetValue,
  StringValue,
  TimestampValue,
  UintValue,
  UnionValue,
  compactInt,
} from "./values.ts"
import { formatSUP, namedTypesOf } from "./sup.ts"
import { Defuser, hasFusion } from "./defuse.ts"
import { decodeBSUP } from "./bsup/decoder.ts"
import { encodeBSUP, isFusedType } from "./bsup/encoder.ts"

export interface SuperCodecOptions {
  /**
   * The context for the codec's types (default: a new context).  To decode
   * a client's query results, share the client's context.
   */
  context?: TypeContext
  /**
   * Parse values with the schema before encoding them and after decoding
   * them (default true).  Parsing on the way in applies the schema's
   * defaults and reports bad input as a ZodError.  Parsing on the way out
   * checks that what a query returned really is what the schema says.
   */
  validate?: boolean
  /**
   * Name each member of a discriminated union after its discriminator
   * value when the member has no name of its own (default true), so that
   * `z.discriminatedUnion("type", ...)` with members tagged "Circle" and
   * "Square" becomes the union of named types `Circle|Square`.
   */
  nameVariants?: boolean
}

/** An error converting between a Zod schema's values and super values. */
export class SuperZodError extends Error {
  /** Where in the schema or value the problem is. */
  readonly path: readonly (string | number)[]
  constructor(message: string, path: readonly (string | number)[]) {
    super(path.length > 0 ? `${message} at ${formatPath(path)}` : message)
    this.name = "SuperZodError"
    this.path = path
  }
}

function formatPath(path: readonly (string | number)[]): string {
  return path.map((p, k) => (typeof p === "number" ? `[${p}]` : k === 0 ? p : `.${p}`)).join("")
}

/**
 * Converts the values of a Zod schema to and from super values.
 *
 * The schema's super type is `type`.  How Zod schemas map to super types:
 *
 * | Zod | Super type |
 * |---|---|
 * | `z.object` | record, with an optional field for each `.optional()` property |
 * | `z.discriminatedUnion`, `z.union` | union |
 * | `z.enum`, a union of string literals | enum |
 * | `z.literal` | the type of its value (e.g., string) |
 * | `z.string` (and its formats) | string |
 * | `z.number` | float64 |
 * | `z.int`, `z.int32`, `z.uint32`, `z.float32` | int64, int32, uint32, float32 |
 * | `z.bigint`, `z.int64`, `z.uint64` | int64, int64, uint64 |
 * | `z.boolean`, `z.date`, `z.null` | bool, timestamp, null |
 * | `.optional()` | option |
 * | `.nullable()` | union with null |
 * | `z.array`, `z.set`, `z.map` | array, set, map |
 * | `z.record` | map with string (or enum) keys |
 * | `z.tuple` | record with fields named "0", "1", ... |
 * | `.meta({ id })` | a named type |
 *
 * `.default()`, `.readonly()`, `.catch()`, `.brand()`, `z.lazy`, refinements,
 * and `z.preprocess` don't change a schema's type.  Schemas whose output
 * type Zod doesn't know (`.transform()`, `z.custom`, `z.any`) aren't
 * supported and are rejected when the codec is made.
 */
export class SuperCodec<S extends core.$ZodType = core.$ZodType> {
  readonly schema: S
  readonly context: TypeContext
  /** The super type of the schema's values. */
  readonly type: Type
  private readonly root: Node
  private readonly at: (string | number)[]
  private readonly validate: boolean
  private readonly defuser: Defuser

  constructor(schema: S, opts: SuperCodecOptions = {}) {
    this.schema = schema
    this.context = opts.context ?? new TypeContext()
    this.validate = opts.validate ?? true
    const compiler = new Compiler(this.context, opts.nameVariants ?? true)
    this.root = compiler.compile(schema, [])
    this.type = this.root.type
    this.at = compiler.at
    this.defuser = new Defuser(this.context)
  }

  /** The super value of a TypeScript value. */
  toValue(input: core.input<S>): Value {
    const x = this.validate ? core.parse(this.schema, input) : input
    this.at.length = 0
    return this.root.enc(x)
  }

  /**
   * The TypeScript value of a super value, e.g., one from a query result.
   * The value needn't have exactly this codec's type: named types and
   * unions are looked through, fusion values are defused, and extra record
   * fields are ignored, so long as what the schema asks for is there.
   */
  fromValue(value: Value): core.output<S> {
    this.at.length = 0
    const x = this.root.dec(hasFusion(value.type) ? this.defuser.defuse(value) : value)
    return (this.validate ? core.parse(this.schema, x) : x) as core.output<S>
  }

  /** The super values of TypeScript values. */
  toValues(inputs: Iterable<core.input<S>>): Value[] {
    const out: Value[] = []
    for (const input of inputs) out.push(this.toValue(input))
    return out
  }

  /**
   * Values as SUP text, one per line, after the declarations of their
   * named types.
   */
  toSUP(inputs: Iterable<core.input<S>>): string {
    return formatSUP(this.toValues(inputs))
  }

  /** Values as BSUP. */
  toBSUP(inputs: Iterable<core.input<S>>): Uint8Array {
    const fusedType = isFusedType(this.type) ? this.type : undefined
    return encodeBSUP(this.toValues(inputs), { fusedType, context: this.context })
  }

  /** The TypeScript values of BSUP bytes, e.g., the output of a query. */
  fromBSUP(bytes: Uint8Array): core.output<S>[] {
    return decodeBSUP(bytes, { context: this.context }).map((v) => this.fromValue(v))
  }

  /**
   * Declarations of the schema's named types in the syntax that SUP and
   * SuperSQL share, e.g., `type Circle={radius:int64}`, one per line.  A
   * query on a BSUP file from toBSUP can already refer to the types by
   * name, since the file carries them.  A query on input that has no fused
   * type to offer (e.g., a stream) needs these declarations ahead of it.
   */
  typeDecls(): string {
    return namedTypesOf(this.type)
      .map((t) => `type ${quotedName(t.name)}=${formatType(t.type)}\n`)
      .join("")
  }
}

/** Makes a codec for the values of a Zod schema. */
export function superCodec<S extends core.$ZodType>(schema: S, opts?: SuperCodecOptions): SuperCodec<S> {
  return new SuperCodec(schema, opts)
}

/** The super type of the values of a Zod schema. */
export function superType(schema: core.$ZodType, opts?: SuperCodecOptions): Type {
  return new SuperCodec(schema, opts).type
}

// A Node converts the values of one schema.  Its closures read node.type
// when they run, not when they're made, because a node's type isn't known
// until its children are compiled and may then be given a name.
interface Node {
  type: Type
  /** True for an .optional() schema, whose undefined is a missing property. */
  optional?: boolean
  /** True if the node's values are made by another node, so it can't have a name of its own. */
  unnamed?: boolean
  enc(x: unknown): Value
  dec(v: Value): unknown
  /** True if x, as decoded by dec, is a value of this node's schema. */
  accepts(x: unknown): boolean
}

// A schema's definition.  The members of each kind of definition are read
// as Zod's own code reads them.
interface Def {
  type: string
  [key: string]: any
}

const MIN_INT64 = -(1n << 63n)
const MAX_INT64 = (1n << 63n) - 1n
const MAX_UINT64 = (1n << 64n) - 1n

// Type names that would be confusing as the name of a union's variant.
const reservedNames = new Set(["error", "enum", "set", "map", "option", "fusion", "true", "false", "this"])

function defOf(schema: core.$ZodType): Def {
  return schema._zod.def as unknown as Def
}

/** v without any union wrappers. */
function untagged(v: Value): Value {
  while (v.kind === "union") v = v.value
  return v
}

/** v without any union wrappers or the wrapper of an option that has a value. */
function bare(v: Value): Value {
  for (;;) {
    if (v.kind === "union") v = v.value
    else if (v.kind === "option" && v.value !== null) v = v.value
    else return v
  }
}

class Compiler {
  /** The path to the value being converted, for error messages. */
  readonly at: (string | number)[] = []
  private readonly ctx: TypeContext
  private readonly nameVariants: boolean
  private readonly memo = new Map<core.$ZodType, Node>()
  private readonly names = new Map<string, TypeNamed>()
  private readonly variantNames = new Map<core.$ZodType, string>()

  constructor(ctx: TypeContext, nameVariants: boolean) {
    this.ctx = ctx
    this.nameVariants = nameVariants
  }

  compile(schema: core.$ZodType, path: readonly (string | number)[]): Node {
    const hit = this.memo.get(schema)
    if (hit) {
      if (!hit.type) throw new SuperZodError("a recursive schema needs a name: give it one with .meta({ id })", path)
      return hit
    }
    const def = defOf(schema)
    // Wrappers that leave the type of a schema's output alone compile to
    // the node of what they wrap.
    const inner = this.unwrap(def, path)
    if (inner) {
      const node = this.compile(inner, path)
      this.memo.set(schema, node)
      return node
    }
    const node = { accepts: (x: unknown) => core.safeParse(schema, x).success } as Node
    this.memo.set(schema, node)
    const name = this.nameOf(schema)
    if (name === undefined) {
      node.type = this.build(node, schema, def, path)
      return node
    }
    // Give the node its name before compiling what it contains so that a
    // recursive schema can refer to it.
    const placeholder = this.ctx.namedPlaceholder(name)
    node.type = placeholder
    const typ = this.build(node, schema, def, path)
    if (node.unnamed) {
      node.type = typ
      return node
    }
    const named = this.ctx.bindNamed(placeholder, typ)
    const previous = this.names.get(name)
    if (previous && previous !== named) {
      throw new SuperZodError(
        `the name ${JSON.stringify(name)} is used for two types, ${formatType(previous.type)} and ${formatType(named.type)}`,
        path,
      )
    }
    this.names.set(name, named)
    node.type = named
    return node
  }

  private unwrap(def: Def, path: readonly (string | number)[]): core.$ZodType | undefined {
    switch (def.type) {
      case "default":
      case "prefault":
      case "catch":
      case "readonly":
        return def.innerType
      case "lazy":
        return def.getter()
      case "pipe":
        // A pipe's output is that of its second schema, unless that is a
        // transform, whose output type exists only in TypeScript.
        if (defOf(def.out).type === "transform") {
          throw new SuperZodError("can't tell the type of a transform's output: use a schema of the output instead", path)
        }
        return def.out
    }
    return undefined
  }

  private nameOf(schema: core.$ZodType): string | undefined {
    const id = (core.globalRegistry.get(schema) as { id?: unknown } | undefined)?.id
    return typeof id === "string" && id !== "" ? id : this.variantNames.get(schema)
  }

  private fail(message: string): never {
    throw new SuperZodError(message, this.at.slice())
  }

  private unexpected(want: string, x: unknown): never {
    const got = x === null ? "null" : Array.isArray(x) ? "an array" : x instanceof Date ? "a Date" : typeof x
    return this.fail(`expected ${want} but got ${got}`)
  }

  private mismatch(want: string, v: Value): never {
    return this.fail(`expected ${want} but got a value of type ${formatType(v.type)}`)
  }

  // encAt and decAt convert a child value, keeping track of where it is.
  private encAt(node: Node, key: string | number, x: unknown): Value {
    this.at.push(key)
    const v = node.enc(x)
    this.at.pop()
    return v
  }

  private decAt(node: Node, key: string | number, v: Value): unknown {
    this.at.push(key)
    const x = node.dec(v)
    this.at.pop()
    return x
  }

  // build fills in node's enc and dec and returns the type of the schema,
  // not counting its name.
  private build(node: Node, schema: core.$ZodType, def: Def, path: readonly (string | number)[]): Type {
    const ctx = this.ctx
    switch (def.type) {
      case "string":
      case "template_literal":
        return this.primitive(node, TypeString, "string")
      case "number":
        return this.number(node, schema._zod.bag?.format ?? def.format)
      case "bigint":
        return this.primitive(node, (schema._zod.bag?.format ?? def.format) === "uint64" ? TypeUint64 : TypeInt64, "bigint")
      case "boolean":
        return this.primitive(node, TypeBool, "boolean")
      case "date":
        return this.primitive(node, TypeTimestamp, "date")
      case "null":
        return this.primitive(node, TypeNull, "null")
      case "literal":
        return this.literals(node, def.values, false, path)
      case "enum":
        return this.literals(node, enumValues(def.entries), true, path)
      case "object":
        return this.object(node, def, path)
      case "optional": {
        const inner = this.compile(def.innerType, path)
        node.optional = true
        if (inner.optional) {
          // Optional twice over is just optional.
          node.enc = inner.enc
          node.dec = inner.dec
          node.unnamed = true
          return inner.type
        }
        node.enc = (x) => new OptionValue(node.type, x === undefined ? null : inner.enc(x))
        node.dec = (v) => {
          v = untagged(v)
          if (v.kind === "option") return v.value === null ? undefined : inner.dec(v.value)
          return v.kind === "none" || v.kind === "missing" ? undefined : inner.dec(v)
        }
        return ctx.option(inner.type)
      }
      case "nullable": {
        const inner = this.compile(def.innerType, path)
        const nil = { accepts: (x: unknown): boolean => x === null } as Node
        nil.type = this.primitive(nil, TypeNull, "null")
        return this.union(node, [inner, nil], (x) => (x === null ? 1 : 0))
      }
      case "array": {
        const elem = this.compile(def.element, [...path, 0])
        node.enc = (x) => {
          if (!Array.isArray(x)) this.unexpected("an array", x)
          return new ArrayValue(node.type, x.map((e, k) => this.encAt(elem, k, e)))
        }
        node.dec = (v) => {
          v = bare(v)
          if (v.kind !== "array" && v.kind !== "set") this.mismatch("an array", v)
          return v.items.map((e, k) => this.decAt(elem, k, e))
        }
        return ctx.array(elem.type)
      }
      case "set": {
        const elem = this.compile(def.valueType, [...path, 0])
        node.enc = (x) => {
          if (!(x instanceof Set)) this.unexpected("a Set", x)
          return new SetValue(node.type, Array.from(x, (e, k) => this.encAt(elem, k, e)))
        }
        node.dec = (v) => {
          v = bare(v)
          if (v.kind !== "array" && v.kind !== "set") this.mismatch("a set", v)
          return new Set(v.items.map((e, k) => this.decAt(elem, k, e)))
        }
        return ctx.set(elem.type)
      }
      case "map": {
        const key = this.compile(def.keyType, [...path, "(key)"])
        const val = this.compile(def.valueType, [...path, "(value)"])
        node.enc = (x) => {
          if (!(x instanceof Map)) this.unexpected("a Map", x)
          return new MapValue(
            node.type,
            Array.from(x, ([k, e], n) => [this.encAt(key, n, k), this.encAt(val, n, e)] as const),
          )
        }
        node.dec = (v) => {
          v = bare(v)
          if (v.kind !== "map") this.mismatch("a map", v)
          return new Map(v.entries.map(([k, e], n) => [this.decAt(key, n, k), this.decAt(val, n, e)]))
        }
        return ctx.map(key.type, val.type)
      }
      case "record":
        return this.dictionary(node, def, path)
      case "tuple":
        return this.tuple(node, def, path)
      case "union": {
        // A union of string literals is an enum.
        const symbols = stringSymbols(schema)
        if (symbols) return this.enumeration(node, symbols)
        const options = unionOptions(def)
        const pick = this.picker(def, options)
        return this.union(
          node,
          options.map((o, k) => this.compile(o, [...path, `(option ${k})`])),
          pick,
        )
      }
      case "transform":
        throw new SuperZodError("can't tell the type of a transform's output: use a schema of the output instead", path)
      case "any":
      case "unknown":
        throw new SuperZodError(`z.${def.type}() has no type to keep: use a schema that says what the value is`, path)
      case "intersection":
        throw new SuperZodError("intersections aren't supported: build the object with .extend() instead", path)
      default:
        throw new SuperZodError(`z.${def.type}() schemas aren't supported`, path)
    }
  }

  private number(node: Node, format: unknown): Type {
    switch (format) {
      case "safeint":
        return this.primitive(node, TypeInt64, "integer")
      case "int32":
        return this.primitive(node, TypeInt32, "integer")
      case "uint32":
        return this.primitive(node, TypeUint32, "integer")
      case "float32":
        return this.primitive(node, TypeFloat32, "number")
      default:
        return this.primitive(node, TypeFloat64, "number")
    }
  }

  // primitive makes node a converter between a JavaScript primitive (or
  // Date) and a value of the primitive type typ.
  private primitive(
    node: Node,
    typ: Type,
    js: "string" | "number" | "integer" | "bigint" | "boolean" | "date" | "null",
  ): Type {
    switch (js) {
      case "string":
        node.enc = (x) => (typeof x === "string" ? new StringValue(node.type, x) : this.unexpected("a string", x))
        node.dec = (v) => {
          v = bare(v)
          switch (v.kind) {
            case "string":
            case "ip":
            case "net":
            case "uuid":
              return v.value
            case "enum":
              return v.symbol
          }
          return this.mismatch("a string", v)
        }
        break
      case "number":
      case "integer": {
        const unsigned = typ === TypeUint32
        node.enc = (x) => {
          if (typeof x !== "number") this.unexpected("a number", x)
          if (js === "number") return new FloatValue(node.type, x)
          if (!Number.isSafeInteger(x)) this.fail(`expected an integer but got ${x}`)
          return unsigned ? new UintValue(node.type, x) : new IntValue(node.type, x)
        }
        node.dec = (v) => {
          v = bare(v)
          if (v.kind === "float") return v.value
          if (v.kind !== "int" && v.kind !== "uint") this.mismatch("a number", v)
          if (typeof v.value === "bigint") this.fail(`${v.value} is too big for a number: use z.bigint() or z.int64()`)
          return v.value
        }
        break
      }
      case "bigint": {
        const unsigned = typ === TypeUint64
        const [min, max] = unsigned ? [0n, MAX_UINT64] : [MIN_INT64, MAX_INT64]
        node.enc = (x) => {
          if (typeof x !== "bigint") this.unexpected("a bigint", x)
          if (x < min || x > max) this.fail(`${x} doesn't fit in ${unsigned ? "uint64" : "int64"}`)
          return unsigned ? new UintValue(node.type, compactInt(x)) : new IntValue(node.type, compactInt(x))
        }
        node.dec = (v) => {
          v = bare(v)
          if (v.kind === "int" || v.kind === "uint") return BigInt(v.value)
          if (v.kind === "float" && Number.isInteger(v.value)) return BigInt(v.value)
          return this.mismatch("an integer", v)
        }
        break
      }
      case "boolean":
        node.enc = (x) => (typeof x === "boolean" ? new BoolValue(node.type, x) : this.unexpected("a boolean", x))
        node.dec = (v) => {
          v = bare(v)
          return v.kind === "bool" ? v.value : this.mismatch("a bool", v)
        }
        break
      case "date":
        // A Date has millisecond precision and a timestamp nanosecond.
        node.enc = (x) => {
          if (!(x instanceof Date)) this.unexpected("a Date", x)
          if (Number.isNaN(x.getTime())) this.fail("invalid Date")
          return new TimestampValue(node.type, BigInt(x.getTime()) * 1_000_000n)
        }
        node.dec = (v) => {
          v = bare(v)
          return v.kind === "timestamp" ? v.toDate() : this.mismatch("a timestamp", v)
        }
        break
      case "null":
        node.enc = (x) => (x === null ? new NullValue(node.type) : this.unexpected("null", x))
        node.dec = (v) => {
          v = bare(v)
          return v.kind === "null" ? null : this.mismatch("null", v)
        }
        break
    }
    return typ
  }

  private enumeration(node: Node, symbols: readonly string[]): Type {
    const index = new Map(symbols.map((s, k) => [s, k]))
    node.enc = (x) => {
      const k = typeof x === "string" ? index.get(x) : undefined
      if (k === undefined) this.fail(`expected one of ${symbols.join(", ")} but got ${String(x)}`)
      return new EnumValue(node.type, k)
    }
    node.dec = (v) => {
      v = bare(v)
      if (v.kind === "enum") return v.symbol
      return v.kind === "string" ? v.value : this.mismatch("an enum", v)
    }
    return this.ctx.enum(symbols)
  }

  // literals handles a schema whose values are the listed primitives: a
  // literal or an enum.  Strings make an enum, except that a single string
  // literal (e.g., the tag of a discriminated union) is a plain string.
  private literals(node: Node, values: readonly unknown[], isEnum: boolean, path: readonly (string | number)[]): Type {
    if (values.length === 0) throw new SuperZodError("a literal with no values has no type", path)
    if (values.every((x) => typeof x === "string") && (isEnum || values.length > 1)) {
      return this.enumeration(node, [...new Set(values as string[])])
    }
    // Otherwise the type is that of the values, or a union if they differ.
    const float = values.some((x) => typeof x === "number" && !Number.isInteger(x))
    const members: Node[] = []
    const kinds: string[] = []
    const kindOf = (x: unknown) => (x === null ? "null" : typeof x === "bigint" ? "number" : typeof x)
    for (const x of values) {
      const kind = kindOf(x)
      if (kinds.includes(kind)) continue
      const m = { accepts: (y: unknown): boolean => values.includes(y) } as Node
      switch (kind) {
        case "string":
          m.type = this.primitive(m, TypeString, "string")
          break
        case "number":
          m.type = this.primitive(m, float ? TypeFloat64 : TypeInt64, float ? "number" : "integer")
          break
        case "boolean":
          m.type = this.primitive(m, TypeBool, "boolean")
          break
        case "null":
          m.type = this.primitive(m, TypeNull, "null")
          break
        default:
          throw new SuperZodError(`a literal ${kind} has no super type`, path)
      }
      // A number comes back as whichever of the literals it equals, which
      // may be a bigint.
      const { enc, dec } = m
      m.enc = (y) => enc(typeof y === "bigint" ? Number(y) : y)
      m.dec = (v) => {
        const y = dec(v)
        return values.includes(y) ? y : (values.find((lit) => typeof lit === "bigint" && Number(lit) === y) ?? y)
      }
      kinds.push(kind)
      members.push(m)
    }
    return this.union(node, members, (x) => kinds.indexOf(kindOf(x)))
  }

  private object(node: Node, def: Def, path: readonly (string | number)[]): Type {
    if (def.catchall && defOf(def.catchall).type !== "never") {
      throw new SuperZodError("objects with a catchall (z.looseObject) aren't supported: their extra keys have no type", path)
    }
    const shape: Record<string, core.$ZodType> = def.shape
    const fields = Object.keys(shape).map((name) => ({ name, node: this.compile(shape[name], [...path, name]) }))
    node.enc = (x) => {
      if (x === null || typeof x !== "object") this.unexpected("an object", x)
      const obj = x as Record<string, unknown>
      return new RecordValue(
        node.type,
        fields.map((f) => this.encAt(f.node, f.name, obj[f.name])),
      )
    }
    node.dec = (v) => {
      v = bare(v)
      if (v.kind !== "record") this.mismatch("a record", v)
      const obj: Record<string, unknown> = {}
      for (const f of fields) {
        const fv = v.get(f.name)
        if (fv === undefined) {
          if (f.node.optional) continue
          this.fail(`no field ${JSON.stringify(f.name)} in a value of type ${formatType(v.type)}`)
        }
        const x = this.decAt(f.node, f.name, fv)
        if (x === undefined && f.node.optional) continue
        // Assigning to __proto__ would set the object's prototype.
        if (f.name === "__proto__") Object.defineProperty(obj, f.name, { value: x, enumerable: true, writable: true, configurable: true })
        else obj[f.name] = x
      }
      return obj
    }
    return this.ctx.record(fields.map((f) => ({ name: f.name, type: f.node.type })))
  }

  // dictionary handles z.record, an object used as a map from strings.
  private dictionary(node: Node, def: Def, path: readonly (string | number)[]): Type {
    const key = this.compile(def.keyType, [...path, "(key)"])
    const val = this.compile(def.valueType, [...path, "(value)"])
    const kt = under(key.type)
    if (!(kt.kind === "enum" || (kt.kind === "primitive" && kt.id === ID.string))) {
      throw new SuperZodError(`the keys of a z.record must be strings, not ${formatType(key.type)}`, path)
    }
    node.enc = (x) => {
      if (x === null || typeof x !== "object") this.unexpected("an object", x)
      return new MapValue(
        node.type,
        Object.entries(x).map(([k, e]) => [this.encAt(key, k, k), this.encAt(val, k, e)] as const),
      )
    }
    node.dec = (v) => {
      v = bare(v)
      const obj: Record<string, unknown> = {}
      const set = (k: string, x: unknown) => {
        if (k === "__proto__") Object.defineProperty(obj, k, { value: x, enumerable: true, writable: true, configurable: true })
        else obj[k] = x
      }
      if (v.kind === "map") {
        for (const [kv, ev] of v.entries) {
          const k = String(key.dec(kv))
          set(k, this.decAt(val, k, ev))
        }
      } else if (v.kind === "record") {
        for (const f of v.fields) set(f.name, this.decAt(val, f.name, f.value))
      } else {
        this.mismatch("a map", v)
      }
      return obj
    }
    return this.ctx.map(key.type, val.type)
  }

  // A tuple is a record whose fields are named by position, as super has
  // no tuples.
  private tuple(node: Node, def: Def, path: readonly (string | number)[]): Type {
    if (def.rest) throw new SuperZodError("tuples with a rest element aren't supported", path)
    const items = (def.items as core.$ZodType[]).map((s, k) => this.compile(s, [...path, k]))
    node.enc = (x) => {
      if (!Array.isArray(x)) this.unexpected("an array", x)
      return new RecordValue(
        node.type,
        items.map((n, k) => this.encAt(n, k, x[k])),
      )
    }
    node.dec = (v) => {
      v = bare(v)
      if (v.kind === "record") {
        const rec = v
        return items.map((n, k) => {
          const fv = rec.get(String(k))
          if (fv === undefined) return n.optional ? undefined : this.fail(`no field "${k}" in a value of type ${formatType(rec.type)}`)
          return this.decAt(n, k, fv)
        })
      }
      if (v.kind !== "array" || v.items.length !== items.length) this.mismatch(`a tuple of ${items.length}`, v)
      return v.items.map((e, k) => this.decAt(items[k], k, e))
    }
    return this.ctx.record(items.map((n, k) => ({ name: String(k), type: n.type })))
  }

  // picker returns the function that says which option of a union a value
  // belongs to.  It also names the options of a discriminated union after
  // their discriminator values.
  private picker(def: Def, options: readonly core.$ZodType[]): (x: unknown) => number {
    const inOrder = (x: unknown) => options.findIndex((o) => core.safeParse(o, x).success)
    const disc: string | undefined = def.discriminator
    if (disc === undefined) return inOrder
    const byTag = new Map<unknown, number>()
    for (const [k, option] of options.entries()) {
      const tags: Set<unknown> | undefined = option._zod.propValues?.[disc]
      if (!tags || tags.size === 0) return inOrder
      for (const tag of tags) byTag.set(tag, k)
      const [tag] = tags
      if (
        this.nameVariants &&
        tags.size === 1 &&
        typeof tag === "string" &&
        /^[\p{L}_$][\p{L}\p{Nd}_$]*$/u.test(tag) &&
        !reservedNames.has(tag) &&
        !primitiveTypeByName(tag) &&
        defOf(option).type === "object" &&
        !this.memo.has(option)
      ) {
        this.variantNames.set(option, tag)
      }
    }
    return (x) => {
      const tag = x !== null && typeof x === "object" ? (x as Record<string, unknown>)[disc] : undefined
      return byTag.get(tag) ?? -1
    }
  }

  // union makes node a union of members, where pick says which member a
  // TypeScript value belongs to.
  private union(node: Node, members: readonly Node[], pick: (x: unknown) => number): Type {
    // A super union's members are never themselves (unnamed) unions.
    const typ = this.ctx.unionOf(members.flatMap((m) => (m.type.kind === "union" ? m.type.types : [m.type])))
    const tags = typ.kind === "union" ? new Map(typ.types.map((t, k) => [t, k])) : undefined
    // When every member has the same type, that type is the union's type
    // and the members make its values.
    if (!tags) node.unnamed = true
    node.enc = (x) => {
      const m = members[pick(x)]
      if (!m) this.fail("the value isn't any member of the union")
      let v = m.enc(x)
      if (!tags) return v
      if (v.kind === "union" && m.type.kind === "union") v = v.value
      return new UnionValue(node.type, tags.get(v.type)!, v)
    }
    node.dec = (v) => {
      v = bare(v)
      // The name of a value's type says which member it is.  Without one,
      // it is the first member that the value decodes as.
      const name = v.type.kind === "named" ? v.type.name : undefined
      if (name !== undefined) {
        const m = members.find((m) => m.type.kind === "named" && m.type.name === name)
        if (m) return m.dec(v)
      }
      const depth = this.at.length
      for (const m of members) {
        try {
          const x = m.dec(v)
          if (m.accepts(x)) return x
        } catch (e) {
          if (!(e instanceof SuperZodError)) throw e
          this.at.length = depth
        }
      }
      return this.fail(`a value of type ${formatType(v.type)} isn't any member of the union`)
    }
    return typ
  }
}

// The values of an enum's entries, which for a TypeScript numeric enum
// leaves out its reverse mappings (as Zod does).
function enumValues(entries: Record<string, unknown>): unknown[] {
  const numbers = Object.values(entries).filter((v) => typeof v === "number")
  return Object.entries(entries)
    .filter(([k]) => !numbers.includes(Number(k)))
    .map(([, v]) => v)
}

// The options of a union, less any z.never(), which adds no values to it
// (z.partialRecord makes such a union of its key schema).
function unionOptions(def: Def): core.$ZodType[] {
  return (def.options as core.$ZodType[]).filter((o) => defOf(o).type !== "never")
}

// The symbols of a schema that is a union of string literals, or undefined.
function stringSymbols(schema: core.$ZodType): string[] | undefined {
  const def = defOf(schema)
  let values: unknown[]
  switch (def.type) {
    case "literal":
      values = def.values
      break
    case "enum":
      values = enumValues(def.entries)
      break
    case "union": {
      values = []
      for (const option of unionOptions(def)) {
        const symbols = stringSymbols(option)
        if (!symbols) return undefined
        values.push(...symbols)
      }
      break
    }
    default:
      return undefined
  }
  return values.length > 0 && values.every((x) => typeof x === "string") ? [...new Set(values as string[])] : undefined
}
