// LZ4 block format decompression
// (https://github.com/lz4/lz4/blob/master/doc/lz4_Block_format.md).

/** Decompresses an LZ4 block into a buffer of exactly outLen bytes. */
export function lz4Uncompress(src: Uint8Array, outLen: number): Uint8Array {
  const dst = new Uint8Array(outLen)
  let s = 0
  let d = 0
  while (s < src.length) {
    const token = src[s++]
    let litLen = token >>> 4
    if (litLen === 15) {
      let b: number
      do {
        if (s >= src.length) throw new Error("lz4: truncated literal length")
        b = src[s++]
        litLen += b
      } while (b === 255)
    }
    if (s + litLen > src.length || d + litLen > outLen) throw new Error("lz4: literal out of range")
    dst.set(src.subarray(s, s + litLen), d)
    s += litLen
    d += litLen
    if (s >= src.length) break // The last sequence has only literals.
    if (s + 2 > src.length) throw new Error("lz4: truncated match offset")
    const offset = src[s] | (src[s + 1] << 8)
    s += 2
    if (offset === 0 || offset > d) throw new Error("lz4: bad match offset")
    let matchLen = token & 0x0f
    if (matchLen === 15) {
      let b: number
      do {
        if (s >= src.length) throw new Error("lz4: truncated match length")
        b = src[s++]
        matchLen += b
      } while (b === 255)
    }
    matchLen += 4
    if (d + matchLen > outLen) throw new Error("lz4: match out of range")
    // Copy byte by byte since the match may overlap its output.
    let m = d - offset
    for (let k = 0; k < matchLen; k++) dst[d++] = dst[m++]
  }
  if (d !== outLen) throw new Error(`lz4: got ${d} bytes, expected ${outLen}`)
  return dst
}
