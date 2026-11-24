// A schema that uses every kind of Zod schema the codec supports, with
// some values of it.

import * as z from "zod"

const Color = z.enum(["red", "green", "blue"])

const Tree = z
  .object({
    value: z.int(),
    get children() {
      return z.array(Tree)
    },
  })
  .meta({ id: "Tree" })

export const Sink = z
  .object({
    s: z.string(),
    n: z.number(),
    i: z.int(),
    i32: z.int32(),
    u32: z.uint32(),
    f32: z.float32(),
    big: z.bigint(),
    u64: z.uint64(),
    b: z.boolean(),
    when: z.date(),
    nothing: z.null(),
    opt: z.string().optional(),
    nul: z.string().nullable(),
    nullish: z.int().nullish(),
    def: z.string().default("default"),
    color: Color,
    lit: z.literal("x"),
    lits: z.literal(["a", "b"]),
    mixed: z.literal([1, "one", true]),
    onoff: z.union([z.literal("on"), z.literal("off")]),
    tags: z.set(z.string()),
    scores: z.map(z.string(), z.number()),
    dict: z.record(z.string(), z.int()),
    byColor: z.partialRecord(Color, z.int()),
    pair: z.tuple([z.string(), z.int()]),
    list: z.array(z.union([z.string(), z.int()])),
    nested: z.union([z.object({ a: z.int() }).meta({ id: "A" }), z.object({ b: z.string() }).meta({ id: "B" }), z.null()]),
    tree: Tree,
  })
  .meta({ id: "Sink" })

export type Sink = z.infer<typeof Sink>

// Sets and maps are written in the order super keeps them in, so that
// super's SUP for these values is the same text as the codec's.
export const sink: Sink[] = [
  {
    s: "hello",
    n: 1.5,
    i: -42,
    i32: -7,
    u32: 4000000000,
    f32: 0.25,
    big: -(2n ** 62n),
    u64: 2n ** 64n - 1n,
    b: true,
    when: new Date("2026-11-24T13:32:00.123Z"),
    nothing: null,
    opt: "here",
    nul: "not null",
    nullish: 7,
    def: "set",
    color: "green",
    lit: "x",
    lits: "b",
    mixed: "one",
    onoff: "off",
    tags: new Set(["a", "b"]),
    scores: new Map([
      ["x", 1.5],
      ["y", 2],
    ]),
    dict: { one: 1, two: 2 },
    byColor: { red: 1, blue: 3 },
    pair: ["left", 2],
    list: ["a", 1, "b", 2],
    nested: { a: 1 },
    tree: { value: 1, children: [{ value: 2, children: [] }, { value: 3, children: [{ value: 4, children: [] }] }] },
  },
  {
    s: "",
    n: -0.001,
    i: 9007199254740991,
    i32: 2147483647,
    u32: 0,
    f32: -1024,
    big: 12n,
    u64: 0n,
    b: false,
    when: new Date(0),
    nothing: null,
    nul: null,
    nullish: null,
    def: "default",
    color: "red",
    lit: "x",
    lits: "a",
    mixed: 1,
    onoff: "on",
    tags: new Set(),
    scores: new Map(),
    dict: {},
    byColor: {},
    pair: ["", 0],
    list: [],
    nested: null,
    tree: { value: 0, children: [] },
  },
  {
    s: 'quote " and \\ and é世',
    n: 1e21,
    i: 0,
    i32: 0,
    u32: 1,
    f32: 3,
    big: 2n ** 63n - 1n,
    u64: 1n,
    b: true,
    when: new Date("1969-12-31T23:59:59.999Z"),
    nothing: null,
    nul: "x",
    def: "d",
    color: "blue",
    lit: "x",
    lits: "a",
    mixed: true,
    onoff: "on",
    tags: new Set(["only"]),
    scores: new Map([["k", -1]]),
    dict: { k: 0 },
    byColor: { green: 2 },
    pair: ["p", -1],
    list: [0],
    nested: { b: "bee" },
    tree: { value: 5, children: [] },
  },
]
