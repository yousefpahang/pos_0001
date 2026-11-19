import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { roundedTotal, roundedWhole } from "./rounding.js"

const here = dirname(fileURLToPath(import.meta.url))
const VECTORS = JSON.parse(
	readFileSync(
		resolve(here, "../../../../pos_next/pos_0001/tests/rounding_vectors.json"),
		"utf8",
	),
)

describe("ERPNext rounded total in the browser", () => {
	it("matches Frappe on the shared vectors (also checked in Python)", () => {
		for (const v of VECTORS) {
			const out = roundedTotal(v.value, {
				fraction: v.fraction,
				method: v.method,
			})
			expect(out.roundedTotal, JSON.stringify(v)).toBe(v.expected)
		}
	})

	it("adjustment is the difference; disabled keeps the grand total", () => {
		expect(roundedTotal(40.96, { method: "Banker's Rounding" })).toEqual({
			roundedTotal: 41,
			adjustment: 0.04,
			applied: true,
		})
		expect(roundedTotal(40.96, { disabled: true })).toEqual({
			roundedTotal: 40.96,
			adjustment: 0,
			applied: false,
		})
	})

	it("defaults to Frappe's legacy banker's rounding", () => {
		expect(roundedWhole(2.5)).toBe(2)
		expect(roundedWhole(3.5)).toBe(4)
		expect(roundedWhole(3.49)).toBe(3)
	})
})
