// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Label printing (SPEC F4). The byte snapshots live in
// pos_next/pos_0001/tests/label_snapshots.json and are checked by the Python tests too
// (test_labels.py), so the POS and the server print the same labels.
// Regenerate after an intended change: UPDATE_LABEL_SNAPSHOTS=1 yarn test:run labels

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { code128Modules } from "./code128.js"
import { ean13Modules } from "./ean.js"
import { eplBarcode, eplBitmap, eplEscape } from "./epl.js"
import { templateError, usesQty } from "./labelTemplate.js"
import {
	barcodeFor,
	bytesToBase64,
	checkRows,
	effectiveBarcodeType,
	fakeBitmap,
	fmtNumber,
	formatDate,
	gridLayout,
	htmlEscape,
	itemPlu,
	priceInclVat,
	renderLabel,
	renderPdfHtml,
	renderRaw,
	resolveRow,
	withBarcodeTypes,
} from "./labels.js"
import { normalizeRule } from "./scaleBarcode.js"
import { RULE_A, RULE_B } from "./scaleRules.fixture.js"
import { tsplBarcode, tsplBitmap, tsplEscape } from "./tspl.js"
import { mmToDots, zplBarcode, zplBitmap, zplEscape } from "./zpl.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, "../../../..")
const DEFAULTS = JSON.parse(
	fs.readFileSync(path.join(appRoot, "pos_next/pos_0001/default_label_templates.json"), "utf8"),
).map((t) => ({ ...t, name: t.template_name }))
const SNAPSHOT_FILE = path.join(appRoot, "pos_next/pos_0001/tests/label_snapshots.json")

const BASE = { currency: "AED", company: "Demo Trading LLC", date: "21-11-2026" }
const ROWS = [
	{
		item_code: "ITM-00001",
		item_name: "Premium Tissue 500g #1",
		item_name_ar: "مناديل فاخرة",
		uom: "Nos",
		barcode: "6290000000016",
		price: 40.96,
		price_text: "40.96",
		price_label: "AED 40.96",
		weight_label: "",
		qty: 2,
		is_scale: 0,
	},
	{
		item_code: 'ODD-"^~>1',
		item_name: 'Quote " caret ^ tilde ~ back \\ é',
		item_name_ar: "",
		uom: "Box",
		barcode: 'ODD-"^~>1',
		price: 5,
		price_text: "5.00",
		price_label: "AED 5.00",
		weight_label: "",
		qty: 1,
		is_scale: 0,
	},
	{
		item_code: "PLU-12345",
		item_name: "Tomato (per kg) 12345",
		item_name_ar: "طماطم",
		uom: "Kg",
		barcode: "2012345012509",
		price: 50.18,
		price_text: "50.18",
		price_label: "AED 50.18",
		weight_label: "1.250 Kg",
		qty: 1,
		is_scale: 1,
	},
]

// Bodies that exercise Jinja's whitespace rules (trim_blocks + lstrip_blocks).
const SUBSET_BODIES = [
	"A{{ item_code }}B\n",
	"line1\n  {% if item_name_ar %}\n  AR:{{ item_name_ar }}\n  {% endif %}\nend\n",
	"{% if weight %}W={{ weight }}{% elif item_name_ar %}AR{% else %}none{% endif %}|{{ qty }}",
	"x {% if not weight %}no weight{% endif %} y\n\n",
	"\t{% if item_code %}\n\t\tcode {{ fit(item_code, 3) }}\n\t{% endif %}\n\n\ntail",
	"{{ fit(item_name, 5) }}|{{ fit('abcdef', 2) }}|{{ uom }}{% if price %} {{ price_label }}{% endif %}\r\nnext\r\n",
	"{{ draw_barcode(10, 20, 30) }}\n{{ draw_barcode(1.5, 2.5, 3.5, 2.5) }}",
	"{{ draw_arabic(item_name_ar, 5, 6, 7, 40) }}|{{ draw_arabic('', 1, 2) }}",
]

function buildCases() {
	const cases = []
	for (const template of DEFAULTS) {
		const rows = withBarcodeTypes(template, ROWS)
		if (template.language === "PDF") {
			cases.push({ kind: "pdf_html", template, rows, output: renderPdfHtml(template, rows, BASE) })
		} else {
			cases.push({
				kind: "raw",
				template,
				rows,
				output: bytesToBase64(renderRaw(template, rows, BASE, fakeBitmap)),
			})
		}
	}
	for (const language of ["ZPL", "EPL", "TSPL"]) {
		SUBSET_BODIES.forEach((body, i) => {
			const template = {
				name: `subset-${language}-${i}`,
				language,
				width_mm: 50,
				height_mm: 30,
				dpi: 203,
				gap_mm: 2,
				barcode_type: "EAN13",
				body,
			}
			const rows = withBarcodeTypes(template, ROWS)
			cases.push({
				kind: "raw",
				template,
				rows,
				output: bytesToBase64(renderRaw(template, rows, BASE, fakeBitmap)),
			})
		})
	}
	return cases
}

