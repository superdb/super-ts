// TypeScript types in SuperDB and back.
//
// This reads the book's shapes.json into values of the TypeScript type
// Shape (a discriminated union declared with Zod), writes them as BSUP,
// queries them with the super command, and reads query results back into
// TypeScript.  In SuperDB the shapes aren't JSON documents: they have the
// sum type that the program declared, and they come back as that type.
//
// Run it from the repo root with a super built from the same version of
// SuperDB as this library's BSUP (see BSUP_VERSION):
//
//   node examples/zod-shapes/demo.ts            # finds super on your PATH
//   SUPER=~/repo/super/dist/super node examples/zod-shapes/demo.ts

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as z from "zod"
import { superCodec } from "../../src/zod.ts"
import { Shape, area } from "./shapes.ts"

const SUPER = process.env.SUPER ?? "super"
const dir = mkdtempSync(join(tmpdir(), "zod-shapes-"))
const file = join(dir, "shapes.bsup")

function heading(s: string) {
  console.log(`\n=== ${s}\n`)
}

/** Runs a query on the shapes with the super command and prints its SUP output. */
function sup(query: string) {
  console.log(`$ super -s -c '${query}' shapes.bsup`)
  console.log(execFileSync(SUPER, ["-s", "-c", query, file], { encoding: "utf8" }))
}

/** Like sup but returns the query's output as BSUP. */
function bsup(query: string): Uint8Array {
  console.log(`$ super -f bsup -c '${query}' shapes.bsup`)
  return new Uint8Array(execFileSync(SUPER, ["-f", "bsup", "-c", query, file]))
}

// 1. JSON to TypeScript.  Zod checks each JSON object and gives it the
// type Shape.
const shapes: Shape[] = readFileSync(new URL("./shapes.json", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => Shape.parse(JSON.parse(line)))

// 2. TypeScript to SuperDB.  The codec maps the Zod schema to a super
// type: a union, named Shape, of a named record type for each variant.
const codec = superCodec(Shape)

heading("The super type of the TypeScript type Shape")
console.log(codec.typeDecls())

heading("The shapes as SUP")
console.log(codec.toSUP(shapes))

writeFileSync(file, codec.toBSUP(shapes))

// 3. Query the shapes in SuperDB, where they have the types the program
// gave them.
heading("Queries")
sup("values typeof(this) | head 1")
// A type assertion picks out one variant, and from there on the type
// checker knows that dimensions has a radius.
sup("values this.(Circle) | values {id, radius: dimensions.radius}")
// The name of each value's variant is in its type.
sup("aggregate count() by kind:=nameof(under(this)) | sort kind")
// As an expression, the assertion is none for the other variants, and ?.
// and ?? handle that as they do in TypeScript.  These queries can name the
// type Circle because the file carries its types, which is also how super
// type checks them before they run.
sup("values {id, radius: this.(Circle)?.dimensions?.radius ?? 0}")

// 4. SuperDB to TypeScript.  Query results are decoded as values of the
// schema, so `round` is a Shape[] as far as TypeScript is concerned, too.
heading("Query results back in TypeScript")
const round: Shape[] = codec.fromBSUP(bsup('where type=="Circle" or type=="Square" | sort id'))
for (const shape of round) {
  console.log(`${shape.type} ${shape.id} has area ${area(shape).toFixed(2)}`)
}

// A result that isn't a Shape has a schema of its own.
const Count = z.object({ kind: z.string(), count: z.int() })
const counts = superCodec(Count).fromBSUP(bsup("aggregate count() by kind:=nameof(under(this)) | sort kind"))
console.log(counts)

// 5. And the whole trip loses nothing.
assert.deepEqual(codec.fromBSUP(bsup("sort id")), shapes)
console.log("\nall shapes came back from SuperDB identical to the TypeScript originals")
