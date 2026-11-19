import { describe, expect, it } from "vitest"
import { toHex } from "./escpos.js"
import { rasterJob, toMonochrome, trimBottom } from "./raster.js"

/** Fixed 10 x 4 "receipt": black frame, white inside, one grey and one transparent pixel. */
function fixedReceipt() {
	const w = 10
	const h = 4
	const rgba = new Uint8ClampedArray(w * h * 4).fill(255)
	const setPx = (x, y, v, a = 255) => {
		const i = (y * w + x) * 4
		rgba[i] = rgba[i + 1] = rgba[i + 2] = v
		rgba[i + 3] = a
	}
	for (let x = 0; x < w; x++) {
		setPx(x, 0, 0)
		setPx(x, h - 1, 0)
	}
	setPx(0, 1, 0)
	setPx(9, 1, 0)
	setPx(4, 2, 100) // dark grey: black
	setPx(5, 2, 200) // light grey: white
	setPx(6, 2, 0, 0) // transparent: paper
	return { rgba, w, h }
}

describe("raster conversion", () => {
	it("converts a fixed receipt to packed 1-bit rows", () => {
		const { rgba, w, h } = fixedReceipt()
		const img = toMonochrome(rgba, w, h)
		expect(img.bytesPerRow).toBe(2)
		expect(toHex(img.bits)).toBe("ff c0 80 40 08 00 ff c0")
	})

	it("dithering spreads grey into a pattern", () => {
		const w = 8
		const h = 2
		const rgba = new Uint8ClampedArray(w * h * 4)
		for (let i = 0; i < rgba.length; i += 4) {
			rgba[i] = rgba[i + 1] = rgba[i + 2] = 128
			rgba[i + 3] = 255
		}
		const flat = toMonochrome(rgba, w, h, { threshold: 128 })
		const dith = toMonochrome(rgba, w, h, { dither: true })
		expect(toHex(flat.bits)).toBe("00 00")
		const ones = [...dith.bits].reduce(
			(n, b) => n + b.toString(2).split("1").length - 1,
			0,
		)
		expect(ones).toBeGreaterThan(4)
		expect(ones).toBeLessThan(12)
	})

	it("trims blank rows under the content", () => {
		const img = {
			width: 8,
			height: 20,
			bytesPerRow: 1,
			bits: new Uint8Array(20),
		}
		img.bits[3] = 0xff
		expect(trimBottom(img, 2).height).toBe(6)
		expect(trimBottom({ ...img, bits: new Uint8Array(20) }, 2).height).toBe(2)
	})

	it("builds the GS v 0 job with drawer on the first copy and a cut per copy", () => {
		const { rgba, w, h } = fixedReceipt()
		const img = toMonochrome(rgba, w, h)
		const job = rasterJob(img, { cut: true, drawer: true, copies: 2 })
		expect(toHex(job)).toMatchSnapshot()
		const hex = toHex(job)
		expect(hex.startsWith("1b 40 1b 70 00 19 fa 1d 76 30 00 02 00 04 00")).toBe(
			true,
		)
		expect(hex.split("1b 70 00 19 fa").length - 1).toBe(1)
		expect(hex.split("1d 56 00").length - 1).toBe(2)
		const noCut = toHex(rasterJob(img, { cut: false }))
		expect(noCut).not.toContain("1d 56")
	})
})
