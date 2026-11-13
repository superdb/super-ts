// Decoders for the integer codecs of github.com/ronanh/intcomp, which BSUP
// column frames use for segments of 64-bit and unsigned 32-bit integers.
//
// The Go codec writes slices of uint32 or uint64 words, which BSUP stores in
// little-endian byte order.  A stream is a sequence of blocks followed by a
// trailing word (the length of the last block), where each block is either
// delta bit-packed (128 values for 32-bit, 256 for 64-bit) or delta
// variable-byte encoded (fewer than a full bit-packing block).
//
// The 64-bit decoders use BigInt for exact wraparound arithmetic.

const BLOCK32 = 128
const BLOCK64 = 256

function words32(b: Uint8Array): Uint32Array {
  const n = b.byteLength >>> 2
  const out = new Uint32Array(n)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let k = 0; k < n; k++) out[k] = dv.getUint32(k * 4, true)
  return out
}

function words64(b: Uint8Array): BigUint64Array {
  const n = b.byteLength >>> 3
  const out = new BigUint64Array(n)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let k = 0; k < n; k++) out[k] = dv.getBigUint64(k * 8, true)
  return out
}

/** Decodes a segment written by intcomp.CompressUint32. */
export function uncompressUint32(bytes: Uint8Array, count?: number): Uint32Array {
  const words = words32(bytes)
  // Drop the trailing length of the last block.
  const end = words.length > 0 ? words.length - 1 : 0
  let outlen = 0
  for (let p = 0; p < end; p += words[p + 1]) {
    if (words[p + 1] === 0) throw new Error("intcomp: malformed uint32 block")
    outlen += words[p]
  }
  if (count !== undefined && count !== outlen) {
    throw new Error(`intcomp: expected ${count} uint32s but found ${outlen}`)
  }
  const out = new Uint32Array(outlen)
  let o = 0
  for (let p = 0; p < end; ) {
    const n = words[p]
    const inlen = words[p + 1]
    if (n < BLOCK32) varByte32(words, p, inlen, out, o)
    else bitPack32(words, p, n, out, o)
    o += n
    p += inlen
  }
  return out
}

function varByte32(w: Uint32Array, p: number, inlen: number, out: Uint32Array, o: number) {
  const end = p + inlen
  let shiftIn = 24
  let prev = 0
  let delta = 0
  let shiftOut = 0
  for (let q = p + 2; q < end; ) {
    const c = (w[q] >>> shiftIn) & 0xff
    shiftIn -= 8
    if (shiftIn < 0) {
      shiftIn = 24
      q++
    }
    // Go shifts a uint32, so bits past 32 are lost.
    if (shiftOut < 32) delta = (delta + ((c & 0x7f) << shiftOut)) >>> 0
    shiftOut += 7
    if ((c & 0x80) === 0) {
      prev = (delta + prev) >>> 0
      out[o++] = prev
      delta = 0
      shiftOut = 0
    }
  }
}

function bitPack32(w: Uint32Array, p: number, n: number, out: Uint32Array, o: number) {
  let prev = w[p + 2]
  let q = p + 3
  for (let done = 0; done < n; done += BLOCK32) {
    const hdr = w[q++]
    for (let g = 0; g < 4; g++) {
      const shift = 24 - 8 * g
      const sign = (hdr >>> (shift + 7)) & 1
      const bitlen = (hdr >>> shift) & 0x7f
      prev = unpack32(w, q, bitlen, sign === 1, prev, out, o + done + 32 * g)
      q += bitlen
    }
  }
}

function unpack32(w: Uint32Array, q: number, bitlen: number, zigzag: boolean, prev: number, out: Uint32Array, o: number): number {
  if (bitlen === 32) {
    // At full width, the codec stores the values themselves (no deltas).
    for (let k = 0; k < 32; k++) out[o + k] = w[q + k]
    return out[o + 31]
  }
  const mask = (1 << bitlen) - 1
  for (let k = 0; k < 32; k++) {
    let v = 0
    if (bitlen > 0) {
      const pos = k * bitlen
      const word = q + (pos >>> 5)
      const shift = pos & 31
      v = w[word] >>> shift
      if (shift + bitlen > 32) v |= w[word + 1] << (32 - shift)
      v = (v & mask) >>> 0
    }
    if (zigzag) v = (-(v & 1) ^ (v >>> 1)) >>> 0
    prev = (v + prev) >>> 0
    out[o + k] = prev
  }
  return prev
}

