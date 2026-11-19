import { describe, expect, it } from "vitest"
import {
	gs1CheckDigit,
	hasValidCheckDigit,
	isDigits,
	isValidEan13,
	isValidEan8,
	isValidUpcA,
	withCheckDigit,
} from "./ean.js"

describe("ean check digits", () => {
	it("computes EAN-13 check digits", () => {
		expect(gs1CheckDigit("400638133393")).toBe(1) // 4006381333931
		expect(gs1CheckDigit("201234501250")).toBe(9)
		expect(gs1CheckDigit("221234502500")).toBe(8)
		expect(withCheckDigit("629000000001")).toHaveLength(13)
	})

	it("validates EAN-13, UPC-A and EAN-8", () => {
		expect(isValidEan13("4006381333931")).toBe(true)
		expect(isValidEan13("4006381333932")).toBe(false)
		expect(isValidUpcA("036000291452")).toBe(true)
		expect(isValidUpcA("036000291453")).toBe(false)
		expect(isValidEan8("96385074")).toBe(true)
		expect(isValidEan8("96385075")).toBe(false)
	})

	it("validates the SPEC F5 vectors", () => {
		for (const code of [
			"2012345012509",
			"2012345007505",
			"2212345025008",
			"2212345009992",
		]) {
			expect(hasValidCheckDigit(code)).toBe(true)
		}
		expect(hasValidCheckDigit("2012345012508")).toBe(false)
	})

	it("rejects non-digit input", () => {
		expect(isDigits("12a")).toBe(false)
		expect(isDigits("")).toBe(false)
		expect(hasValidCheckDigit("1")).toBe(false)
		expect(() => gs1CheckDigit("12a")).toThrow()
	})
})
