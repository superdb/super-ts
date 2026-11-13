import { test } from "node:test"
import assert from "node:assert/strict"
import {
  formatDuration,
  formatFloat32,
  formatFloat64,
  formatIP,
  formatNet,
  formatTimestamp,
  formatUUID,
} from "../src/format.ts"
import { lz4Uncompress } from "../src/bsup/lz4.ts"

test("durations", () => {
  assert.equal(formatDuration(0n), "0s")
  assert.equal(formatDuration(1n), "1ns")
  assert.equal(formatDuration(1500n), "1.5us")
  assert.equal(formatDuration(2_000_000n), "2ms")
  assert.equal(formatDuration(1_500_000_000n), "1.5s")
  assert.equal(formatDuration(3723_500_000_000n), "1h2m3.5s")
  assert.equal(formatDuration(-60_000_000_000n), "-1m")
  assert.equal(formatDuration(366n * 24n * 3600n * 1_000_000_000n), "1y1d")
  assert.equal(formatDuration(-(1n << 63n)), "-292y171d23h47m16.854775808s")
})

test("timestamps", () => {
  assert.equal(formatTimestamp(0n), "1970-01-01T00:00:00Z")
  assert.equal(formatTimestamp(1704164645123456789n), "2024-01-02T03:04:05.123456789Z")
  assert.equal(formatTimestamp(1704164645100000000n), "2024-01-02T03:04:05.1Z")
  assert.equal(formatTimestamp(-1n), "1969-12-31T23:59:59.999999999Z")
})

test("floats", () => {
  assert.equal(formatFloat64(1), "1.")
  assert.equal(formatFloat64(-0), "0.")
  assert.equal(formatFloat64(1.5), "1.5")
  assert.equal(formatFloat64(0.1), "0.1")
  assert.equal(formatFloat64(1e-5), "1e-05")
  assert.equal(formatFloat64(0.0001), "0.0001")
  assert.equal(formatFloat64(1234567.5), "1.2345675e+06")
  assert.equal(formatFloat64(123456.5), "123456.5")
  assert.equal(formatFloat64(1e100), "1e+100")
  assert.equal(formatFloat64(NaN), "NaN")
  assert.equal(formatFloat64(Infinity), "+Inf")
  assert.equal(formatFloat64(-Infinity), "-Inf")
  assert.equal(formatFloat32(Math.fround(0.1)), "0.1")
  assert.equal(formatFloat32(Math.fround(3.14159)), "3.14159")
})

test("network addresses", () => {
  assert.equal(formatIP(Uint8Array.of(10, 0, 0, 1)), "10.0.0.1")
  const v6 = new Uint8Array(16)
  v6[0] = 0xfe
  v6[1] = 0x80
  v6[15] = 1
  assert.equal(formatIP(v6), "fe80::1")
  assert.equal(formatIP(new Uint8Array(16)), "::")
  const mapped = new Uint8Array(16)
  mapped.set([0xff, 0xff, 1, 2, 3, 4], 10)
  assert.equal(formatIP(mapped), "::ffff:1.2.3.4")
  const noRun = Uint8Array.of(0x20, 0x01, 0x0d, 0xb8, 0, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6)
  assert.equal(formatIP(noRun), "2001:db8:1:2:3:4:5:6")
  assert.equal(formatNet(Uint8Array.of(10, 0, 0, 0, 255, 0, 0, 0)), "10.0.0.0/8")
  assert.equal(formatNet(Uint8Array.of(192, 168, 1, 0, 255, 255, 255, 128)), "192.168.1.0/25")
  assert.equal(
    formatUUID(Uint8Array.from({ length: 16 }, (_, k) => k)),
    "00010203-0405-0607-0809-0a0b0c0d0e0f",
  )
})

test("lz4 block", () => {
  // Literals "abc" then a match of offset 3 and length 9 ("abcabcabc"), then
  // a final literal run "!".
  const block = Uint8Array.of(0x35, 0x61, 0x62, 0x63, 0x03, 0x00, 0x10, 0x21)
  assert.equal(new TextDecoder().decode(lz4Uncompress(block, 13)), "abcabcabcabc!")
  assert.throws(() => lz4Uncompress(block, 12))
})
