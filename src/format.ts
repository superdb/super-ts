// Text formatting of primitive values, matching the SUP output of the Go
// implementation of SuperDB.

const NS_PER_SEC = 1_000_000_000n

const durationUnits: [string, bigint][] = [
  ["y", 365n * 24n * 3600n * NS_PER_SEC],
  ["d", 24n * 3600n * NS_PER_SEC],
  ["h", 3600n * NS_PER_SEC],
  ["m", 60n * NS_PER_SEC],
]

const MIN_INT64 = -(1n << 63n)

/** Formats a duration in nanoseconds, e.g., `1h2m3.5s`. */
export function formatDuration(ns: bigint): string {
  if (ns === MIN_INT64) return "-292y171d23h47m16.854775808s"
  if (ns === 0n) return "0s"
  let out = ""
  if (ns < 0n) {
    ns = -ns
    out = "-"
  }
  for (const [name, size] of durationUnits) {
    if (ns >= size) {
      const n = ns / size
      ns -= n * size
      if (n > 0n) out += `${n}${name}`
      if (ns === 0n) return out
    }
  }
  if (ns % NS_PER_SEC === 0n) return out + `${ns / NS_PER_SEC}s`
  if (ns > NS_PER_SEC) return out + fixedPoint(ns, NS_PER_SEC) + "s"
  if (ns % 1_000_000n === 0n) return out + `${ns / 1_000_000n}ms`
  if (ns > 1_000_000n) return out + fixedPoint(ns, 1_000_000n) + "ms"
  if (ns % 1_000n === 0n) return out + `${ns / 1_000n}us`
  if (ns > 1_000n) return out + fixedPoint(ns, 1_000n) + "us"
  return out + `${ns}ns`
}

function fixedPoint(ns: bigint, scale: bigint): string {
  const v = ns / scale
  let frac = (ns - v * scale).toString().padStart(scale.toString().length - 1, "0")
  frac = frac.replace(/0+$/, "")
  return `${v}.${frac}`
}

/** Formats nanoseconds since the Unix epoch as RFC 3339 in UTC, e.g., `2024-01-02T03:04:05.123Z`. */
export function formatTimestamp(ns: bigint): string {
  let sec = ns / NS_PER_SEC
  let frac = ns % NS_PER_SEC
  if (frac < 0n) {
    frac += NS_PER_SEC
    sec -= 1n
  }
  const d = new Date(Number(sec) * 1000)
  if (Number.isNaN(d.getTime())) return `${ns}`
  const year = d.getUTCFullYear()
  const yyyy = year < 0 ? "-" + String(-year).padStart(4, "0") : String(year).padStart(4, "0")
  const pad = (n: number) => String(n).padStart(2, "0")
  let s = `${yyyy}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  if (frac !== 0n) s += "." + frac.toString().padStart(9, "0").replace(/0+$/, "")
  return s + "Z"
}

/**
 * Formats a float64 as Go's strconv.FormatFloat(f, 'g', -1, 64) does, except
 * that integral values are written with a trailing dot (e.g., `1.`) as in SUP.
 */
export function formatFloat64(f: number): string {
  if (isIntegral(f)) return `${BigInt(f)}.`
  return formatG(f, shortestDigits64(f))
}

/** Like formatFloat64 for a float32 (or float16) value. */
export function formatFloat32(f: number): string {
  if (isIntegral(f)) return `${BigInt(f)}.`
  return formatG(f, shortestDigits32(f))
}

const TWO63 = 2 ** 63

function isIntegral(f: number): boolean {
  // Matches Go's f == float64(int64(f)) on amd64, where an out-of-range
  // conversion yields math.MinInt64.
  return Number.isInteger(f) && f >= -TWO63 && f < TWO63
}

// Returns the shortest decimal digits and exponent (as in d.ddd × 10^exp)
// that round-trip to f.
function shortestDigits64(f: number): [string, number] {
  const [m, e] = Math.abs(f).toExponential().split("e")
  return [m.replace(".", ""), Number(e)]
}

function shortestDigits32(f: number): [string, number] {
  const a = Math.abs(f)
  for (let p = 1; p <= 9; p++) {
    const s = a.toExponential(p - 1)
    if (Math.fround(Number(s)) === Math.fround(a)) {
      const [m, e] = s.split("e")
      return [m.replace(".", "").replace(/0+$/, "") || "0", Number(e)]
    }
  }
  return shortestDigits64(a)
}

function formatG(f: number, [digits, exp]: [string, number]): string {
  if (Number.isNaN(f)) return "NaN"
  if (f === Infinity) return "+Inf"
  if (f === -Infinity) return "-Inf"
  const sign = f < 0 || Object.is(f, -0) ? "-" : ""
  // For the shortest format, Go uses %e when exp < -4 || exp >= 6.
  if (exp < -4 || exp >= 6) {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
    const es = exp < 0 ? "-" : "+"
    const ea = String(Math.abs(exp)).padStart(2, "0")
    return `${sign}${mant}e${es}${ea}`
  }
  if (exp < 0) return `${sign}0.${"0".repeat(-exp - 1)}${digits}`
  if (digits.length <= exp + 1) return sign + digits + "0".repeat(exp + 1 - digits.length)
  return `${sign}${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`
}

/** Formats IP address bytes (4 or 16) as Go's netip.Addr does. */
export function formatIP(b: Uint8Array): string {
  if (b.length === 4) return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`
  if (b.length !== 16) return "0x" + hex(b)
  // IPv4-mapped IPv6.
  let mapped = b[10] === 0xff && b[11] === 0xff
  for (let k = 0; k < 10 && mapped; k++) if (b[k] !== 0) mapped = false
  if (mapped) return `::ffff:${b[12]}.${b[13]}.${b[14]}.${b[15]}`
  const words: number[] = []
  for (let k = 0; k < 16; k += 2) words.push((b[k] << 8) | b[k + 1])
  // Find the longest run (length >= 2) of zero words to elide.
  let bestStart = -1
  let bestLen = 0
  for (let k = 0; k < 8; ) {
    if (words[k] !== 0) {
      k++
      continue
    }
    let j = k
    while (j < 8 && words[j] === 0) j++
    if (j - k > bestLen && j - k >= 2) {
      bestStart = k
      bestLen = j - k
    }
    k = j
  }
  const hexWords = words.map((w) => w.toString(16))
  if (bestStart < 0) return hexWords.join(":")
  const head = hexWords.slice(0, bestStart).join(":")
  const tail = hexWords.slice(bestStart + bestLen).join(":")
  return `${head}::${tail}`
}

/** Formats a net value (address followed by mask) as CIDR, e.g., `10.0.0.0/8`. */
export function formatNet(b: Uint8Array): string {
  const n = b.length / 2
  const addr = b.subarray(0, n)
  const mask = b.subarray(n)
  let bits = 0
  for (const byte of mask) {
    if (byte === 0xff) {
      bits += 8
      continue
    }
    let x = byte
    while (x & 0x80) {
      bits++
      x = (x << 1) & 0xff
    }
    break
  }
  return `${formatIP(addr)}/${bits}`
}

/** Formats 16 bytes as a UUID string. */
export function formatUUID(b: Uint8Array): string {
  const h = hex(b)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export function hex(b: Uint8Array): string {
  let s = ""
  for (const byte of b) s += byte.toString(16).padStart(2, "0")
  return s
}
