import { describe, expect, it } from "vitest"
import {
	chooseVersion,
	encodeQr,
	formatBits,
	penalty,
	reedSolomon,
} from "./qr.js"
import reference from "./qr.reference.json"

/** Mask number from the format bits in the top-left copy (rows 0-5 and 7-8 of column 8, ...). */
function maskOf(rows) {
	const m = rows.map((r) => [...r].map(Number))
	let bits = 0
	const take = [
		...[0, 1, 2, 3, 4, 5].map((i) => m[i][8]),
		m[7][8],
		m[8][8],
		m[8][7],
		...[9, 10, 11, 12, 13, 14].map((i) => m[8][14 - i]),
	]
	take.forEach((b, i) => {
		bits |= b << i
	})
	const data = (bits ^ 0x5412) >> 10
	return { level: data >> 3, mask: data & 7 }
}

describe("qr", () => {
	it("Reed-Solomon matches the HELLO WORLD 1-M example", () => {
		const data = [
			32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17,
		]
		expect(reedSolomon(data, 10)).toEqual([
			196, 35, 39, 119, 235, 215, 231, 226, 93, 23,
		])
	})

	it("format bits for level M", () => {
		expect(formatBits(0).toString(2).padStart(15, "0")).toBe("101010000010010")
		expect(formatBits(1).toString(2).padStart(15, "0")).toBe("101000100100101")
		expect(formatBits(2).toString(2).padStart(15, "0")).toBe("101111001111100")
		expect(formatBits(5).toString(2).padStart(15, "0")).toBe("100000011001110")
		expect(formatBits(7).toString(2).padStart(15, "0")).toBe("100101010100000")
	})

	it("chooses the smallest version for level M", () => {
		expect(chooseVersion(14)).toBe(1)
		expect(chooseVersion(15)).toBe(2)
		expect(chooseVersion(48)).toBe(4)
		expect(chooseVersion(213)).toBe(10)
		expect(() => chooseVersion(214)).toThrow()
	})

	for (const [text, ref] of Object.entries(reference)) {
		it(`matches pyqrcode for "${text.slice(0, 30)}"`, () => {
			const { level, mask } = maskOf(ref.rows)
			expect(level).toBe(0) // M
			const qr = encodeQr(text, { mask })
			expect(qr.version).toBe(ref.version)
			expect(qr.modules.map((r) => r.join(""))).toEqual(ref.rows)
		})
	}

	it("picks a mask by penalty and keeps finder patterns", () => {
		const qr = encodeQr("pos_offline_3f2b8c1e-9a4d-4c7e-b2a1-5d6e7f8091a2")
		expect(qr.size).toBe(qr.version * 4 + 17)
		expect(qr.modules[0].slice(0, 7).join("")).toBe("1111111")
		expect(qr.modules[1].slice(0, 7).join("")).toBe("1000001")
		expect(penalty(qr.modules)).toBeLessThanOrEqual(
			Math.min(
				...[0, 1, 2, 3, 4, 5, 6, 7].map((k) =>
					penalty(
						encodeQr("pos_offline_3f2b8c1e-9a4d-4c7e-b2a1-5d6e7f8091a2", {
							mask: k,
						}).modules,
					),
				),
			),
		)
	})
})
