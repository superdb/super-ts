import { test } from "node:test"
import assert from "node:assert/strict"
import {
  TypeContext,
  TypeBool,
  TypeBytes,
  TypeDuration,
  TypeFloat32,
  TypeFloat64,
  TypeInt64,
  TypeInt8,
  TypeIP,
  TypeNet,
  TypeNull,
  TypeString,
  TypeTimestamp,
  TypeType,
  TypeUint16,
  TypeUint64,
  TypeUUID,
  TypeAll,
  type Type,
} from "../src/types.ts"
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
  NetValue,
  NullValue,
  OptionValue,
  RecordValue,
  SetValue,
  StringValue,
  TimestampValue,
  TypeValue,
  UintValue,
  UnionValue,
  UUIDValue,
} from "../src/values.ts"
import { BSUPDecoder, decodeBSUP } from "../src/bsup/decoder.ts"
import { concat, encodeRows, rowFrame, superFooter } from "./helpers/encode.ts"

const ctx = new TypeContext()
const int = (n: number) => new IntValue(TypeInt64, n)
const str = (s: string) => new StringValue(TypeString, s)
const rec = (fields: [string, Value][]) =>
  new RecordValue(
    ctx.record(fields.map(([name, v]) => ({ name, type: v.type }))),
    fields.map(([, v]) => v),
  )

function roundTrip(v: Value): Value {
  const out = decodeBSUP(encodeRows([v]), { context: ctx })
  assert.equal(out.length, 1)
  return out[0]
}

function check(v: Value, sup: string) {
  const got = roundTrip(v)
  assert.equal(got.toString(), sup)
  assert.equal(got.type, v.type, "decoded type should be interned to the same object")
}

test("primitives", () => {
  check(int(1), "1")
  check(int(-5), "-5")
  check(new IntValue(TypeInt8, -1), "-1::int8")
  check(new UintValue(TypeUint64, 18446744073709551615n), "18446744073709551615::uint64")
  check(new IntValue(TypeInt64, -(1n << 63n)), "-9223372036854775808")
  check(new FloatValue(TypeFloat64, 2), "2.")
  check(new FloatValue(TypeFloat64, 1.25), "1.25")
  check(new FloatValue(TypeFloat32, 1.5), "1.5::float32")
  check(new BoolValue(TypeBool, true), "true")
  check(new BytesValue(TypeBytes, Uint8Array.of(1, 2)), "0x0102")
  check(str('a"b\n'), '"a\\"b\\n"')
  check(new IPValue(TypeIP, Uint8Array.of(10, 0, 0, 1)), "10.0.0.1")
  check(new NetValue(TypeNet, Uint8Array.of(10, 0, 0, 0, 255, 0, 0, 0)), "10.0.0.0/8")
  check(new UUIDValue(TypeUUID, new Uint8Array(16)), "00000000-0000-0000-0000-000000000000")
  check(new DurationValue(TypeDuration, 1_500_000_000n), "1.5s")
  check(new TimestampValue(TypeTimestamp, 1704164645123456789n), "2024-01-02T03:04:05.123456789Z")
  check(new NullValue(TypeNull), "null")
  check(new TypeValue(TypeType, ctx.record([{ name: "a", type: TypeInt64 }])), "<{a:int64}>")
})

test("records", () => {
  check(rec([["a", int(1)], ["b", str("x")]]), '{a:1,b:"x"}')
  check(rec([["a", new IntValue(TypeInt8, 1)]]), "{a:1::int8}")
  check(rec([["weird name", int(1)]]), '{"weird name":1}')
  check(rec([["a", rec([["b", int(2)]])]]), "{a:{b:2}}")
  check(new RecordValue(ctx.record([]), []), "{}")
})

test("arrays, sets, and maps", () => {
  check(new ArrayValue(ctx.array(TypeInt64), [int(1), int(2)]), "[1,2]")
  check(new ArrayValue(ctx.array(TypeInt8), [new IntValue(TypeInt8, 1)]), "[1::int8]")
  // A top-level empty array of an implied type isn't decorated (as in Go).
  check(new ArrayValue(ctx.array(TypeInt64), []), "[]")
  check(rec([["a", new ArrayValue(ctx.array(TypeInt64), [])]]), "{a:[]::[int64]}")
  check(new SetValue(ctx.set(TypeString), [str("a"), str("b")]), 'set["a","b"]')
  check(new MapValue(ctx.map(TypeString, TypeInt64), [[str("a"), int(1)]]), 'map{"a":1}')
})

