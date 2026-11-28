import { test } from "node:test"
import assert from "node:assert/strict"
import * as z from "zod"
import { TypeContext, TypeInt64, TypeString } from "../src/types.ts"
import { IntValue, RecordValue, StringValue } from "../src/values.ts"
import { BSUPDecoder } from "../src/bsup/decoder.ts"
import { SuperZodError, superCodec, superType } from "../src/zod.ts"
import { Shape } from "../examples/zod-shapes/shapes.ts"
import { Sink, sink } from "./helpers/zod-sink.ts"

const shapes: Shape[] = [
  { id: 1, type: "Rectangle", dimensions: { width: 2, height: 1 } },
  { id: 2, type: "Circle", dimensions: { radius: 3 } },
  { id: 3, type: "Square", dimensions: { side: 5 } },
  { id: 4, type: "Circle", dimensions: { radius: 7 } },
  { id: 5, type: "Vector", dimensions: [1, 2, 3, 2, 1] },
]

test("a discriminated union is a union of named types", () => {
  const codec = superCodec(Shape)
  assert.equal(String(codec.type), "Shape")
  assert.equal(
    codec.typeDecls(),
    [
      "type Circle={id:int64,type:string,dimensions:{radius:int64}}",
      "type Rectangle={id:int64,type:string,dimensions:{width:int64,height:int64}}",
      "type Square={id:int64,type:string,dimensions:{side:int64}}",
      "type Vector={id:int64,type:string,dimensions:[int64]}",
      "type Shape=Circle|Rectangle|Square|Vector",
      "",
    ].join("\n"),
  )
  assert.equal(
    codec.toSUP(shapes),
    codec.typeDecls() +
      [
        '{id:1,type:"Rectangle",dimensions:{width:2,height:1}}::Rectangle::Shape',
        '{id:2,type:"Circle",dimensions:{radius:3}}::Circle::Shape',
        '{id:3,type:"Square",dimensions:{side:5}}::Square::Shape',
        '{id:4,type:"Circle",dimensions:{radius:7}}::Circle::Shape',
        '{id:5,type:"Vector",dimensions:[1,2,3,2,1]}::Vector::Shape',
        "",
      ].join("\n"),
  )
})

test("shapes survive BSUP", () => {
  const codec = superCodec(Shape)
  const bytes = codec.toBSUP(shapes)
  assert.deepEqual(codec.fromBSUP(bytes), shapes)
  // The file's fused type, which super's type checker uses, is Shape.
  const footer = new BSUPDecoder().push(bytes).find((ev) => ev.kind === "superframe")
  assert.equal(String(footer?.fusedType), "Shape")
})

test("variants keep their own names and can go unnamed", () => {
  const Named = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("a"), x: z.int() }).meta({ id: "Alpha" }),
    z.object({ kind: z.literal("b"), y: z.string() }),
    z.object({ kind: z.literal("string"), z: z.boolean() }),
  ])
  // A variant named after a primitive type would be confusing, so "string" isn't used.
  assert.equal(String(under(superType(Named))), "Alpha|b|{kind:string,z:bool}")
  assert.equal(String(under(superType(Named, { nameVariants: false }))), "Alpha|{kind:string,y:string}|{kind:string,z:bool}")
  const codec = superCodec(Named, { nameVariants: false })
  const vals = [
    { kind: "b" as const, y: "why" },
    { kind: "string" as const, z: true },
    { kind: "a" as const, x: 1 },
  ]
  assert.deepEqual(codec.fromBSUP(codec.toBSUP(vals)), vals)
})

function under(t: ReturnType<typeof superType>) {
  return t.kind === "named" ? t.type : t
}

test("every supported schema survives SUP types and BSUP", () => {
  const codec = superCodec(Sink)
  assert.equal(
    codec.typeDecls(),
    [
      "type A={a:int64}",
      "type B={b:string}",
      "type Tree={value:int64,children:[Tree]}",
      "type Sink={s:string,n:float64,i:int64,i32:int32,u32:uint32,f32:float32,big:int64,u64:uint64,b:bool,when:timestamp," +
        "nothing:null,opt?:string,nul:string|null,nullish?:int64|null,def:string,color:enum(red,green,blue),lit:string," +
        "lits:enum(a,b),mixed:int64|bool|string,onoff:enum(on,off),tags:set[string],scores:map{string:float64}," +
        "dict:map{string:int64},byColor:map{enum(red,green,blue):int64},pair:{\"0\":string,\"1\":int64}," +
        "list:[int64|string],nested:A|B|null,tree:Tree}",
      "",
    ].join("\n"),
  )
  for (const x of sink) {
    assert.deepEqual(codec.fromValue(codec.toValue(x)), x)
  }
  assert.deepEqual(codec.fromBSUP(codec.toBSUP(sink)), sink)
})

