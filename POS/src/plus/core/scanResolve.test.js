import { describe, expect, it, vi } from "vitest"
import { RULE_A, RULE_B } from "./scaleRules.fixture.js"
import { resolveScan, withBarcodeUom } from "./scanResolve.js"

const PLU_ITEM = {
	item_code: "PLU-12345",
	item_name: "Tomato",
	stock_uom: "Kg",
	uom: "Kg",
	rate: 12,
	uom_prices: { Kg: 12 },
	item_uoms: [],
}
const NORMAL = {
	item_code: "ITM-00001",
	item_name: "Item 1",
	stock_uom: "Nos",
	uom: "Nos",
	rate: 2,
	uom_prices: { Nos: 2, Box: 20 },
	item_uoms: [{ uom: "Box", conversion_factor: 12 }],
	barcodes: ["6290000000017"],
}

function deps(overrides = {}) {
	const items = { [PLU_ITEM.item_code]: PLU_ITEM, [NORMAL.item_code]: NORMAL }
	return {
		cache: {
			rules: [RULE_A, RULE_B],
			plu_map: { 12345: "PLU-12345" },
			uom_barcodes: { 6290000000024: { item_code: "ITM-00001", uom: "Box" } },
		},
		findByBarcode: vi.fn(
			async (b) =>
				Object.values(items).find((i) => i.barcodes?.includes(b)) || null,
		),
		findByItemCode: vi.fn(async (c) => items[c] || null),
		isOnline: () => false,
		serverLookup: vi.fn(async () => null),
		serverScale: vi.fn(async () => null),
		lineId: () => "line",
		...overrides,
	}
}

describe("resolveScan", () => {
	it("finds a normal barcode in the cache with the network off", async () => {
		const d = deps()
		const r = await resolveScan("6290000000017", d)
		expect(r.source).toBe("cache")
		expect(r.item.item_code).toBe("ITM-00001")
		expect(d.serverLookup).not.toHaveBeenCalled()
	})

	it("applies the UOM of a box barcode", async () => {
		const r = await resolveScan("6290000000024", deps())
		expect(r.item.uom).toBe("Box")
		expect(r.item.conversion_factor).toBe(12)
		expect(r.item.rate).toBe(20)
	})

	it("resolves scale labels offline from the PLU map", async () => {
		const d = deps()
		const r = await resolveScan("2012345012509", d)
		expect(r.source).toBe("scale")
		expect(r.item.resolved_qty).toBe(1.25)
		expect(d.serverLookup).not.toHaveBeenCalled()
		expect(d.serverScale).not.toHaveBeenCalled()
	})

	it("returns the check digit error", async () => {
		const r = await resolveScan("2012345012508", deps())
		expect(r.item).toBeNull()
		expect(r.error.code).toBe("check_digit")
	})

	it("does not call the server when offline and not found", async () => {
		const d = deps()
		const r = await resolveScan("9999999999994", d)
		expect(r).toEqual({ item: null, source: null, error: null })
		expect(d.serverLookup).not.toHaveBeenCalled()
	})

	it("calls the server only when online and not found locally", async () => {
		const d = deps({
			isOnline: () => true,
			serverLookup: vi.fn(async () => ({ item_code: "X" })),
		})
		const r = await resolveScan("9999999999994", d)
		expect(r.source).toBe("server")
		expect(d.serverLookup).toHaveBeenCalledWith("9999999999994")
		const local = await resolveScan("6290000000017", d)
		expect(local.source).toBe("cache")
		expect(d.serverLookup).toHaveBeenCalledTimes(1)
	})

	it("asks the server for a scale PLU missing from the cache when online", async () => {
		const d = deps({
			isOnline: () => true,
			cache: { rules: [RULE_A], plu_map: {}, uom_barcodes: {} },
			serverScale: vi.fn(async () => ({ item_code: "PLU-12345" })),
			serverLookup: vi.fn(async () => PLU_ITEM),
		})
		const r = await resolveScan("2012345007505", d)
		expect(r.source).toBe("scale")
		expect(r.item.resolved_qty).toBe(0.75)
		expect(d.serverLookup).toHaveBeenCalledWith("PLU-12345")
	})

	it("reports a PLU that is not found offline", async () => {
		const d = deps({
			cache: { rules: [RULE_A], plu_map: {}, uom_barcodes: {} },
		})
		const r = await resolveScan("2012345007505", d)
		expect(r.error).toEqual({ code: "plu_not_found", plu: "12345" })
	})

	it("matches Item Barcode rules against cached barcodes", async () => {
		const rule = { ...RULE_A, item_match: "Item Barcode" }
		const item = { ...PLU_ITEM, barcodes: ["12345"] }
		const d = deps({
			cache: { rules: [rule], plu_map: {}, uom_barcodes: {} },
			findByBarcode: async (b) => (b === "12345" ? item : null),
		})
		const r = await resolveScan("2012345012509", d)
		expect(r.item.item_code).toBe("PLU-12345")
	})

	it("withBarcodeUom leaves the item alone for its own UOM", () => {
		expect(withBarcodeUom(NORMAL, "Nos")).toBe(NORMAL)
		expect(withBarcodeUom(NORMAL, "Pallet")).toBe(NORMAL)
	})
})
