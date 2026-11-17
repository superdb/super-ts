// Compares defusing with super's own output, using fixtures written by
// scripts/gen-fixtures.sh: the fused BSUP that super writes with -fusion,
// and the defused SUP that it writes by default.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { BSUPResults } from "../src/bsup/decoder.ts"
import { Defuser, hasFusion } from "../src/defuse.ts"
import {
  TypeContext,
  TypeInt64,
  TypeMissing,
  TypeString,
  compareTypes,
  type Type,
} from "../src/types.ts"
import { FusionValue, MissingValue, RecordValue, StringValue, UnionValue } from "../src/values.ts"

const dir = new URL("./reference/defuse-out/", import.meta.url)
const names = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith(".fused.bsup"))
      .map((f) => f.slice(0, -".fused.bsup".length))
  : []

for (const name of names) {
  test(`defuse ${name} as super does`, () => {
    const res = new BSUPResults(new Uint8Array(readFileSync(new URL(`${name}.fused.bsup`, dir))))
    assert.ok(res.fusedTypes.some(hasFusion), "the fixture should have fusion values")
    const d = new Defuser(res.context)
    const got = [...res.values()].map((v) => d.defuse(v).toString())
    const want = readFileSync(new URL(`${name}.sup`, dir), "utf8")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("type "))
    assert.deepEqual(got, want)
    // Random access gives the same values.
    for (const i of [res.length - 1, 0, Math.floor(res.length / 2)]) {
      assert.equal(d.defuse(res.get(i)).toString(), want[i])
    }
  })
}

test("defuse drops missing fields and picks union members", () => {
  const ctx = new TypeContext()
  const u = ctx.union([TypeInt64, TypeString, TypeMissing])
  const f = ctx.fusion(u)
  const rec = ctx.record([
    { name: "a", type: f },
    { name: "b", type: f },
  ])
  const v = new RecordValue(rec, [
    new FusionValue(f, new UnionValue(u, 1, new StringValue(TypeString, "x")), TypeString),
    new FusionValue(f, new UnionValue(u, 2, new MissingValue(TypeMissing)), TypeMissing),
  ])
  const out = new Defuser(ctx).defuse(v)
  assert.equal(out.toString(), '{a:"x"}')
  assert.equal(String(out.type), "{a:string}")
})

test("compareTypes orders types as SuperDB does", () => {
  const ctx = new TypeContext()
  const r1 = ctx.record([{ name: "a", type: TypeInt64 }])
  const r2 = ctx.record([
    { name: "a", type: TypeInt64 },
    { name: "b", type: TypeInt64 },
  ])
  const port = ctx.named("port", TypeInt64)
  const types: Type[] = [r2, ctx.array(TypeInt64), TypeString, r1, port, TypeInt64]
  assert.deepEqual(
    [...types].sort(compareTypes).map(String),
    ["port", "int64", "string", "{a:int64}", "{a:int64,b:int64}", "[int64]"],
  )
  assert.equal(String(ctx.unionOf([TypeString, TypeInt64, TypeString])), "int64|string")
})