describe("label snapshots shared with Python", () => {
	it("default templates and template subset render the stored bytes", () => {
		const cases = buildCases()
		if (process.env.UPDATE_LABEL_SNAPSHOTS) {
			fs.writeFileSync(SNAPSHOT_FILE, `${JSON.stringify({ base: BASE, cases }, null, 1)}\n`)
		}
		const stored = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8"))
		expect(stored.cases.length).toBe(cases.length)
		cases.forEach((c, i) => {
			expect(c.template.name).toBe(stored.cases[i].template.name)
			expect(c.output, c.template.name).toBe(stored.cases[i].output)
		})
	})

	it("ZPL shelf label reads as expected", () => {
		const template = DEFAULTS.find((t) => t.name === "Shelf Label 38x25 (ZPL)")
		const rows = withBarcodeTypes(template, [ROWS[0]])
		const { text, parts } = renderLabel(template, rows[0], BASE, fakeBitmap)
		expect(text).toContain("^PW304\n^LL200\n")
		expect(text).toContain("^FDPremium Tissue 500g #1^FS")
		expect(text).toContain("^FO20,104^BY2,3,52^BEN,52,Y,N^FD629000000001^FS")
		expect(text).toContain("^PQ2\n^XZ")
		expect(parts).toHaveLength(1)
		expect(new TextDecoder().decode(parts[0])).toMatch(/^\^FO10,32\^GFA,\d+,\d+,6,[0-9A-F]+\^FS$/)
	})
})

