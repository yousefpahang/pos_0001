import { describe, expect, it } from "vitest"
import {
	columnsFromTemplate,
	shouldVirtualize,
	visibleRange,
} from "./virtualGrid"

describe("virtual grid", () => {
	it("renders the rows in view plus overscan, padding the rest", () => {
		// 500 items, 5 columns = 100 rows of 200 px; viewport 600 px scrolled to row 10.
		const r = visibleRange({
			count: 500,
			columns: 5,
			rowHeight: 200,
			scrollTop: 2000,
			viewportHeight: 600,
			overscan: 2,
		})
		expect(r.start).toBe(8 * 5)
		expect(r.end).toBe(15 * 5)
		expect(r.padTop).toBe(8 * 200)
		expect(r.padBottom).toBe((100 - 15) * 200)
		// Total height is unchanged: padding + rendered rows.
		expect(r.padTop + ((r.end - r.start) / 5) * 200 + r.padBottom).toBe(
			100 * 200,
		)
	})

	it("starts at the top and clamps at the end", () => {
		expect(
			visibleRange({
				count: 50,
				columns: 5,
				rowHeight: 100,
				scrollTop: 0,
				viewportHeight: 300,
				overscan: 1,
			}),
		).toEqual({
			start: 0,
			end: 20, // rows 0-3: three in view + one overscan
			padTop: 0,
			padBottom: 600,
		})
		const end = visibleRange({
			count: 52,
			columns: 5,
			rowHeight: 100,
			scrollTop: 99_999,
			viewportHeight: 300,
			overscan: 1,
		})
		expect(end.end).toBe(52)
		expect(end.padBottom).toBe(0)
		expect(end.start).toBe(50)
	})

	it("accounts for content above the grid and lists of one column", () => {
		const r = visibleRange({
			count: 1000,
			columns: 1,
			rowHeight: 40,
			scrollTop: 440,
			viewportHeight: 400,
			offsetTop: 40,
			overscan: 0,
		})
		expect(r.start).toBe(10)
		expect(r.end).toBe(20)
	})

	it("renders everything until a row was measured, nothing for no items", () => {
		expect(
			visibleRange({
				count: 30,
				columns: 3,
				rowHeight: 0,
				scrollTop: 0,
				viewportHeight: 0,
			}),
		).toEqual({
			start: 0,
			end: 30,
			padTop: 0,
			padBottom: 0,
		})
		expect(
			visibleRange({
				count: 0,
				columns: 3,
				rowHeight: 10,
				scrollTop: 0,
				viewportHeight: 100,
			}).end,
		).toBe(0)
	})

	it("reads columns from CSS and only virtualises long lists", () => {
		expect(columnsFromTemplate("120px 120px 120px 120px")).toBe(4)
		expect(columnsFromTemplate("none")).toBe(1)
		expect(columnsFromTemplate("")).toBe(1)
		expect(shouldVirtualize(60)).toBe(false)
		expect(shouldVirtualize(61)).toBe(true)
	})
})
