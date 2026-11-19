import { describe, expect, it } from "vitest"
import {
	DRAWER_KICK,
	EscPosBuilder,
	asciiText,
	center,
	columnsForPaper,
	dotsForPaper,
	leftRight,
	repeatCopies,
	toBase64,
	toHex,
	wrap,
} from "./escpos.js"

describe("escpos text helpers", () => {
	it("keeps ASCII and replaces what a code page cannot print", () => {
		expect(asciiText("Milk 1L")).toBe("Milk 1L")
		expect(asciiText("حليب")).toBe("????")
		expect(asciiText("a\tb\u0007c")).toBe("a b c")
		expect(asciiText(null)).toBe("")
	})

	it("centers, aligns left/right and wraps", () => {
		expect(center("ABC", 9)).toBe("   ABC")
		expect(center("ABCDEFGHIJ", 4)).toBe("ABCD")
		expect(leftRight("Total", "25.00", 16)).toBe("Total      25.00")
		expect(leftRight("A very long item name", "9.99", 16)).toBe("A very long 9.99")
		expect(leftRight("Only", "", 10)).toBe("Only")
		expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"])
		expect(wrap("ABCDEFGHIJKL", 5)).toEqual(["ABCDE", "FGHIJ", "KL"])
	})

	it("maps paper width to dots and columns", () => {
		expect(dotsForPaper(80)).toBe(576)
		expect(dotsForPaper("58")).toBe(384)
		expect(dotsForPaper(99)).toBe(576)
		expect(columnsForPaper(80)).toBe(48)
		expect(columnsForPaper(58)).toBe(32)
		expect(columnsForPaper(80, 42)).toBe(42)
		expect(columnsForPaper(80, 5)).toBe(48)
	})
})

describe("EscPosBuilder bytes", () => {
	it("encodes the basic commands", () => {
		const bytes = new EscPosBuilder()
			.init()
			.align("center")
			.bold(true)
			.size(2, 2)
			.line("Hi")
			.bold(false)
			.size()
			.feed(3)
			.bytes()
		expect(toHex(bytes)).toBe("1b 40 1b 61 01 1b 45 01 1d 21 11 48 69 0a 1b 45 00 1d 21 00 1b 64 03")
	})

	it("drawer kick is ESC p 0 25 250", () => {
		expect(Array.from(DRAWER_KICK)).toEqual([0x1b, 0x70, 0x00, 25, 250])
		expect(toHex(new EscPosBuilder().drawerKick().bytes())).toBe("1b 70 00 19 fa")
	})

	it("cut feeds then sends GS V", () => {
		expect(toHex(new EscPosBuilder().cut().bytes())).toBe("1b 64 04 1d 56 00")
		expect(toHex(new EscPosBuilder().cut({ partial: true, feedLines: 0 }).bytes())).toBe("1d 56 01")
	})

	it("native Code128 uses code set B", () => {
		expect(toHex(new EscPosBuilder().code128("A1", { height: 50, moduleWidth: 2 }).bytes())).toBe(
			"1d 68 32 1d 77 02 1d 48 02 1d 6b 49 04 7b 42 41 31 0a",
		)
	})

	it("native QR stores and prints the symbol", () => {
		expect(toHex(new EscPosBuilder().qr("AB", { moduleSize: 4 }).bytes())).toBe(
			[
				"1d 28 6b 04 00 31 41 32 00",
				"1d 28 6b 03 00 31 43 04",
				"1d 28 6b 03 00 31 45 31",
				"1d 28 6b 05 00 31 50 30 41 42",
				"1d 28 6b 03 00 31 51 30 0a",
			].join(" "),
		)
	})

	it("GS v 0 raster is split into bands", () => {
		const image = { bytesPerRow: 2, height: 3, bits: Uint8Array.from([1, 2, 3, 4, 5, 6]) }
		expect(toHex(new EscPosBuilder().raster(image, { bandHeight: 2 }).bytes())).toBe(
			"1d 76 30 00 02 00 02 00 01 02 03 04 1d 76 30 00 02 00 01 00 05 06",
		)
	})

	it("repeats copies (1-3) and encodes base64", () => {
		const job = Uint8Array.from([1, 2])
		expect(Array.from(repeatCopies(job, 2))).toEqual([1, 2, 1, 2])
		expect(repeatCopies(job, 9).length).toBe(6)
		expect(repeatCopies(job, 0).length).toBe(2)
		expect(toBase64(Uint8Array.from([0x1b, 0x40]))).toBe("G0A=")
		expect(toBase64(Uint8Array.from([1, 2, 3]))).toBe("AQID")
		expect(toBase64(Uint8Array.from([0xff]))).toBe("/w==")
	})
})
