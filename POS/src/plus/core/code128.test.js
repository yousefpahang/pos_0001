import { describe, expect, it } from "vitest"
import {
	PATTERNS,
	code128ModuleCount,
	code128Widths,
	encodeCode128,
} from "./code128.js"

/** Decode symbol values back to text (independent of the encoder's set logic). */
function decode(values) {
	let set = values[0] === 105 ? "C" : "B"
	let out = ""
	for (const v of values.slice(1, -2)) {
		if (set === "B" && v === 99) set = "C"
		else if (set === "C" && v === 100) set = "B"
		else if (set === "C") out += String(v).padStart(2, "0")
		else out += String.fromCharCode(v + 32)
	}
	return out
}

describe("code128", () => {
	it("every pattern is 11 modules wide (stop 13), 3 bars and 3 spaces", () => {
		expect(PATTERNS.length).toBe(107)
		PATTERNS.forEach((p, i) => {
			const sum = [...p].reduce((a, b) => a + Number(b), 0)
			expect(sum, `pattern ${i}`).toBe(i === 106 ? 13 : 11)
		})
		expect(new Set(PATTERNS).size).toBe(107)
	})

	it("checksum follows the standard example (PJJ123C)", () => {
		const v = encodeCode128("PJJ123C")
		expect(v[0]).toBe(104)
		expect(v.at(-2)).toBe(
			(104 +
				[48, 42, 42, 17, 18, 19, 35].reduce((s, x, i) => s + x * (i + 1), 0)) %
				103,
		)
		expect(v.at(-1)).toBe(106)
	})

	it("round-trips invoice names and uses code set C for digit runs", () => {
		for (const text of [
			"ACC-SINV-2026-00012",
			"123456",
			"A123456B",
			"1234567",
			"x",
		]) {
			const values = encodeCode128(text)
			expect(decode(values)).toBe(text)
			let sum = values[0]
			for (let i = 1; i < values.length - 2; i++) sum += values[i] * i
			expect(values.at(-2)).toBe(sum % 103)
		}
		expect(encodeCode128("123456")[0]).toBe(105)
		expect(encodeCode128("123456").length).toBe(3 + 3) // start + 3 pairs + check + stop
		expect(encodeCode128("A123456B")).toContain(99)
	})

	it("server invoice names fit an 80 mm receipt at 2 dots per module", () => {
		expect(code128ModuleCount("ACC-SINV-2026-00012") * 2).toBeLessThan(576 - 40)
		expect(code128Widths("A")[0]).toBe(2) // start B begins with a 2-wide bar
	})

	it("rejects empty and non-ASCII values", () => {
		expect(() => encodeCode128("")).toThrow()
		expect(() => encodeCode128("فاتورة")).toThrow()
	})
})
