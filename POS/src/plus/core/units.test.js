import { describe, expect, it } from "vitest"
import { canEnterSmallUnit, entryToStockQty, entryUnitFor, stockQtyToEntry } from "./units.js"

describe("entry units in the cart", () => {
	it("knows gram for Kg and millilitre for Litre only", () => {
		expect(entryUnitFor("Kg")).toEqual({ uom: "Gram", factor: 0.001, symbol: "g" })
		expect(entryUnitFor("Litre")?.uom).toBe("Millilitre")
		expect(entryUnitFor("Nos")).toBeNull()
		expect(entryUnitFor(undefined)).toBeNull()
	})

	it("turns grams into Kg at 3 decimals (SPEC F13: 250 g -> 0.250 Kg)", () => {
		expect(entryToStockQty("250", "Kg")).toBe(0.25)
		expect(entryToStockQty(1250, "Kg")).toBe(1.25)
		expect(entryToStockQty("12,5", "Kg")).toBe(0.013)
		expect(entryToStockQty("750", "Litre")).toBe(0.75)
		expect(entryToStockQty("0.4", "Kg")).toBeNull() // rounds to 0
		for (const bad of ["", "abc", "-5", 0, null])
			expect(entryToStockQty(bad, "Kg")).toBeNull()
		expect(entryToStockQty("250", "Nos")).toBeNull()
		expect(stockQtyToEntry(0.25, "Kg")).toBe(250)
		expect(stockQtyToEntry(1, "Nos")).toBeNull()
	})

	it("offers grams only on lines sold in the stock unit without a scale label", () => {
		expect(canEnterSmallUnit({ uom: "Kg", stock_uom: "Kg" })).toBe(true)
		expect(canEnterSmallUnit({ stock_uom: "Kg" })).toBe(true)
		expect(canEnterSmallUnit({ uom: "Pack", stock_uom: "Kg" })).toBe(false)
		expect(canEnterSmallUnit({ uom: "Nos", stock_uom: "Nos" })).toBe(false)
		expect(
			canEnterSmallUnit({ uom: "Kg", stock_uom: "Kg", pos0001_scale_barcode: "2012345012509" }),
		).toBe(false)
		expect(canEnterSmallUnit({ uom: "Kg", stock_uom: "Kg", is_resolved_barcode: true })).toBe(false)
	})
})