describe("label commands", () => {
	it("converts mm to dots", () => {
		expect(mmToDots(38, 203)).toBe(304)
		expect(mmToDots(25, 203)).toBe(200)
		expect(mmToDots(50, 300)).toBe(591)
	})

	it("escapes text for each language", () => {
		expect(zplEscape("a^b~c\nd")).toBe("a b c d")
		expect(eplEscape('a"b\\c é')).toBe('a\\"b\\\\c ?')
		expect(tsplEscape('say "hi"')).toBe('say \\["]hi\\["]')
		expect(htmlEscape(`<a href="x">'&'</a>`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;&#x27;&amp;&#x27;&lt;/a&gt;",
		)
	})

	it("builds barcode fields", () => {
		const ean = { value: "6290000000016", kind: "EAN13", x: 1, y: 2, height: 40, module: 2 }
		expect(zplBarcode(ean)).toBe("^FO1,2^BY2,3,40^BEN,40,Y,N^FD629000000001^FS")
		expect(eplBarcode(ean)).toBe('B1,2,0,E30,2,2,40,B,"629000000001"')
		expect(tsplBarcode(ean)).toBe('BARCODE 1,2,"EAN13",40,1,0,2,2,"629000000001"')
		const c128 = { value: 'A>"1', kind: "Code128", x: 0, y: 0, height: 9, module: 1 }
		expect(zplBarcode(c128)).toBe('^FO0,0^BY1,3,9^BCN,9,Y,N,N^FDA><"1^FS')
		expect(eplBarcode(c128)).toBe('B0,0,0,1,1,1,9,B,"A>\\"1"')
		expect(tsplBarcode(c128)).toBe('BARCODE 0,0,"128",9,1,0,1,1,"A>\\["]1"')
	})

	it("writes bitmaps: ZPL hex with 1 = black, EPL and TSPL binary with 0 = black", () => {
		const bmp = { width: 10, height: 2, bytesPerRow: 2, data: Uint8Array.from([0xff, 0xc0, 0x00, 0x00]) }
		expect(new TextDecoder().decode(zplBitmap(3, 4, bmp))).toBe("^FO3,4^GFA,4,4,2,FFC00000^FS")
		const epl = eplBitmap(3, 4, bmp)
		expect(new TextDecoder().decode(epl.slice(0, 10))).toBe("GW3,4,2,2,")
		expect([...epl.slice(-4)]).toEqual([0x00, 0x3f, 0xff, 0xff])
		const tspl = tsplBitmap(3, 4, bmp)
		expect(new TextDecoder().decode(tspl.slice(0, 17))).toBe("BITMAP 3,4,2,2,0,")
		expect([...tspl.slice(-4)]).toEqual([0x00, 0x3f, 0xff, 0xff])
	})

	it("encodes EAN-13 and Code128 modules", () => {
		const ean = ean13Modules("4006381333931")
		expect(ean).toHaveLength(95)
		expect(ean.startsWith("101")).toBe(true)
		expect(ean.slice(45, 50)).toBe("01010")
		expect(() => ean13Modules("4006381333932")).toThrow()
		const c = code128Modules("ITM-00001")
		expect(c.length % 11).toBe(2) // symbols of 11 modules + 13-module stop
		expect(c.startsWith("11010010000")).toBe(true) // Start B
		expect(c.endsWith("1100011101011")).toBe(true) // Stop
	})

	it("chooses EAN-13 only for valid codes", () => {
		expect(effectiveBarcodeType("EAN13", "6290000000016")).toBe("EAN13")
		expect(effectiveBarcodeType("EAN13", "6290000000017")).toBe("Code128")
		expect(effectiveBarcodeType("EAN13", "629000000001")).toBe("Code128")
		expect(effectiveBarcodeType("Code128", "6290000000016")).toBe("Code128")
	})

	it("repeats labels when the template does not print its own copies", () => {
		const template = {
			name: "t",
			language: "TSPL",
			width_mm: 30,
			height_mm: 20,
			body: "CLS\nTEXT 1,1,\"1\",0,1,1,\"{{ item_code }}\"\nPRINT 1\n",
		}
		expect(usesQty(template.body)).toBe(false)
		const out = new TextDecoder().decode(
			renderRaw(template, [{ item_code: "A", qty: 3 }], BASE, fakeBitmap),
		)
		expect(out.split("CLS").length - 1).toBe(3)
		expect(out).toContain('TEXT 1,1,"1",0,1,1,"A"\r\nPRINT 1\r\n')
	})

	it("limits rows and quantities", () => {
		expect(checkRows([{ qty: 2 }, { qty: 3 }])).toBe(5)
		expect(() => checkRows([{ qty: 1000 }])).toThrow(/between 1 and 999/)
		expect(() => checkRows(Array.from({ length: 3 }, () => ({ qty: 999 })))).toThrow(
			/At most 2000 labels/,
		)
	})
})

describe("template subset", () => {
	it("accepts the default templates", () => {
		for (const t of DEFAULTS) expect(templateError(t.body), t.name).toBeNull()
	})

	it("rejects Jinja outside the subset with a plain message", () => {
		expect(templateError("{{ item_name|upper }}")).toMatch(/Unsupported expression/)
		expect(templateError("{{ nope }}")).toMatch(/Unknown value/)
		expect(templateError("{{ draw_qr(1) }}")).toMatch(/Unknown helper/)
		expect(templateError("{% for x in y %}{% endfor %}")).toMatch(/Unsupported tag/)
		expect(templateError("{% if item_code %}")).toMatch(/without \{% endif %\}/)
		expect(templateError("{% endif %}")).toMatch(/without \{% if %\}/)
		expect(templateError("{# note #}")).toMatch(/Comments/)
		expect(templateError("{%- if item_code %}{% endif %}")).toMatch(/Whitespace control/)
		expect(templateError("{{ item_code")).toMatch(/Unclosed/)
		expect(templateError("{% if price > 1 %}{% endif %}")).toMatch(/Unsupported condition/)
	})
})

describe("A4 sheet", () => {
	it("centres the grid and checks it fits", () => {
		const g = gridLayout({ a4_columns: 3, a4_rows: 8, width_mm: 70, height_mm: 37, margins_mm: 3 })
		expect(g.left).toBe(0)
		expect(g.top).toBe(0.5)
		expect(() => gridLayout({ a4_columns: 3, a4_rows: 8, width_mm: 71, height_mm: 37 })).toThrow(
			/does not fit/,
		)
		expect(() => gridLayout({ a4_columns: 0, a4_rows: 8, width_mm: 70, height_mm: 37 })).toThrow()
	})

	it("puts each label qty times, 24 per page, with SVG barcodes and Arabic", () => {
		const template = DEFAULTS.find((t) => t.language === "PDF")
		const rows = withBarcodeTypes(template, [{ ...ROWS[0], qty: 25 }])
		const html = renderPdfHtml(template, rows, BASE)
		expect(html.match(/class="page"/g)).toHaveLength(2)
		expect(html.match(/class="cell"/g)).toHaveLength(25)
		expect(html).toContain('<span class="ar" dir="rtl" lang="ar">مناديل فاخرة</span>')
		expect(html).toContain('<div class="bc-text">6290000000016</div>')
		expect(html).toContain("left:140mm;top:259.5mm")
	})

	it("formats numbers like Python", () => {
		expect(fmtNumber(38)).toBe("38")
		expect(fmtNumber(37.125)).toBe("37.125")
		expect(fmtNumber(0.5)).toBe("0.5")
		expect(fmtNumber(100)).toBe("100")
		expect(fmtNumber(-0)).toBe("0")
	})
})

describe("label rows offline", () => {
	const cache = { currency: "AED", vat_rate: 5, prices_include_vat: 0, item_vat: { ZERO: 0 } }
	const item = {
		item_code: "ITM-00001",
		item_name: "Premium Tissue",
		stock_uom: "Nos",
		uom: "Nos",
		price_list_rate: 39.01,
		barcodes: ["6290000000016,6290000000023"],
		item_uoms: [{ uom: "Box", conversion_factor: 12 }],
		uom_prices: { Box: 450 },
	}
	const scan = {
		rules: [RULE_A, RULE_B],
		plu_map: { 12345: "PLU-12345" },
		uom_barcodes: {
			"6290000000023": { item_code: "ITM-00001", uom: "Box" },
			"6290000000016": { item_code: "ITM-00001", uom: "Nos" },
		},
	}

	it("prices incl. VAT per UOM with that UOM's barcode", () => {
		const nos = resolveRow({ item_code: "ITM-00001", qty: 2 }, item, cache, scan)
		expect(nos).toMatchObject({
			uom: "Nos",
			barcode: "6290000000016",
			price: 40.96,
			price_text: "40.96",
			price_label: "AED 40.96",
			qty: 2,
			uoms: ["Nos", "Box"],
		})
		const box = resolveRow({ item_code: "ITM-00001", uom: "Box", qty: 1 }, item, cache, scan)
		expect(box).toMatchObject({ uom: "Box", barcode: "6290000000023", price: 472.5 })
	})

	it("falls back to the item code when a UOM has no barcode, keeps price overrides", () => {
		const bare = { ...item, barcodes: [] }
		const row = resolveRow({ item_code: "ITM-00001", uom: "Box", price: "9.5" }, bare, cache, {})
		expect(row.barcode).toBe("ITM-00001")
		expect(row.price).toBe(9.5)
		expect(row.price_label).toBe("AED 9.50")
	})

	it("uses an item's own VAT rate and prices that already include VAT", () => {
		expect(priceInclVat(10, 5, 0)).toBe(10.5)
		expect(priceInclVat(10, 5, 1)).toBe(10)
		const zero = resolveRow({ item_code: "ZERO" }, { ...item, item_code: "ZERO" }, cache, {})
		expect(zero.price).toBe(39.01)
	})

	it("makes scale labels from POS Scale Barcode Rules (weight and price)", () => {
		const plu = {
			item_code: "PLU-12345",
			item_name: "Tomato",
			stock_uom: "Kg",
			price_list_rate: 38.23,
		}
		const weight = resolveRow(
			{ item_code: "PLU-12345", scale_rule: RULE_A.name, scale_value: 1.25 },
			plu,
			cache,
			scan,
		)
		expect(weight).toMatchObject({
			barcode: "2012345012509",
			weight_label: "1.250 Kg",
			price: 50.18,
			is_scale: 1,
		})
		const price = resolveRow(
			{ item_code: "PLU-12345", scale_rule: RULE_B.name, scale_value: 25 },
			plu,
			{ ...cache, prices_include_vat: 1 },
			scan,
		)
		expect(price).toMatchObject({ barcode: "2212345025008", price: 25, weight_label: "" })
		expect(withBarcodeTypes({ barcode_type: "Code128" }, [price])[0].barcode_type).toBe("EAN13")
	})

	it("explains rows that cannot be printed", () => {
		const plu = { item_code: "X", item_name: "X", stock_uom: "Nos", price_list_rate: 1 }
		expect(() =>
			resolveRow({ item_code: "X", scale_rule: RULE_A.name, scale_value: 1 }, plu, cache, scan),
		).toThrow("plu")
		expect(() => resolveRow({ item_code: "X", uom: "Box" }, plu, cache, scan)).toThrow("uom")
		expect(() => resolveRow({ item_code: "X", qty: 0 }, plu, cache, scan)).toThrow("qty")
		expect(itemPlu(normalizeRule(RULE_A), { item_code: "PLU-12345" }, scan.plu_map)).toBe("12345")
	})

	it("picks barcodes per UOM", () => {
		expect(barcodeFor(item, "Box", scan.uom_barcodes)).toBe("6290000000023")
		expect(barcodeFor(item, "Nos", scan.uom_barcodes)).toBe("6290000000016")
		expect(barcodeFor({ ...item, barcodes: [] }, "Nos", {})).toBe("ITM-00001")
	})

	it("formats dates in the site format", () => {
		const d = new Date(2026, 10, 21)
		expect(formatDate(d, "dd-mm-yyyy")).toBe("21-11-2026")
		expect(formatDate(d, "mm/dd/yyyy")).toBe("11/21/2026")
		expect(formatDate(d)).toBe("2026-11-21")
	})
})
