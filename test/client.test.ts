import { test } from "node:test"
import assert from "node:assert/strict"
import { TypeContext, TypeInt64, TypeString } from "../src/types.ts"
import { IntValue, RecordValue, StringValue, type Value } from "../src/values.ts"
import { HTTPClient } from "../src/client/http.ts"
import { WasmClient } from "../src/client/wasm.ts"
import { SuperDBError } from "../src/client/result.ts"
import { columnsOf, leafColumnsOf } from "../src/shape.ts"
import { concat, rowFrame, superFooter } from "./helpers/encode.ts"

const ctx = new TypeContext()
const int = (n: number) => new IntValue(TypeInt64, n)
const str = (s: string) => new StringValue(TypeString, s)

function control(name: string, fields: [string, Value][]): Uint8Array {
  const t = ctx.named(name, ctx.record(fields.map(([n, v]) => ({ name: n, type: v.type }))))
  return rowFrame([new RecordValue(t, fields.map(([, v]) => v))], { control: true })
}

function rec(a: number): RecordValue {
  return new RecordValue(ctx.record([{ name: "a", type: TypeInt64 }]), [int(a)])
}

// A response body like the service's: channel control, values, stats, end.
function queryResponse(): Uint8Array {
  const frames = [
    control("QueryChannelSet", [["channel", str("main")]]),
    rowFrame([rec(1), rec(2)]),
    control("QueryChannelSet", [["channel", str("other")]]),
    rowFrame([str("x")]),
    control("QueryWarning", [["warning", str("careful")]]),
    control("QueryChannelEnd", [["channel", str("main")]]),
  ]
  const body = concat(...frames)
  return concat(body, superFooter(body.length))
}

function streamOf(bytes: Uint8Array, chunk = 7): ReadableStream<Uint8Array> {
  let off = 0
  return new ReadableStream({
    pull(c) {
      if (off >= bytes.length) return c.close()
      c.enqueue(bytes.slice(off, off + chunk))
      off += chunk
    },
  })
}

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch
}

test("HTTPClient.query streams values by channel", async () => {
  let seen: { url: string; init: RequestInit } | undefined
  const client = new HTTPClient({
    url: "http://localhost:9867/",
    token: "tok",
    context: ctx,
    fetch: fakeFetch((url, init) => {
      seen = { url, init }
      return new Response(streamOf(queryResponse()), { status: 200 })
    }),
  })
  const result = await client.query("from foo", { args: ["x"] })
  const byChannel = await result.collectByChannel()
  assert.equal(seen?.url, "http://localhost:9867/query?ctrl=T")
  const headers = seen?.init.headers as Record<string, string>
  assert.equal(headers["Accept"], "application/x-bsup")
  assert.equal(headers["Authorization"], "Bearer tok")
  assert.deepEqual(JSON.parse(String(seen?.init.body)), { query: "from foo", args: ["x"] })
  assert.deepEqual(byChannel.get("main")?.map(String), ["{a:1}", "{a:2}"])
  assert.deepEqual(byChannel.get("other")?.map(String), ['"x"'])
  assert.deepEqual(result.warnings, ["careful"])
  assert.deepEqual(result.channels, ["main", "other"])
  assert.deepEqual(result.shapes.map(String), ["{a:int64}", "string"])
})

test("HTTPClient reports service errors", async () => {
  const client = new HTTPClient({
    url: "http://db",
    fetch: fakeFetch(
      () =>
        new Response(JSON.stringify({ type: "Error", kind: "invalid", error: "parse error at line 1" }), {
          status: 400,
        }),
    ),
  })
  await assert.rejects(client.query("from ("), (e: unknown) => {
    assert.ok(e instanceof SuperDBError)
    assert.equal(e.message, "parse error at line 1")
    assert.equal(e.kind, "invalid")
    assert.equal(e.status, 400)
    return true
  })
})

test("a QueryError control message fails the result after earlier values", async () => {
  const body = concat(rowFrame([int(1)]), control("QueryError", [["error", str("boom")]]))
  const client = new HTTPClient({ url: "http://db", fetch: fakeFetch(() => new Response(streamOf(body))) })
  const result = await client.query("values 1")
  const got: string[] = []
  await assert.rejects(
    (async () => {
      for await (const v of result) got.push(String(v))
    })(),
    /boom/,
  )
  assert.deepEqual(got, ["1"])
})

test("WasmClient decodes BSUP from run", async () => {
  const calls: unknown[] = []
  const wasm = {
    async run(args: unknown) {
      calls.push(args)
      return concat(rowFrame([rec(5)]), superFooter(0))
    },
  }
  const client = new WasmClient(wasm, { context: ctx })
  const vals = await (await client.query("values {a:5}", { input: "{a:5}" })).collect()
  assert.deepEqual(vals.map(String), ["{a:5}"])
  assert.deepEqual(calls[0], { program: "values {a:5}", input: "{a:5}", inputFormat: "auto", outputFormat: "bsup" })
  await client.query("values 1")
  assert.equal((calls[1] as { input: unknown }).input, "")
  const bad = new WasmClient({ run: async () => "not bytes" })
  await assert.rejects(bad.query("values 1"), /Uint8Array/)
})

test("columns of a shape", () => {
  const t = ctx.record([
    { name: "a", type: TypeInt64 },
    {
      name: "b",
      type: ctx.record([
        { name: "c", type: TypeString },
        { name: "d", type: TypeInt64 },
      ]),
    },
  ])
  const cols = columnsOf(t)
  assert.deepEqual(
    cols.map((c) => c.path.join(".")),
    ["a", "b"],
  )
  assert.deepEqual(
    leafColumnsOf(t).map((c) => [c.path.join("."), c.indexPath.join(",")]),
    [
      ["a", "0"],
      ["b.c", "1,0"],
      ["b.d", "1,1"],
    ],
  )
  assert.deepEqual(
    columnsOf(TypeString).map((c) => c.path),
    [["this"]],
  )
})
