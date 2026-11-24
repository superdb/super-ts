// super-ts: a TypeScript library for talking to SuperDB.

export * from "./types.ts"
export * from "./values.ts"
export { formatValue, formatSUP, formatPrimitive, formatTypeValue, namedTypesOf, implied, selfDescribing } from "./sup.ts"
export { formatDuration, formatTimestamp, formatFloat64, formatFloat32, formatIP, formatNet, formatUUID } from "./format.ts"
export { columnsOf, leafColumnsOf, type Column } from "./shape.ts"

export {
  BSUPDecoder,
  decodeBSUP,
  decodeBSUPStream,
  decodeRowFrame,
  decodeSuperFooter,
  readFrameHeader,
  BSUPResults,
  LazyRowFrame,
  toAsyncIterable,
  BSUP_VERSION,
  type BSUPEvent,
  type DecoderOptions,
  type FrameHeader,
  type ResultsOptions,
} from "./bsup/decoder.ts"
export {
  ByteWriter,
  TypeDefsEncoder,
  encodeBSUP,
  encodeBody,
  encodeRowFrame,
  encodeSuperFooter,
  encodeTypeValue,
  isFusedType,
  type EncodeOptions,
} from "./bsup/encoder.ts"
export { decodeColumnFrame, LazyColumnFrame, SegmentCache, type ColumnFrameOptions } from "./bsup/columns.ts"
export { Defuser, hasFusion } from "./defuse.ts"
export { decodeBody } from "./bsup/body.ts"
export { decodeTypeValue, TypeDefs } from "./bsup/typedefs.ts"
export { BSUPFormatError } from "./bsup/reader.ts"

export type { SuperDBClient, QueryOptions, QueryInput } from "./client/client.ts"
export { QueryResult, SuperDBError, DEFAULT_CHANNEL, type QueryEvent, type QueryStats } from "./client/result.ts"
export { HTTPClient, MEDIA_TYPE_BSUP, type HTTPClientOptions } from "./client/http.ts"
export { WasmClient, loadSuperWasm, type SuperWasm, type SuperWasmRunArgs, type WasmClientOptions } from "./client/wasm.ts"
