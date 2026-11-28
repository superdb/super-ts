# super-ts

A TypeScript library for talking to [SuperDB](https://github.com/superdb/super).
It covers:

* the **super-structured type system**: interned `Type` objects, plus a `TypeContext`
  that makes `===` a correct type-equality test,
* **typed values**: one class per kind of value, with accessors suited to inspectors
  and table views,
* a **BSUP encoder** that writes values as row frames, and a SUP writer,
* a **BSUP decoder** for row frames, column frames (dict, const, LZ4, and the
  intcomp integer codecs), control frames, and super footers, which can stream
  input in chunks of any size or give random access to the values of a big
  result, decoding only the values that are asked for,
* **defusing** of fusion values, matching the output of the `super` command,
* a **SUP formatter** that matches the output of `super -f sup`, type decorators
  included,
* **clients** for the SuperDB service (`super db serve`) and for superdb compiled
  to wasm,
* a **[Zod](https://zod.dev) integration** that carries TypeScript types into
  SuperDB and back.

It has no runtime dependencies and runs in browsers and in Node 22.18+.
The Zod integration is a separate entry point, `@superdb/super-ts/zod`, so
Zod is needed only if you import it.

## Quick start

```ts
import { HTTPClient } from "@superdb/super-ts"

const db = new HTTPClient("http://localhost:9867")
const result = await db.query("from logs | count() by kind")
for await (const value of result) {
  console.log(value.toString()) // SUP, e.g. {kind:"error",count:12}
}
```

Decode BSUP bytes directly:

```ts
import { decodeBSUP, decodeBSUPStream } from "@superdb/super-ts"

const values = decodeBSUP(bytes) // Uint8Array -> Value[]

for await (const ev of decodeBSUPStream(response.body!)) {
  if (ev.kind === "values") render(ev.values)
}
```

## Random access to big results

`BSUPResults` reads the frame headers and column-frame locators of BSUP bytes
up front, which is fast, and then decodes values only when you call
`get(i)`. Each segment of a column frame is decompressed and decoded the
first time a value needs it and is then kept in a `SegmentCache`. The cache
drops its least recently used segments once it passes its budget (256 MB by
default), except for what the last two frames read have used. So it can
hold up to two frames' decoded segments, even past the budget, but a frame
bigger than the budget, or a screen that spans two frames, is decoded only
once. This lets a viewer show any part of a result with hundreds of
thousands of values without decoding all of them.

```ts
import { BSUPResults, Defuser } from "@superdb/super-ts"

const results = new BSUPResults(bytes, { context, cacheBytes: 128 << 20 })
results.length        // number of values
results.fusedTypes    // the frames' fused types (e.g., for table columns)
results.warnings      // QueryWarning control messages
const v = results.get(15000)
```

`LazyColumnFrame` and `LazyRowFrame` do the same for a single frame.
`decodeColumnFrame` and `decodeBSUP` decode everything and are built on the
lazy readers.

## Defusing

When super reads heterogeneous data, such as JSON whose values have many
different shapes, it fuses the values into a single supertype. Each place
where values differ becomes a fusion value: the value as the supertype, plus
its original subtype. `super` defuses these on output by default. With
`-fusion`, or from the engine's BSUP, you get them fused. Leaving them fused
is far cheaper to encode and send.

`Defuser.defuse(v)` turns a value containing fusion values back into the
original value. For example, a field of type `fusion(string|missing)` whose
subtype is `missing` drops out of its record. This is a port of super's
downcast, and it's tested against super's own defused output. `hasFusion(t)`
tells you whether a type can contain fusion values.

```ts
const d = new Defuser(results.context)
d.defuse(results.get(i)).toString()   // the same SUP as `super -s`
```

## TypeScript types in SuperDB, with Zod

A TypeScript program's types are algebraic types, and so are SuperDB's.
`@superdb/super-ts/zod` maps a Zod schema to a super type and converts the
schema's values to and from SUP and BSUP. The values aren't flattened into
JSON on the way: a discriminated union arrives in SuperDB as a union of
named record types, is queried as one, and comes back as the same
TypeScript values.

```ts
import * as z from "zod"
import { superCodec } from "@superdb/super-ts/zod"

const Shape = z
  .discriminatedUnion("type", [
    z.object({ id: z.int(), type: z.literal("Rectangle"), dimensions: z.object({ width: z.int(), height: z.int() }) }),
    z.object({ id: z.int(), type: z.literal("Circle"), dimensions: z.object({ radius: z.int() }) }),
    z.object({ id: z.int(), type: z.literal("Vector"), dimensions: z.array(z.int()) }),
  ])
  .meta({ id: "Shape" })
type Shape = z.infer<typeof Shape>

const codec = superCodec(Shape)
codec.typeDecls()
// type Circle={id:int64,type:string,dimensions:{radius:int64}}
// type Rectangle={id:int64,type:string,dimensions:{width:int64,height:int64}}
// type Vector={id:int64,type:string,dimensions:[int64]}
// type Shape=Circle|Rectangle|Vector

codec.toSUP(shapes)
// {id:1,type:"Rectangle",dimensions:{width:2,height:1}}::Rectangle::Shape
// {id:2,type:"Circle",dimensions:{radius:3}}::Circle::Shape
// ...

writeFileSync("shapes.bsup", codec.toBSUP(shapes))
```

In SuperDB the shapes have the program's types, and the query language's
operators on those types read much as TypeScript's do:

```sh
$ super -s -c 'aggregate count() by kind:=nameof(under(this)) | sort kind' shapes.bsup
{kind:"Circle",count:2}
{kind:"Rectangle",count:1}
{kind:"Vector",count:1}
$ super -s -c 'values {id, radius: this.(Circle)?.dimensions?.radius ?? 0}' shapes.bsup
{id:1,radius:0}
{id:2,radius:3}
...
```

The BSUP file carries its types, so a query can refer to `Circle` by name
and super type checks the query against `Shape` before running it. Query
results decode to values of the schema, which Zod checks, so they are typed
in TypeScript as well:

```ts
const circles: Shape[] = codec.fromBSUP(bsupBytes)   // e.g., from `super -f bsup -c ...`

const result = await db.query(`from shapes | where type=="Circle"`)
for await (const v of result) codec.fromValue(v)     // from a client
```

`examples/zod-shapes` is this example in full, using the shapes of the
SuperDB book. `npm run example:zod` runs it with the `super` on your `PATH`
(or `$SUPER`).

How schemas map to super types:

| Zod | Super type |
|---|---|
| `z.object` | record, with an optional field (`name?:type`) for each `.optional()` property |
| `z.discriminatedUnion`, `z.union` | union |
| `z.enum`, a union of string literals | enum |
| `z.literal` | the type of its value, e.g., string |
| `z.string` and its formats | string |
| `z.number` | float64 |
| `z.int`, `z.int32`, `z.uint32`, `z.float32` | int64, int32, uint32, float32 |
| `z.bigint`, `z.int64`, `z.uint64` | int64, int64, uint64 |
| `z.boolean`, `z.date`, `z.null` | bool, timestamp, null |
| `.optional()` | option |
| `.nullable()` | union with null |
| `z.array`, `z.set`, `z.map` | array, set, map |
| `z.record` | map with string (or enum) keys |
| `z.tuple` | record with fields named `"0"`, `"1"`, ... |
| `.meta({ id: "Name" })` | named type `Name` |

Things to know:

* **Names.** A schema with `.meta({ id })` becomes a named type. The members
  of a discriminated union that have no name of their own are named after
  their discriminator values (turn this off with `nameVariants: false`).
  Names matter for unions: SuperDB's type checker treats a named type as
  a unit but fuses the unnamed records of a union into one record with
  fields that may be missing. Recursive schemas must be named.
* **Validation.** By default the codec parses values with the schema before
  encoding (which applies defaults) and after decoding. `validate: false`
  skips both.
* **Decoding is by shape, not by exact type.** `fromValue` looks through
  named types and unions, defuses fusion values, and ignores extra record
  fields, so it accepts what a query returns as long as the schema's
  fields are there.
* **Unsupported.** `.transform()`, `z.custom`, `z.any`, `z.unknown`,
  intersections, loose objects, and tuples with a rest element have no
  type the codec can know (or no super counterpart) and are rejected when
  the codec is made. `.default()`, `.readonly()`, `.catch()`, `.brand()`,
  `z.lazy`, `z.preprocess`, and refinements are fine.
* A `Date` has millisecond precision, so a timestamp finer than that is
  truncated on the way back. An integer too big for a `number` schema is an
  error, not a silent rounding: use `z.int64()`.
* The codec is built on `zod/v4/core`, which the schemas of `zod` 4 (and
  `zod/v4` in Zod 3.25) and `zod/mini` share.

## Encoding

`encodeBSUP(values)` writes values as BSUP row frames with a super footer,
and `formatSUP(values)` writes them as SUP text with a `type` declaration
ahead of the first use of each named type. Both are tested by sending
their output through `super` and getting the same values back.

```ts
import { encodeBSUP, formatSUP } from "@superdb/super-ts"

writeFileSync("values.bsup", encodeBSUP(values))
```

The super footer of a BSUP file holds the fused type of its values, which
SuperDB's type checker uses to check queries on the file. The encoder
knows it when the values all have one type that fusion leaves alone (see
`isFusedType`), as a codec's do when its unions are of named types.
Otherwise it leaves the fused type out, since computing it takes SuperDB's
type fusion, and super checks queries on the file as they run. Pass
`fusedType` if you know it.

## Types

`Type` is a union of classes, each tagged by `kind`:

| kind        | class           | notable members                             |
|-------------|-----------------|---------------------------------------------|
| `primitive` | `TypePrimitive` | `id`, `name` (`"int64"`, `"string"`, ...)   |
| `record`    | `TypeRecord`    | `fields: {name, type}[]`, `field(name)`, `fieldAt(indexPath)` |
| `array`/`set` | `TypeArray`/`TypeSet` | `type` (the element type)          |
| `map`       | `TypeMap`       | `keyType`, `valType`                        |
| `union`     | `TypeUnion`     | `types` (a member's position is its tag)    |
| `enum`      | `TypeEnum`      | `symbols`                                   |
| `error`     | `TypeError`     | `type`                                      |
| `named`     | `TypeNamed`     | `name`, `type`                              |
| `option`    | `TypeOption`    | `type`                                      |
| `fusion`    | `TypeFusion`    | `type` (the supertype)                      |
| `decimal`   | `TypeDecimal`   | `precision`, `scale`                        |

`String(type)` gives SUP type syntax, e.g. `{a:int64,b?:[string]}`.
`compareTypes` orders types the way super does, and `TypeContext.unionOf`
makes a union with its members in super's canonical order. Helpers:
`under(t)` removes names, `recordOf(t)` finds the record under names and
options, and there are predicates such as `isInteger`, `isFloat`, `isNumber`,
and `isContainer`. Primitive singletons are exported as `TypeInt64`,
`TypeString`, and so on.

Types decoded with the same `TypeContext` are interned. Every client creates
one context and shares it across that client's queries, so values with the
same shape have the identical `type` object. A table view can therefore group
rows with a `Map<Type, ...>`.

## Values

Every value has a `type` and a `kind`, and its class follows the type under
any names. For example, a value of type `port=uint16` is a `UintValue` whose
`type` is the named type `port`.

| kind | class | payload |
|------|-------|---------|
| `int`, `uint` | `IntValue`, `UintValue` | `value: number \| bigint` (a number when it's a safe integer) |
| `float` | `FloatValue` | `value: number` |
| `bool`, `string`, `bytes` | `BoolValue`, `StringValue`, `BytesValue` | `value` |
| `ip`, `net`, `uuid` | `IPValue`, `NetValue`, `UUIDValue` | `bytes`; `value` is the text form |
| `timestamp`, `duration` | `TimestampValue`, `DurationValue` | `ns: bigint`; `toDate()`, `toMillis()` |
| `type` | `TypeValue` | `value: Type` |
| `null`, `missing`, `none` | `NullValue`, `MissingValue`, `NoneValue` | — |
| `record` | `RecordValue` | `values`, `fields` (`{name, value}[]`), `get(name)`, `at(k)`, `fieldAt(indexPath)`, `getPath(names)` |
| `array`, `set` | `ArrayValue`, `SetValue` | `items` |
| `map` | `MapValue` | `entries: [key, value][]` |
| `union` | `UnionValue` | `tag`, `value` (the member value) |
| `enum` | `EnumValue` | `index`, `symbol` |
| `error` | `ErrorValue` | `value`, `message` |
| `option` | `OptionValue` | `value: Value \| null` (null is none), `isNone()` |
| `fusion` | `FusionValue` | `value`, `subtype` |
| `unimplemented` | `UnimplementedValue` | `bytes` (reserved types such as `date`) |

All values also have:

* `toString()`: SUP text, with the decorators needed to keep the type, as
  `super -f sup` prints it.
* `toJS()`: a plain JavaScript value (this conversion is lossy).
* `isUnset()`: true for null, missing, none, and option nones. A table can
  render these as empty cells.
* `unwrap()`: removes any option, union, or fusion wrappers.

`formatPrimitive(v)` formats a primitive value without decorators, e.g. for a
table cell.

### Table layout

`columnsOf(shape)` returns a tree of `Column`s (`path`, `indexPath`, `type`,
`children`) for a record type; any other type gets a single column named
`this`. `leafColumnsOf(shape)` flattens nested records. Each column's
`indexPath` works with `record.fieldAt(indexPath)`.

## Clients

Both clients implement `SuperDBClient`:

```ts
interface SuperDBClient {
  readonly context: TypeContext
  query(query: string, opts?: QueryOptions): Promise<QueryResult>
}
```

A `QueryResult` reads the query's BSUP stream and interprets the service's
control messages (`QueryChannelSet`, `QueryChannelEnd`, `QueryStats`,
`QueryWarning`, `QueryError`). Consume it once, in one of these ways:

```ts
for await (const v of result) ...            // all values
for await (const v of result.values("main")) // one channel
await result.collect()                       // Value[]
await result.collectByChannel()              // Map<channel, Value[]>
for await (const ev of result.events()) ...  // values, channel-end, stats, warning
```

As it reads, the result also records `shapes` (the distinct types seen),
`channels`, `warnings`, and `stats`. A `QueryError` sent mid-stream is thrown
as a `SuperDBError` once the values before it have been delivered. Errors
returned before the query starts (e.g., parse errors) are also thrown as
`SuperDBError`, carrying the `status`, `kind`, and `compilationErrors` the
service reports.

### SuperDB service

```ts
const db = new HTTPClient({ url: "http://localhost:9867", token: () => getToken() })
await db.query("from logs | head 10", { args: ["x"], signal })
await db.version()
```

### superdb wasm

```ts
import { WasmClient, loadSuperWasm } from "@superdb/super-ts"

// Go's wasm_exec.js must be loaded first (it defines the global Go class).
const wasm = await loadSuperWasm("/superdb.wasm")
const db = new WasmClient(wasm)
const result = await db.query("count() by kind", { input: file, inputFormat: "json" })
```

`input` can be a string, `Uint8Array`, `Blob`/`File`, or `ReadableStream`.
The client asks the module for `outputFormat: "bsup"`.

> **The wasm module must return BSUP as a `Uint8Array`.** The current
> `book/super-example` module in the super repo returns `buf.String()`, which
> mangles binary output. `WasmClient.runText()` still works with that module
> for text formats. For BSUP, the end of its `run` should look like this:
>
> ```go
> if opts.OutputFormat == "bsup" {
>     out := js.Global().Get("Uint8Array").New(buf.Len())
>     js.CopyBytesToJS(out, buf.Bytes())
>     return out, nil
> }
> return buf.String(), nil
> ```
>
> With that change (built with `GOOS=js GOARCH=wasm`), `WasmClient` has been
> tested end to end in Node with Go 1.27's `lib/wasm/wasm_exec.js`, using
> string, `Uint8Array`, and `Blob` inputs.

## Development

```sh
npm install        # TypeScript and @types/node
npm test           # node --test (runs the TypeScript sources directly)
npm run check      # type check sources and tests
npm run build      # emit dist/
```

The tests check the decoder against three kinds of fixtures:

* `test/intcomp-fixtures.json`: integer streams compressed by the Go
  `github.com/ronanh/intcomp` codec (regenerate with `scripts/intcomp`).
* `test/reference/`: SUP inputs (some taken from `sup/ztests` in the super
  repo), with the BSUP (rows and columns) and SUP output that `super`
  produced from them. The tests decode the BSUP and require that the
  formatted text match super's byte for byte. To regenerate the output with
  your `super` build, run `npm run fixtures` (or `SUPER=/path/to/super npm run fixtures`).
* `test/reference/defuse/`: JSON inputs, with the fused BSUP
  (`super -fusion`) and the defused SUP (`super`) that super produced from
  them. The tests require that defusing the BSUP give super's SUP exactly.
* Hand-built row and column frames (`test/helpers/encode.ts`) for cases that
  are easier to construct directly.

The encoder is tested by decoding the reference BSUP, encoding it again,
and requiring super's SUP once more. `test/zod-super.test.ts` sends the Zod
codec's BSUP and SUP through the `super` command and back; it's skipped
when `super` (or `$SUPER`) isn't there to run.

## Notes and known gaps

* The decoder reads BSUP version 2.x and rejects other major versions, just
  as super does.
* A value is decoded in full when it's asked for. Projections of a value
  (just some of its fields) aren't supported yet. 64-bit integer segments
  are decoded with BigInt, which takes roughly 100–150 ms per 100k values.
* Zone maps in super footers are skipped. Only the fused type is decoded.
* Decimal values and the reserved primitive types decode as
  `UnimplementedValue`.
* In column frames, super (as of 2.0) writes `net` values as an address plus
  a 1-byte prefix length (`netip.Prefix.AppendBinary`), not as the
  address-plus-mask body that the spec describes. The decoder accepts both.
* The encoder writes row frames only, not column frames, and doesn't do
  type fusion (see [Encoding](#encoding)).
