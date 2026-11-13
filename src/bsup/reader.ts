// A cursor over BSUP bytes.

export class BSUPFormatError extends Error {
  constructor(message: string) {
    super(`malformed BSUP: ${message}`)
    this.name = "BSUPFormatError"
  }
}

const utf8 = new TextDecoder("utf-8")

export function decodeUTF8(b: Uint8Array): string {
  return utf8.decode(b)
}

export class ByteReader {
  readonly buf: Uint8Array
  pos: number
  readonly end: number

  constructor(buf: Uint8Array, pos = 0, end = buf.length) {
    this.buf = buf
    this.pos = pos
    this.end = end
  }

  get remaining(): number {
    return this.end - this.pos
  }

  done(): boolean {
    return this.pos >= this.end
  }

  byte(): number {
    if (this.pos >= this.end) throw new BSUPFormatError("unexpected end of data")
    return this.buf[this.pos++]
  }

  /** A uvarint as a number (throws if it exceeds 2^53). */
  uvarint(): number {
    let result = 0
    let mul = 1
    for (let k = 0; k < 10; k++) {
      const b = this.byte()
      result += (b & 0x7f) * mul
      if ((b & 0x80) === 0) {
        if (result > Number.MAX_SAFE_INTEGER) throw new BSUPFormatError("uvarint too large")
        return result
      }
      mul *= 128
    }
    throw new BSUPFormatError("uvarint too long")
  }

  bytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.end) throw new BSUPFormatError("length out of range")
    const b = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return b
  }

  /** A counted string: a uvarint length followed by UTF-8 bytes. */
  string(): string {
    return decodeUTF8(this.bytes(this.uvarint()))
  }

  /** A length-prefixed value body. */
  value(): Uint8Array {
    return this.bytes(this.uvarint())
  }

  uint32BE(): number {
    const b = this.bytes(4)
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
  }
}

/** Reads a little-endian unsigned integer of up to 8 bytes as a bigint. */
export function readUint64LE(b: Uint8Array, off: number): bigint {
  const dv = new DataView(b.buffer, b.byteOffset + off, 8)
  return dv.getBigUint64(0, true)
}

/** Reads a little-endian uint64 as a number, throwing if it exceeds 2^53. */
export function readSizeLE(b: Uint8Array, off: number): number {
  const v = readUint64LE(b, off)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new BSUPFormatError("size out of range")
  return Number(v)
}

export function readUint32LE(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0
}

/** Decodes an unsigned "counted" integer body (minimal little-endian bytes). */
export function decodeUint(b: Uint8Array): bigint {
  let v = 0n
  for (let k = b.length - 1; k >= 0; k--) v = (v << 8n) | BigInt(b[k])
  return v
}

/** Like decodeUint but returns a number for bodies of up to 6 bytes. */
export function decodeUintNumber(b: Uint8Array): number {
  if (b.length > 6) {
    const v = decodeUint(b)
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new BSUPFormatError("integer too large")
    return Number(v)
  }
  let v = 0
  for (let k = b.length - 1; k >= 0; k--) v = v * 256 + b[k]
  return v
}

const MIN_INT64 = -(1n << 63n)

/** Decodes a signed "counted" integer body. */
export function decodeInt(b: Uint8Array): bigint {
  const u = decodeUint(b)
  if (u & 1n) {
    const m = u >> 1n
    return m === 0n ? MIN_INT64 : -m
  }
  return u >> 1n
}

/** Iterates the length-prefixed values of a container body. */
export function* containerIter(body: Uint8Array): Generator<Uint8Array> {
  const r = new ByteReader(body)
  while (!r.done()) yield r.value()
}
