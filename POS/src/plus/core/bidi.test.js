import { describe, expect, it } from "vitest"
import { LRI, PDI, keepLtr, ltrIsolate } from "./bidi.js"

describe("left-to-right isolates for numbers in Arabic layouts", () => {
	it("wraps only on right-to-left pages", () => {
		expect(ltrIsolate("11/19/2026, 4:09 AM", "rtl")).toBe(
			`${LRI}11/19/2026, 4:09 AM${PDI}`,
		)
		expect(ltrIsolate("11/19/2026", "ltr")).toBe("11/19/2026")
		expect(ltrIsolate("", "rtl")).toBe("")
		expect(ltrIsolate(null, "rtl")).toBe("")
	})

	it("never wraps twice", () => {
		const once = ltrIsolate("2:35 PM", "rtl")
		expect(ltrIsolate(once, "rtl")).toBe(once)
	})

	it("keepLtr follows the page direction (ltr without a DOM)", () => {
		const f = keepLtr((d) => `date ${d}`)
		expect(f(1)).toBe("date 1")
	})
})
