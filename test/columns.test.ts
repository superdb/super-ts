import { test } from "node:test"
import assert from "node:assert/strict"
import {
  TypeContext,
  TypeAll,
  TypeBool,
  TypeFloat32,
  TypeFloat64,
  TypeInt64,
  TypeInt8,
  TypeString,
  TypeType,
  TypeUint16,
} from "../src/types.ts"
import { decodeColumnFrame } from "../src/bsup/columns.ts"
import { decodeBSUP } from "../src/bsup/decoder.ts"
import { ColumnFrameBuilder, concat, intcomp64, intcompUint32, superFooter } from "./helpers/encode.ts"

const ctx = new TypeContext()
const enc = new TextEncoder()

// Locator helpers for plain vectors.
function ints(b: ColumnFrameBuilder, vals: (number | bigint)[]) {
  b.loc.byte(0).uvarint(vals.length)
  b.seg(intcomp64(vals))
}

function strings(b: ColumnFrameBuilder, vals: string[]) {
  b.loc.byte(0).uvarint(vals.length)
  const bodies = vals.map((s) => enc.encode(s))
  const offs = [0]
  for (const x of bodies) offs.push(offs[offs.length - 1] + x.length)
  b.seg(concat(...bodies))
  b.seg(intcompUint32(vals.length === 0 ? [] : offs))
}

function f64s(vals: number[]): Uint8Array {
  const out = new Uint8Array(vals.length * 8)
  const dv = new DataView(out.buffer)
  vals.forEach((v, k) => dv.setFloat64(k * 8, v, true))
  return out
}

function decode(frame: Uint8Array): string[] {
  return decodeColumnFrame(ctx, frame).values.map(String)
}

test("record of int64 and string", () => {
  const t = ctx.record([
    { name: "a", type: TypeInt64 },
    { name: "b", type: TypeString },
  ])
  const b = new ColumnFrameBuilder()
  const id = b.vdefs.lookup(t)
  b.loc.byte(0)
  ints(b, [1, -2, 3])
  strings(b, ["x", "", "zz"])
  const frame = b.frame([id], t)
  const { values, fusedType } = decodeColumnFrame(ctx, frame)
  assert.deepEqual(values.map(String), ['{a:1,b:"x"}', '{a:-2,b:""}', '{a:3,b:"zz"}'])
  assert.equal(fusedType, t)
  assert.equal(values[0].type, t)
})

test("dict and const vectors", () => {
  const t = ctx.record([
    { name: "s", type: TypeString },
    { name: "k", type: TypeInt64 },
  ])
  const b = new ColumnFrameBuilder()
  const id = b.vdefs.lookup(t)
  b.loc.byte(0)
  // s: a dict of two distinct strings.
  b.loc.byte(2)
  strings(b, ["red", "blue"])
  b.seg(intcompUint32([2, 2]))
  b.seg(Uint8Array.of(0, 1, 1, 0))
  // k: a const 7.
  b.loc.byte(1).uvarint(4)
  const body = Uint8Array.of(14) // 7 as a signed counted varint
  b.loc.uvarint(body.length + 1).bytes(body)
  assert.deepEqual(decode(b.frame([id], t)), [
    '{s:"red",k:7}',
    '{s:"blue",k:7}',
    '{s:"blue",k:7}',
    '{s:"red",k:7}',
  ])
})

test("empty const vector with no value", () => {
  // What super writes for {a:1}::foo {b:"x"} | tail with -fusion: foo has no values left.
  const foo = ctx.named("foo", ctx.record([{ name: "a", type: TypeInt64 }]))
  const rec = ctx.record([{ name: "b", type: TypeString }])
  const b = new ColumnFrameBuilder()
  // foo: a const of 0 values with a null body
  b.loc.byte(1).uvarint(0).uvarint(0)
  // {b:string}
  b.loc.byte(0)
  strings(b, ["x"])
  const ids = [b.vdefs.lookup(foo), b.vdefs.lookup(rec)]
  assert.deepEqual(decode(b.frame(ids, ctx.union([foo, rec]), intcompUint32([1]))), ['{b:"x"}'])
})