test("unions", () => {
  const u = ctx.union([TypeInt64, TypeString])
  check(new UnionValue(u, 0, int(1)), "1::(int64|string)")
  const arr = ctx.array(u)
  check(new ArrayValue(arr, [new UnionValue(u, 0, int(1)), new UnionValue(u, 1, str("a"))]), '[1,"a"]')
  check(new ArrayValue(arr, [new UnionValue(u, 0, int(1))]), "[1]::[int64|string]")
})

test("named, enum, error, option, and fusion", () => {
  const port = ctx.named("port", TypeUint16)
  check(new UintValue(port, 80), "80::port")
  check(rec([["p", new UintValue(port, 80)]]), "{p:80::port}")
  const e = ctx.enum(["a", "b"])
  check(new EnumValue(e, 1), '"b"::enum(a,b)')
  check(new ErrorValue(ctx.error(TypeString), str("boom")), 'error("boom")')
  const opt = ctx.option(TypeInt64)
  const optRec = ctx.record([{ name: "a", type: opt }])
  check(new RecordValue(optRec, [new OptionValue(opt, int(1))]), "{a?:1}")
  check(new RecordValue(optRec, [new OptionValue(opt, null)]), "{a?:none::int64}")
  check(new OptionValue(opt, int(1)), "some(1)")
  const fa = ctx.fusion(TypeAll)
  check(new FusionValue(fa, new IntValue(TypeInt8, 1), TypeInt8), "1::int8::any")
  const sup = ctx.record([{ name: "a", type: opt }])
  const sub = ctx.record([{ name: "a", type: TypeInt64 }])
  check(
    new FusionValue(ctx.fusion(sup), new RecordValue(sup, [new OptionValue(opt, int(1))]), sub),
    "fusion({a?:1},<{a:int64}>)",
  )
})

test("recursive named type", () => {
  // type node = {value:int64,next:option(node)}
  const node = ctx.namedPlaceholder("node")
  const opt = ctx.option(node)
  const r = ctx.record([
    { name: "value", type: TypeInt64 },
    { name: "next", type: opt },
  ])
  ctx.bindNamed(node, r)
  const leaf = new RecordValue(node, [int(2), new OptionValue(opt, null)])
  const head = new RecordValue(node, [int(1), new OptionValue(opt, leaf)])
  const got = roundTrip(head)
  assert.equal(got.toString(), "{value:1,next?:{value:2}}::node")
  assert.equal(String(got.type), "node")
  const u = (got.type as Type).kind === "named" ? got.type : null
  assert.ok(u)
})

test("record accessors", () => {
  const r = rec([["a", int(1)], ["b", rec([["c", str("x")]])]])
  const got = roundTrip(r) as RecordValue
  assert.equal(got.get("a")?.toString(), "1")
  assert.equal(got.fieldAt([1, 0])?.toString(), '"x"')
  assert.equal(got.getPath(["b", "c"])?.toJS(), "x")
  assert.deepEqual(got.toJS(), { a: 1, b: { c: "x" } })
  assert.deepEqual(
    got.fields.map((f) => f.name),
    ["a", "b"],
  )
})

test("streaming in tiny chunks with control frames", () => {
  const vals = [rec([["a", int(1)]]), rec([["a", int(2)]]), str("hi")]
  const named = ctx.named("QueryChannelSet", ctx.record([{ name: "channel", type: TypeString }]))
  const ctrl = new RecordValue(named, [str("main")])
  const f1 = rowFrame([ctrl], { control: true })
  const f2 = rowFrame(vals)
  const bytes = concat(f1, f2, superFooter(f1.length + f2.length, TypeString))
  const d = new BSUPDecoder({ context: ctx })
  const events = []
  for (let k = 0; k < bytes.length; k++) events.push(...d.push(bytes.subarray(k, k + 1)))
  d.finish()
  assert.deepEqual(
    events.map((e) => e.kind),
    ["control", "values", "superframe"],
  )
  assert.equal(events[0].kind === "control" && events[0].values[0].toString(), '{channel:"main"}::QueryChannelSet')
  assert.equal(events[1].kind === "values" && events[1].values.map(String).join(" "), '{a:1} {a:2} "hi"')
  assert.equal(events[2].kind === "superframe" && String(events[2].fusedType), "string")
})

test("truncated input and bad magic", () => {
  const bytes = encodeRows([int(1)])
  const d = new BSUPDecoder()
  d.push(bytes.subarray(0, 10))
  assert.throws(() => d.finish(), /truncated/)
  assert.throws(() => decodeBSUP(new TextEncoder().encode("{a:1} not bsup")), /magic/)
  const bad = bytes.slice()
  bad[4] = 30 // version 0.30
  assert.throws(() => decodeBSUP(bad), /version mismatch/)
})
