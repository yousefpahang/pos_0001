import { describe, expect, it } from "vitest"
import {
	buildIndexRow,
	isVisible,
	itemBarcodes,
	normalize,
	searchRows,
	sortRows,
} from "./searchIndex"

const ITEMS = [
	{
		item_code: "ITM-00001",
		item_name: "Royal Dates 1kg #1",
		barcodes: ["6290000000016"],
		item_group: "Snacks",
	},
	{
		item_code: "ITM-00002",
		item_name: "Fresh Milk 1L #2",
		barcode: "6290000000023,6290000000099",
		item_group: "Dairy",
	},
	{
		item_code: "ITM-01234",
		item_name: "Classic Rice 2kg #1234",
		barcodes: [],
		item_group: "Groceries",
	},
	{
		item_code: "ITM-12345",
		item_name: "Golden Tea 250g #12345",
		barcodes: ["6290000123459"],
		item_group: "Beverages",
	},
	{
		item_code: "RICE-BASMATI",
		item_name: "Basmati Rice",
		item_name_ar: "أرز بسمتي",
		barcodes: [],
	},
	{ item_code: "OLD-1", item_name: "Royal Old", disabled: 1, barcodes: [] },
	{ item_code: "TSHIRT", item_name: "T-Shirt", has_variants: 1, barcodes: [] },
	{
		item_code: "TSHIRT-RED",
		item_name: "T-Shirt Red",
		variant_of: "TSHIRT",
		barcodes: ["111"],
	},
]
const ROWS = sortRows(ITEMS.map((i) => buildIndexRow(i)))
const codes = (q, o) => searchRows(ROWS, q, o).codes

describe("search index", () => {
	it("normalises case, spaces and Arabic letter forms", () => {
		expect(normalize("  Royal   DATES ")).toBe("royal dates")
		expect(normalize("أرز")).toBe(normalize("ارز"))
		expect(normalize("إبراهيم")).toBe("ابراهيم")
		expect(normalize("مُحَمَّد")).toBe("محمد")
		expect(normalize("مدرسة")).toBe(normalize("مدرسه"))
		expect(normalize("علـــى")).toBe(normalize("علي"))
		expect(normalize(null)).toBe("")
	})

	it("reads barcodes in every shape POS Next caches", () => {
		expect(itemBarcodes(ITEMS[1])).toEqual(["6290000000023", "6290000000099"])
		expect(itemBarcodes({ item_barcode: [{ barcode: "1" }, "2"] })).toEqual([
			"1",
			"2",
		])
		expect(itemBarcodes({})).toEqual([])
	})

	it("builds compact rows with Arabic names", () => {
		const row = buildIndexRow(ITEMS[4])
		expect(row).toMatchObject({
			c: "RICE-BASMATI",
			n: "basmati rice",
			k: "rice-basmati",
			a: normalize("أرز بسمتي"),
		})
		expect(buildIndexRow(ITEMS[0], "تمر ملكي").a).toBe("تمر ملكي")
	})

	it("finds by exact barcode first", () => {
		expect(codes("6290000123459")).toEqual(["ITM-12345"])
		expect(codes("6290000000099")).toEqual(["ITM-00002"])
	})

	it("ranks exact code, then code prefix", () => {
		expect(codes("itm-01234")[0]).toBe("ITM-01234")
		expect(codes("ITM-1234")).toEqual(["ITM-12345"])
		expect(codes("ITM-0")).toEqual(
			["ITM-01234", "ITM-00002", "ITM-00001"].sort((a, b) => {
				const order = ROWS.map((r) => r.c)
				return order.indexOf(a) - order.indexOf(b)
			}),
		)
	})

	it("matches every word anywhere in the name, word starts first", () => {
		expect(codes("dates royal")).toEqual(["ITM-00001"])
		expect(codes("rice")).toEqual(["RICE-BASMATI", "ITM-01234"])
		expect(codes("#1234")).toEqual(["ITM-01234", "ITM-12345"])
		expect(codes("ice")).toContain("ITM-01234") // inside a word still matches
		expect(codes("rice zzz")).toEqual([])
	})

	it("finds Arabic names with or without hamza", () => {
		expect(codes("ارز")).toEqual(["RICE-BASMATI"])
		expect(codes("أرز بسمتي")).toEqual(["RICE-BASMATI"])
	})

	it("hides disabled items and follows the variants setting", () => {
		expect(codes("royal")).toEqual(["ITM-00001"])
		expect(codes("t-shirt")).toEqual(["TSHIRT"])
		expect(codes("t-shirt", { showVariantsAsItems: true })).toEqual([
			"TSHIRT-RED",
		])
		expect(isVisible(buildIndexRow(ITEMS[5]), false)).toBe(false)
	})

	it("pages, counts and filters by group", () => {
		const all = searchRows(ROWS, "")
		expect(all.total).toBe(6)
		expect(searchRows(ROWS, "", { limit: 2, offset: 2 }).codes).toEqual(
			all.codes.slice(2, 4),
		)
		expect(codes("", { itemGroups: ["Dairy"] })).toEqual(["ITM-00002"])
		const r = searchRows(ROWS, "itm", { limit: 1 })
		expect(r.codes).toHaveLength(1)
		expect(r.total).toBe(4)
	})

	it("searches 20,000 rows well under the 100 ms target", () => {
		const big = sortRows(
			Array.from({ length: 20_000 }, (_, n) =>
				buildIndexRow({
					item_code: `ITM-${String(n + 1).padStart(5, "0")}`,
					item_name: `${["Fresh", "Royal", "Golden"][n % 3]} ${["Rice", "Dates", "Tea", "Milk"][n % 4]} #${n + 1}`,
					barcodes: [`629${String(n + 1).padStart(10, "0")}`],
				}),
			),
		)
		const start = performance.now()
		for (const q of ["royal dates", "#19999", "ITM-1", "6290000012345", "tea"])
			searchRows(big, q, { limit: 500 })
		const perSearch = (performance.now() - start) / 5
		expect(perSearch).toBeLessThan(50)
		expect(searchRows(big, "#19999").codes[0]).toBe("ITM-19999")
	})
})