/** Decodes a segment written by intcomp.CompressUint64. */
export function uncompressUint64(bytes: Uint8Array, count?: number): BigUint64Array {
  const out = new BigUint64Array(decode64(bytes, false, count))
  return out
}

/** Decodes a segment written by intcomp.CompressInt64. */
export function uncompressInt64(bytes: Uint8Array, count?: number): BigInt64Array {
  const vals = decode64(bytes, true, count)
  const out = new BigInt64Array(vals.length)
  for (let k = 0; k < vals.length; k++) out[k] = BigInt.asIntN(64, vals[k])
  return out
}

const MASK64 = (1n << 64n) - 1n
const wrap64 = (v: bigint) => v & MASK64

// decode64 returns the values as unsigned 64-bit bigints (two's complement
// for signed values).
function decode64(bytes: Uint8Array, signed: boolean, count?: number): bigint[] {
  const w = words64(bytes)
  const end = w.length > 0 ? w.length - 1 : 0
  const out: bigint[] = []
  for (let p = 0; p < end; ) {
    const hdr = w[p]
    const n = Number(hdr & 0xffffffffn)
    const inlen = Number(hdr >> 32n)
    if (inlen === 0) throw new Error("intcomp: malformed 64-bit block")
    if (n < BLOCK64) varByte64(w, p, inlen, out)
    else bitPack64(w, p, n, signed, out)
    p += inlen
  }
  if (count !== undefined && count !== out.length) {
    throw new Error(`intcomp: expected ${count} 64-bit integers but found ${out.length}`)
  }
  return out
}

function varByte64(w: BigUint64Array, p: number, inlen: number, out: bigint[]) {
  const end = p + inlen
  let shiftIn = 56n
  let prev = 0n
  let delta = 0n
  let shiftOut = 0n
  for (let q = p + 1; q < end; ) {
    const c = (w[q] >> shiftIn) & 0xffn
    shiftIn -= 8n
    if (shiftIn < 0n) {
      shiftIn = 56n
      q++
    }
    delta = wrap64(delta + ((c & 0x7fn) << shiftOut))
    shiftOut += 7n
    if ((c & 0x80n) === 0n) {
      prev = wrap64(delta + prev)
      out.push(prev)
      delta = 0n
      shiftOut = 0n
    }
  }
}

function bitPack64(w: BigUint64Array, p: number, n: number, signed: boolean, out: bigint[]) {
  let prev = w[p + 1]
  let q = p + 2
  for (let done = 0; done < n; done += BLOCK64) {
    const hdr = w[q++]
    for (let g = 0; g < 4; g++) {
      const shift = BigInt(24 - 8 * g)
      const sign = Number((hdr >> (shift + 7n)) & 1n)
      const bitlen = Number((hdr >> shift) & 0x7fn)
      // Only the signed codec records trailing zeros.
      const ntz = signed ? Number((hdr >> BigInt(56 - 8 * g)) & 0xffn) : 0
      const width = bitlen - ntz
      prev = unpack64(w, q, width, ntz & 63, sign === 1, prev, out)
      q += width
    }
  }
}

function unpack64(w: BigUint64Array, q: number, width: number, ntz: number, zigzag: boolean, prev: bigint, out: bigint[]): bigint {
  if (width === 64) {
    // At full width, the codec stores the values themselves (no deltas).
    for (let k = 0; k < 64; k++) out.push(w[q + k])
    return w[q + 63]
  }
  const bw = BigInt(width)
  const mask = (1n << bw) - 1n
  const bntz = BigInt(ntz)
  for (let k = 0; k < 64; k++) {
    let v = 0n
    if (width > 0) {
      const pos = k * width
      const word = q + (pos >>> 6)
      const shift = pos & 63
      v = w[word] >> BigInt(shift)
      if (shift + width > 64) v |= w[word + 1] << BigInt(64 - shift)
      v &= mask
    }
    if (zigzag) v = wrap64((v >> 1n) ^ -(v & 1n))
    prev = wrap64((v << bntz) + prev)
    out.push(prev)
  }
  return prev
}