test("defaults are applied and input is validated", () => {
  const codec = superCodec(z.object({ name: z.string(), role: z.string().default("user") }))
  assert.equal(String(codec.toValue({ name: "al" })), '{name:"al",role:"user"}')
  assert.throws(() => codec.toValue({ name: 1 } as never), /expected string/i)
  const raw = superCodec(z.object({ n: z.int() }), { validate: false })
  assert.throws(() => raw.toValue({ n: 1.5 }), (e) => e instanceof SuperZodError && /expected an integer but got 1.5 at n/.test(e.message))
})

test("decoding looks through the types a query changes", () => {
  const ctx = new TypeContext()
  const codec = superCodec(Shape, { context: ctx })
  const int = (n: number) => new IntValue(TypeInt64, n)
  const dims = ctx.record([{ name: "radius", type: TypeInt64 }])
  // A circle on its own, as from `values this.(Circle)`.
  const circleType = ctx.named(
    "Circle",
    ctx.record([
      { name: "id", type: TypeInt64 },
      { name: "type", type: TypeString },
      { name: "dimensions", type: dims },
    ]),
  )
  const circle = new RecordValue(circleType, [int(2), new StringValue(TypeString, "Circle"), new RecordValue(dims, [int(3)])])
  assert.deepEqual(codec.fromValue(circle), { id: 2, type: "Circle", dimensions: { radius: 3 } })
  // A record with no name, its fields reordered and one added, as from
  // `values {color:"red", ...this}`.
  const dims2 = ctx.record([{ name: "side", type: TypeInt64 }])
  const loose = ctx.record([
    { name: "color", type: TypeString },
    { name: "dimensions", type: dims2 },
    { name: "type", type: TypeString },
    { name: "id", type: TypeInt64 },
  ])
  const square = new RecordValue(loose, [
    new StringValue(TypeString, "red"),
    new RecordValue(dims2, [int(5)]),
    new StringValue(TypeString, "Square"),
    int(3),
  ])
  assert.deepEqual(codec.fromValue(square), { id: 3, type: "Square", dimensions: { side: 5 } })
  // Something that isn't a shape is an error.
  assert.throws(() => codec.fromValue(int(1)), SuperZodError)
  const bad = new RecordValue(loose, [
    new StringValue(TypeString, "red"),
    new RecordValue(dims2, [int(5)]),
    new StringValue(TypeString, "Circle"),
    int(3),
  ])
  assert.throws(() => codec.fromValue(bad), /isn't any member of the union/)
})

test("integers too big for a number need a bigint schema", () => {
  const big = superCodec(z.object({ n: z.int64() }))
  const bytes = big.toBSUP([{ n: 2n ** 60n }])
  assert.deepEqual(big.fromBSUP(bytes), [{ n: 2n ** 60n }])
  assert.throws(() => superCodec(z.object({ n: z.int() })).fromBSUP(bytes), /too big for a number.* at n/)
})

test("schemas without a known output type are rejected", () => {
  const reject = (schema: z.ZodType, pattern: RegExp) =>
    assert.throws(
      () => superCodec(schema),
      (e) => e instanceof SuperZodError && pattern.test(e.message),
    )
  reject(z.object({ a: z.object({ b: z.string().transform((s) => s.length) }) }), /transform.* at a\.b$/)
  reject(z.object({ a: z.any() }), /z\.any\(\).* at a$/)
  reject(z.looseObject({ a: z.string() }), /catchall/)
  reject(z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })), /intersections/)
  reject(z.tuple([z.string()], z.int()), /rest element/)
  reject(z.record(z.int(), z.string()), /keys of a z.record must be strings/)
  // Preprocessing and pipes into a plain schema are fine: the output type is known.
  assert.equal(String(superType(z.preprocess((x) => Number(x), z.int()))), "int64")
  assert.equal(String(superType(z.string().pipe(z.enum(["a", "b"])))), "enum(a,b)")
})

test("recursive schemas need a name", () => {
  const Anon: z.ZodType = z.object({
    get next() {
      return z.optional(Anon)
    },
  })
  assert.throws(() => superCodec(Anon), /recursive schema needs a name/)
})

test("one name can't mean two types", () => {
  const schema = z.object({
    a: z.discriminatedUnion("t", [z.object({ t: z.literal("X"), n: z.int() }), z.object({ t: z.literal("Y") })]),
    b: z.discriminatedUnion("t", [z.object({ t: z.literal("X"), s: z.string() }), z.object({ t: z.literal("Y") })]),
  })
  assert.throws(() => superCodec(schema), /the name "X" is used for two types.* at b/)
})