test("options", () => {
  const opt = ctx.option(TypeInt64)
  const t = ctx.record([
    { name: "o", type: opt },
    { name: "n", type: opt },
    { name: "s", type: opt },
  ])
  const b = new ColumnFrameBuilder()
  const id = b.vdefs.lookup(t)
  b.loc.byte(0)
  // o: some, none, some
  b.loc.byte(0).uvarint(3)
  b.seg(intcompUint32([0, 1, 0]))
  ints(b, [1, 3])
  // n: all none
  b.loc.byte(0).uvarint(3)
  b.seg(new Uint8Array(0))
  b.loc.byte(3).uvarint(3)
  // s: all some
  b.loc.byte(0).uvarint(3)
  b.seg(new Uint8Array(0))
  ints(b, [7, 8, 9])
  assert.deepEqual(decode(b.frame([id], t)), [
    "{o?:1,n?:none::int64,s?:7}",
    "{o?:none::int64,n?:none::int64,s?:8}",
    "{o?:3,n?:none::int64,s?:9}",
  ])
})

test("unions with run lengths and with tags", () => {
  const u2 = ctx.union([TypeInt64, TypeString])
  const b = new ColumnFrameBuilder()
  const id = b.vdefs.lookup(u2)
  b.loc.byte(0).uvarint(4)
  // tags [1,0,0,1] as runs: one 1, two 0s, one 1
  b.seg(intcompUint32([1, 2, 1]))
  ints(b, [1, 2])
  strings(b, ["a", "b"])
  assert.deepEqual(decode(b.frame([id], u2)), [
    '"a"::(int64|string)',
    "1::(int64|string)",
    "2::(int64|string)",
    '"b"::(int64|string)',
  ])

  const u3 = ctx.union([TypeInt64, TypeString, TypeBool])
  const c = new ColumnFrameBuilder()
  const id3 = c.vdefs.lookup(u3)
  c.loc.byte(0).uvarint(3)
  c.seg(intcompUint32([2, 0, 1]))
  ints(c, [5])
  strings(c, ["s"])
  c.loc.byte(0).uvarint(1)
  c.seg(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0))
  assert.deepEqual(decode(c.frame([id3], u3)), ["true::(int64|string|bool)", "5::(int64|string|bool)", '"s"::(int64|string|bool)'])
})

test("arrays and maps", () => {
  const arr = ctx.array(TypeInt64)
  const b = new ColumnFrameBuilder()
  const id = b.vdefs.lookup(arr)
  b.loc.byte(0).uvarint(3)
  b.seg(intcompUint32([0, 2, 2, 3]))
  ints(b, [1, 2, 3])
  assert.deepEqual(decode(b.frame([id], arr)), ["[1,2]", "[]", "[3]"])

  const m = ctx.map(TypeString, TypeInt64)
  const c = new ColumnFrameBuilder()
  const mid = c.vdefs.lookup(m)
  c.loc.byte(0).uvarint(2)
  c.seg(intcompUint32([0, 1, 3]))
  strings(c, ["a", "b", "c"])
  ints(c, [1, 2, 3])
  assert.deepEqual(decode(c.frame([mid], m)), ['map{"a":1}', 'map{"b":2,"c":3}'])
})

