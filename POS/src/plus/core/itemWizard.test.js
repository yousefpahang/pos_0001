import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
	barcodeFormatError,
	normalize,
	payloadErrors,
	progressPercent,
	purchaseUom,
	unitPrices,
} from "./itemWizard.js"

const here = dirname(fileURLToPath(import.meta.url))
const VECTORS = JSON.parse(
	readFileSync(resolve(here, "../../../../pos_next/pos_0001/tests/item_wizard_vectors.json"), "utf8"),
)

describe("item wizard: shared vectors with pos_0001/item_wizard.py", () => {
	for (const vector of VECTORS) {
		it(vector.name, () => {
			const p = normalize(vector.payload)
			const out = unitPrices(p, vector.vat_rate, vector.profile_inclusive)
			const e = vector.expected
			expect(out.factors).toEqual(e.factors)
			expect(out.purchase_uom).toBe(e.purchase_uom)
			expect(out.cost_per_stock_uom).toBe(e.cost_per_stock_uom)
			expect(out.base_price).toBe(e.base_price)
			expect(out.units).toEqual(e.units)
			expect(out.opening_stock_qty).toBe(e.opening_stock_qty)
			expect(out.warnings).toEqual(e.warnings)
			expect(out.errors).toEqual(e.errors)
			expect(payloadErrors(p)).toEqual(e.payload_errors)
		})
	}
})

describe("item wizard: SPEC F13 rice example", () => {
	const p = normalize(VECTORS[0].payload)
	const out = unitPrices(p, 5, 0)
	const unit = (uom) => out.units.find((u) => u.uom === uom)

	it("costs 3.00 per Kg from AED 75 per 25 kg bag, 50% margin at 4.50", () => {
		expect(out.cost_per_stock_uom).toBe(3)
		expect(unit("Kg")).toMatchObject({ price: 4.5, cost: 3, margin_pct: 50, shelf_price: 4.5 })
	})

	it("calculates the 500 g pack at 2.25 and keeps the user's 2.50", () => {
		expect(unit("Pack")).toMatchObject({ factor: 0.5, calculated: 2.25, price: 2.5, overridden: 1 })
	})

	it("keeps the cheaper bag price 99.00 (25 x 4.50 = 112.50)", () => {
		expect(unit("Bag")).toMatchObject({ factor: 25, calculated: 112.5, price: 99, shelf_price: 99 })
	})

	it("has no Gram row: Gram is an entry unit", () => {
		expect(unit("Gram")).toBeUndefined()
		expect(out.entry_unit?.uom).toBe("Gram")
		expect(out.opening_stock_qty).toBe(100)
	})

	it("stores prices excl. VAT for a VAT-exclusive profile", () => {
		expect(out.units.map((u) => u.list_rate)).toEqual([4.29, 2.38, 94.29])
	})
})

describe("item wizard helpers", () => {
	it("checks barcode format and check digits", () => {
		expect(barcodeFormatError("")).toBeNull()
		expect(barcodeFormatError("2900000000018")).toBeNull()
		expect(barcodeFormatError("2900000000012")).toBe("barcode_check_digit")
		expect(barcodeFormatError("ABC-12")).toBeNull()
		expect(barcodeFormatError("12 34")).toBe("barcode_format")
	})

	it("takes the biggest buying unit as purchase unit", () => {
		const p = normalize({
			stock_uom: "Kg",
			buying_units: [
				{ uom: "Pack", size: 500, parent_uom: "Gram" },
				{ uom: "Carton", size: 12, parent_uom: "Pack" },
			],
		})
		expect(purchaseUom(p)).toBe("Carton")
	})

	it("filters errors by step and shows progress", () => {
		const p = normalize({ stock_uom: "Kg", selling_units: [{ uom: "Kg" }] })
		expect(payloadErrors(p, ["basics"]).map((e) => e.field)).toEqual(["item_name", "item_group"])
		expect(payloadErrors(p, ["barcodes"])).toEqual([])
		expect(progressPercent("start")).toBe(13)
		expect(progressPercent("review")).toBe(100)
	})
})
