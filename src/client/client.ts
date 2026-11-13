import type { TypeContext } from "../types.ts"
import type { QueryResult } from "./result.ts"

/** Input data for a query run against superdb wasm (or any client that takes inputs). */
export type QueryInput = string | Uint8Array | Blob | ReadableStream<Uint8Array>

export interface QueryOptions {
  /** Strings bound to the query's `args` constant. */
  args?: string[]
  /** Cancels the query. */
  signal?: AbortSignal
  /** Input data for the query, for clients that run queries over inputs (e.g., wasm). */
  input?: QueryInput
  /** Format of input (e.g., "json", "csv", "parquet"); default is to detect it. */
  inputFormat?: string
}

/**
 * Something that runs SuperSQL queries and returns typed results, e.g., a
 * SuperDB service (HTTPClient) or superdb compiled to wasm (WasmClient).
 */
export interface SuperDBClient {
  /** The type context shared by the results of this client's queries. */
  readonly context: TypeContext
  query(query: string, opts?: QueryOptions): Promise<QueryResult>
}