test("named, error, enum, bool, and float vectors", () => {
  const port = ctx.named("port", TypeUint16)
  const err = ctx.error(TypeString)
  const e = ctx.enum(["lo", "hi"])
  const t = ctx.record([
    { name: "p", type: port },
    { name: "e", type: err },
    { name: "n", type: e },
    { name: "b", type: TypeBool },
    { name: "f", type: TypeFloat64 },
    { name: "g", type: TypeFloat32 },
  ])
  const b = new ColumnFrameBuilder()
  const id = b.vdefs.lookup(t)
  b.loc.byte(0)
  // p: named over a uint16 vector
  b.loc.byte(0)
  ints(b, [80, 443])
  // e: error over a string vector
  b.loc.byte(0)
  strings(b, ["x", "y"])
  // n: enum
  b.loc.byte(0).uvarint(2)
  b.seg(intcomp64([1, 0]))
  // b: bits
  b.loc.byte(0).uvarint(2)
  b.seg(Uint8Array.of(0b01, 0, 0, 0, 0, 0, 0, 0))
  // f, g: binary64 segments
  b.loc.byte(0).uvarint(2)
  b.seg(f64s([1.5, 2]))
  b.loc.byte(0).uvarint(2)
  b.seg(f64s([0.5, 3]))
  const vals = decodeColumnFrame(ctx, b.frame([id], t)).values
  assert.deepEqual(vals.map(String), [
    '{p:80::port,e:error("x"),n:"hi"::enum(lo,hi),b:true,f:1.5,g:0.5::float32}',
    '{p:443::port,e:error("y"),n:"lo"::enum(lo,hi),b:false,f:2.,g:3.::float32}',
  ])
  const p = (vals[0] as import("../src/values.ts").RecordValue).get("p")!
  assert.equal(p.kind, "uint")
  assert.equal(p.type, port)
})

test("type values and fusion(all)", () => {
  const fa = ctx.fusion(TypeAll)
  const t = ctx.record([
    { name: "t", type: TypeType },
    { name: "f", type: fa },
  ])
  const b = new ColumnFrameBuilder()
  const id = b.vdefs.lookup(t)
  const recID = b.tdefs.lookup(ctx.record([{ name: "x", type: TypeInt64 }]))
  const int8ID = b.tdefs.lookup(TypeInt8)
  const strID = b.tdefs.lookup(TypeString)
  b.loc.byte(0)
  b.loc.byte(0).uvarint(2)
  b.seg(intcompUint32([recID, int8ID]))
  // f: an all vector of bodies, then the subtypes
  b.loc.byte(0)
  b.loc.byte(0).uvarint(2)
  b.seg(concat(Uint8Array.of(2), enc.encode("hi")))
  b.seg(intcompUint32([0, 1, 3]))
  b.seg(intcompUint32([int8ID, strID]))
  assert.deepEqual(decode(b.frame([id], t)), ['{t:<{x:int64}>,f:1::int8::any}', '{t:<int8>,f:"hi"::any}'])
})

test("dynamic roots and an LZ4 segment", () => {
  const b = new ColumnFrameBuilder()
  ints(b, [1, 2])
  // A string vector whose bytes segment is LZ4 compressed.
  b.loc.byte(0).uvarint(1)
  b.segLZ4(Uint8Array.of(0x35, 0x61, 0x62, 0x63, 0x03, 0x00, 0x10, 0x21), 13)
  b.seg(intcompUint32([0, 13]))
  const tags = intcompUint32([0, 1, 0])
  const fused = ctx.union([TypeInt64, TypeString])
  const frame = b.frame([TypeInt64.id, TypeString.id], fused, tags)
  assert.deepEqual(decode(frame), ["1", '"abcabcabcabc!"', "2"])
})

test("column frame inside a file with a super footer", () => {
  const t = ctx.record([{ name: "a", type: TypeInt64 }])
  const b = new ColumnFrameBuilder()
  const id = b.vdefs.lookup(t)
  b.loc.byte(0)
  ints(b, [10, 20])
  const frame = b.frame([id], t)
  const file = concat(frame, superFooter(frame.length, t))
  assert.deepEqual(decodeBSUP(file, { context: ctx }).map(String), ["{a:10}", "{a:20}"])
})

test("malformed locators", () => {
  const t = ctx.record([{ name: "a", type: TypeInt64 }])
  const b = new ColumnFrameBuilder()
  const id = b.vdefs.lookup(t)
  b.loc.byte(0)
  b.loc.byte(7) // bad kind
  assert.throws(() => decodeColumnFrame(ctx, b.frame([id], t)), /kind/)
  // A const of no values still needs a valid type.
  const b2 = new ColumnFrameBuilder()
  b2.loc.byte(1).uvarint(0).uvarint(0)
  assert.throws(() => decodeColumnFrame(ctx, b2.frame([999], t)), /type ID 999/)
})
