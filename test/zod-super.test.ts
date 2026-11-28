// End-to-end tests of the Zod codec against the super command: values go
// from TypeScript to SuperDB as BSUP and SUP, are queried there, and come
// back as BSUP.  They are skipped unless super (or $SUPER) can be run, and
// it must write the BSUP version that this library reads.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type * as core from "zod/v4/core"
import { type SuperCodec, superCodec } from "../src/zod.ts"
import { Shape } from "../examples/zod-shapes/shapes.ts"
import { Sink, sink } from "./helpers/zod-sink.ts"

const SUPER = process.env.SUPER ?? "super"
const skip = spawnSync(SUPER, ["-version"]).status === 0 ? false : `${SUPER} not found`
const dir = skip ? "" : mkdtempSync(join(tmpdir(), "super-ts-zod-"))

function run(args: string[]): Buffer {
  return execFileSync(SUPER, args, { maxBuffer: 1 << 28 })
}

// The lines of SUP text, with the type declarations first and in order of
// their names, as super and the codec needn't declare types in one order.
function lines(sup: string): string[] {
  const all = sup.split("\n").filter((l) => l !== "")
  return [...all.filter((l) => l.startsWith("type ")).sort(), ...all.filter((l) => !l.startsWith("type "))]
}

function roundTrip<S extends core.$ZodType>(name: string, codec: SuperCodec<S>, values: core.output<S>[]) {
  const want = lines(codec.toSUP(values as core.input<S>[]))
  for (const format of ["bsup", "sup"]) {
    const file = join(dir, `${name}.${format}`)
    writeFileSync(file, format === "bsup" ? codec.toBSUP(values as core.input<S>[]) : codec.toSUP(values as core.input<S>[]))
    // super sees the very values and types that the codec wrote...
    assert.deepEqual(lines(run(["-s", "-c", "pass", file]).toString()), want, format)
    // ...and what it writes back decodes to the original values.
    assert.deepEqual(codec.fromBSUP(new Uint8Array(run(["-f", "bsup", "-c", "pass", file]))), values, format)
  }
}

test("shapes through super", { skip }, () => {
  const shapes = readFileSync(new URL("../examples/zod-shapes/shapes.json", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => Shape.parse(JSON.parse(l)))
  const codec = superCodec(Shape)
  roundTrip("shapes", codec, shapes)

  const file = join(dir, "shapes.bsup")
  const query = (q: string) => codec.fromBSUP(new Uint8Array(run(["-f", "bsup", "-c", q, file])))
  assert.deepEqual(
    query('where type=="Circle"'),
    shapes.filter((s) => s.type === "Circle"),
  )
  // A type assertion yields the variant itself, outside of the union.  The
  // query can name the type because the file's footer has its fused type.
  assert.deepEqual(
    query("values this.(Circle)"),
    shapes.filter((s) => s.type === "Circle"),
  )
  // A query can rebuild a shape as a plain record.
  assert.deepEqual(query("values {dimensions, type, id, extra: 1}"), shapes)
  assert.equal(run(["-s", "-c", "aggregate fuse(this)", file]).toString().trim().split("\n").pop(), "<Shape>")
})

test("every supported schema through super", { skip }, () => {
  roundTrip("sink", superCodec(Sink), sink)
})
