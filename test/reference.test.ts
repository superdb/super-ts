// Compares the decoder and SUP formatter against the Go implementation
// using fixtures written by scripts/gen-fixtures.sh (npm run fixtures).
// The tests are skipped when the fixtures haven't been generated.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { BSUPResults, decodeBSUP } from "../src/bsup/decoder.ts"

const dir = new URL("./reference/out/", import.meta.url)
const names = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith(".sup"))
      .map((f) => f.slice(0, -4))
  : []

if (names.length === 0) {
  test("reference fixtures (run `npm run fixtures` to generate)", { skip: true }, () => {})
}

function expected(name: string): string[] {
  return readFileSync(new URL(`${name}.sup`, dir), "utf8")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("type "))
}

for (const name of names) {
  for (const layout of ["col", "row"]) {
    const file = new URL(`${name}.${layout}.bsup`, dir)
    if (!existsSync(file)) continue
    test(`reference ${name} (${layout})`, () => {
      const vals = decodeBSUP(new Uint8Array(readFileSync(file)))
      const want = expected(name)
      assert.deepEqual(
        vals.map((v) => v.toString()),
        want,
      )
      // Random access, backwards and with each value decoded from scratch,
      // gives the same values.
      const res = new BSUPResults(new Uint8Array(readFileSync(file)))
      assert.equal(res.length, want.length)
      for (let i = res.length - 1; i >= 0; i--) {
        res.cache.clear()
        assert.equal(res.get(i).toString(), want[i])
      }
    })
  }
}
