// Query results.
//
// A QueryResult turns the BSUP stream of a query into values grouped by the
// query's output channels, interpreting the control messages that the
// SuperDB service interleaves with the values (channel changes, stats,
// warnings, and errors).

import type { Type } from "../types.ts"
import type { Value } from "../values.ts"
import type { BSUPEvent } from "../bsup/decoder.ts"

/** The channel of values not preceded by any channel control message. */
export const DEFAULT_CHANNEL = "main"

export interface QueryStats {
  startTime?: Date
  updateTime?: Date
  bytesScanned?: number
  valuesScanned?: number
  framesScanned?: number
  [key: string]: unknown
}

export type QueryEvent =
  /** A batch of values on a channel. */
  | { kind: "values"; channel: string; values: Value[] }
  /** A channel has produced all of its values. */
  | { kind: "channel-end"; channel: string }
  /** Progress statistics for the query. */
  | { kind: "stats"; stats: QueryStats }
  /** A warning from the query. */
  | { kind: "warning"; warning: string }
  /** A control message this library doesn't interpret. */
  | { kind: "control"; value: Value }

/** An error reported by SuperDB, either before or while running a query. */
export class SuperDBError extends Error {
  /** The kind of error reported by the service (e.g., "invalid"). */
  readonly kind: string | undefined
  /** HTTP status, for errors returned by the service before a query runs. */
  readonly status: number | undefined
  /** Compilation errors with source positions, when the service provides them. */
  readonly compilationErrors: unknown[] | undefined

  constructor(message: string, opts: { kind?: string; status?: number; compilationErrors?: unknown[] } = {}) {
    super(message)
    this.name = "SuperDBError"
    this.kind = opts.kind
    this.status = opts.status
    this.compilationErrors = opts.compilationErrors
  }
}

function controlName(v: Value): string | undefined {
  return v.type.kind === "named" ? v.type.name : undefined
}

function camel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
}

function statsFrom(v: Value): QueryStats {
  const stats: QueryStats = {}
  const flatten = (obj: Record<string, unknown>) => {
    for (const [k, x] of Object.entries(obj)) {
      if (x && typeof x === "object" && !(x instanceof Date) && !Array.isArray(x)) {
        flatten(x as Record<string, unknown>)
      } else {
        stats[camel(k)] = typeof x === "bigint" ? Number(x) : x
      }
    }
  }
  const js = v.toJS()
  if (js && typeof js === "object") flatten(js as Record<string, unknown>)
  return stats
}

function stringField(v: Value, name: string): string | undefined {
  const u = v.unwrap()
  if (u.kind !== "record") return undefined
  const f = u.get(name)?.unwrap()
  return f?.kind === "string" ? f.value : undefined
}

/**
 * The result of a query.  Consume it once, either as an async iterable of
 * values (all channels), with values(channel), with events(), or with
 * collect().
 */
export class QueryResult implements AsyncIterable<Value> {
  /** Warnings received so far. */
  readonly warnings: string[] = []
  /** Channels seen so far, in order of first appearance. */
  readonly channels: string[] = []
  /** The most recent query stats, if the service sent any. */
  stats: QueryStats | undefined
  /** The distinct types of the values received so far, in order of appearance. */
  readonly shapes: Type[] = []

  private source: AsyncIterable<BSUPEvent>
  private abortFn: (() => void) | undefined
  private consumed = false
  private shapeSet = new Set<Type>()
  private channel = DEFAULT_CHANNEL

  constructor(source: AsyncIterable<BSUPEvent>, abort?: () => void) {
    this.source = source
    this.abortFn = abort
  }

  /** Stops the query (if it's still running). */
  abort(): void {
    this.abortFn?.()
  }

  /** The query's events in order.  Throws a SuperDBError if the query fails. */
  async *events(): AsyncGenerator<QueryEvent> {
    if (this.consumed) throw new Error("QueryResult can be consumed only once")
    this.consumed = true
    for await (const ev of this.source) {
      if (ev.kind === "values") {
        for (const v of ev.values) {
          if (!this.shapeSet.has(v.type)) {
            this.shapeSet.add(v.type)
            this.shapes.push(v.type)
          }
        }
        this.noteChannel(this.channel)
        yield { kind: "values", channel: this.channel, values: ev.values }
      } else if (ev.kind === "control") {
        for (const v of ev.values) {
          const e = this.control(v)
          if (e) yield e
        }
      }
    }
  }

  private noteChannel(channel: string) {
    if (!this.channels.includes(channel)) this.channels.push(channel)
  }

  private control(v: Value): QueryEvent | null {
    switch (controlName(v)) {
      case "QueryChannelSet":
        this.channel = stringField(v, "channel") ?? DEFAULT_CHANNEL
        return null
      case "QueryChannelEnd": {
        const channel = stringField(v, "channel") ?? DEFAULT_CHANNEL
        this.noteChannel(channel)
        return { kind: "channel-end", channel }
      }
      case "QueryStats":
        this.stats = statsFrom(v)
        return { kind: "stats", stats: this.stats }
      case "QueryWarning": {
        const warning = stringField(v, "warning") ?? v.toString()
        this.warnings.push(warning)
        return { kind: "warning", warning }
      }
      case "QueryError":
        throw new SuperDBError(stringField(v, "error") ?? v.toString())
    }
    return { kind: "control", value: v }
  }

  /** The values of one channel, or of all channels if channel is omitted. */
  async *values(channel?: string): AsyncGenerator<Value> {
    for await (const ev of this.events()) {
      if (ev.kind === "values" && (channel === undefined || ev.channel === channel)) yield* ev.values
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Value> {
    return this.values()
  }

  /** Reads all values (of all channels, or of one channel). */
  async collect(channel?: string): Promise<Value[]> {
    const out: Value[] = []
    for await (const v of this.values(channel)) out.push(v)
    return out
  }

  /** Reads all values grouped by channel. */
  async collectByChannel(): Promise<Map<string, Value[]>> {
    const out = new Map<string, Value[]>()
    for await (const ev of this.events()) {
      if (ev.kind !== "values") continue
      let vals = out.get(ev.channel)
      if (!vals) out.set(ev.channel, (vals = []))
      for (const v of ev.values) vals.push(v)
    }
    return out
  }
}

