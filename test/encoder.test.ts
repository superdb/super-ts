// Tests of the BSUP encoder and the SUP writer.  The reference fixtures are
// decoded, encoded again, and decoded again, which must give super's own
// SUP text for them.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import {
  TypeContext,
  TypeFloat16,
  TypeInt64,
  TypeNull,
  TypeString,
  type Type,
} from "../src/types.ts"
import { FloatValue, IntValue, MapValue, RecordValue, SetValue, StringValue, type Value } from "../src/values.ts"
import { formatSUP } from "../src/sup.ts"
import { BSUPDecoder, decodeBSUP } from "../src/bsup/decoder.ts"
import { encodeBSUP, isFusedType } from "../src/bsup/encoder.ts"

const dir = new URL("./reference/out/", import.meta.url)
const names = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith(".row.bsup"))
      .map((f) => f.slice(0, -9))
  : []

for (const name of names) {
  test(`encode ${name}`, () => {
    const want = readFileSync(new URL(`${name}.sup`, dir), "utf8")
    const vals = decodeBSUP(new Uint8Array(readFileSync(new URL(`${name}.row.bsup`, dir))))
    // The SUP writer declares named types as super does.
    assert.equal(formatSUP(vals), want)
    const again = decodeBSUP(encodeBSUP(vals, { frameLength: 3 }))
    assert.equal(formatSUP(again), want)
  })
}

const ctx = new TypeContext()
const int = (n: number) => new IntValue(TypeInt64, n)
const str = (s: string) => new StringValue(TypeString, s)

function footerType(bytes: Uint8Array): Type | undefined {
  let fused: Type | undefined
  for (const ev of new BSUPDecoder().push(bytes)) {
    if (ev.kind === "superframe") fused = ev.fusedType
  }
  return fused
}

test("sets and maps are normalized", () => {
  const set = new SetValue(ctx.set(TypeString), [str("b"), str("a"), str("b"), str("")])
  const map = new MapValue(ctx.map(TypeString, TypeInt64), [
    [str("z"), int(1)],
    [str("a"), int(2)],
    [str("z"), int(3)],
  ])
  assert.deepEqual(decodeBSUP(encodeBSUP([set, map])).map(String), ['set["","a","b"]', 'map{"a":2,"z":1}'])
})

test("float16 values", () => {
  for (const f of [0, -0, 1, -2.5, 65504, 2 ** -14, 2 ** -24, Infinity, -Infinity, 0.333251953125]) {
    const [v] = decodeBSUP(encodeBSUP([new FloatValue(TypeFloat16, f)]))
    assert.ok(v.kind === "float" && Object.is(v.value, f), `${f}`)
  }
})

test("the footer has the fused type when it is known", () => {
  const circle = ctx.named("Circle", ctx.record([{ name: "radius", type: TypeInt64 }]))
  const square = ctx.named("Square", ctx.record([{ name: "side", type: TypeInt64 }]))
  const shape = ctx.named("Shape", ctx.unionOf([circle, square]))
  assert.ok(isFusedType(shape))
  assert.ok(isFusedType(ctx.unionOf([circle, square, TypeNull, ctx.array(shape)])))
  // SuperDB fuses two unnamed records in a union into one record.
  const a = ctx.record([{ name: "a", type: TypeInt64 }])
  const b = ctx.record([{ name: "b", type: TypeInt64 }])
  assert.ok(!isFusedType(ctx.unionOf([a, b])))
  assert.ok(!isFusedType(ctx.record([{ name: "x", type: ctx.unionOf([a, b]) }])))

  const rec = (t: Type, v: Value) => new RecordValue(t, [v])
  const same = encodeBSUP([rec(a, int(1)), rec(a, int(2))])
  assert.equal(String(footerType(same)), "{a:int64}")
  // The values' types differ, so their fused type takes type fusion.
  const mixed = encodeBSUP([rec(a, int(1)), rec(b, int(2))])
  assert.equal(footerType(mixed), undefined)
  assert.deepEqual(decodeBSUP(mixed).map(String), ["{a:1}", "{b:2}"])
  assert.equal(String(footerType(encodeBSUP([rec(a, int(1)), rec(b, int(2))], { fusedType: shape }))), "Shape")
})

test("no values", () => {
  assert.deepEqual(decodeBSUP(encodeBSUP([])), [])
})
