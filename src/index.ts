// super-ts: a TypeScript library for talking to SuperDB.

export * from "./types.ts"
export * from "./values.ts"
export { formatValue, formatPrimitive, formatTypeValue, implied, selfDescribing } from "./sup.ts"
export { formatDuration, formatTimestamp, formatFloat64, formatFloat32, formatIP, formatNet, formatUUID } from "./format.ts"
export { columnsOf, leafColumnsOf, type Column } from "./shape.ts"

export {
  BSUPDecoder,
  decodeBSUP,
  decodeBSUPStream,
  decodeRowFrame,
  decodeSuperFooter,
  toAsyncIterable,
  BSUP_VERSION,
  type BSUPEvent,
  type DecoderOptions,
} from "./bsup/decoder.ts"
export { decodeColumnFrame } from "./bsup/columns.ts"
export { decodeBody } from "./bsup/body.ts"
export { decodeTypeValue, TypeDefs } from "./bsup/typedefs.ts"
export { BSUPFormatError } from "./bsup/reader.ts"

export type { SuperDBClient, QueryOptions, QueryInput } from "./client/client.ts"
export { QueryResult, SuperDBError, DEFAULT_CHANNEL, type QueryEvent, type QueryStats } from "./client/result.ts"
export { HTTPClient, MEDIA_TYPE_BSUP, type HTTPClientOptions } from "./client/http.ts"
export { WasmClient, loadSuperWasm, type SuperWasm, type SuperWasmRunArgs, type WasmClientOptions } from "./client/wasm.ts"
