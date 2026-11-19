import { describe, expect, it } from "vitest"
import { buildReceiptModel } from "./receipt.js"
import { escapeHtml, receiptHtml } from "./receiptHtml.js"

const DOC = {
	name: "pos_offline_3f2b8c1e-9a4d-4c7e-b2a1-5d6e7f8091a2",
	is_offline: true,
	pos_profile: "Main Till",
	posting_date: "2026-11-19",
	posting_time: "10:15:00",
	currency: "AED",
	customer_name: "Walk-in <Customer>",
	items: [
		{
			item_code: "ITM-00001",
			item_name: "Milk 1L",
			item_name_ar: "حليب",
			qty: 2,
			uom: "Nos",
			rate: 5,
			amount: 10,
		},
	],
	net_total: 10,
	taxes: [{ description: "VAT 5%", rate: 5, tax_amount: 0.5 }],
	total_taxes_and_charges: 0.5,
	grand_total: 10.5,
	payments: [{ mode_of_payment: "Cash", amount: 20 }],
	paid_amount: 20,
	change_amount: 9.5,
}
const CTX = {
	company: { name: "Demo Trading LLC", tax_id: "100000000000003" },
	cashModes: ["Cash"],
}

describe("bilingual receipt page", () => {
	it("has both titles, labels, Arabic names and AED amounts", () => {
		const html = receiptHtml(buildReceiptModel(DOC, CTX))
		expect(html).toContain("Tax Invoice<br>")
		expect(html).toContain('<span dir="rtl" lang="ar">فاتورة ضريبية</span>')
		expect(html).toContain("الرقم الضريبي")
		expect(html).toContain("100000000000003")
		expect(html).toContain('dir="rtl" lang="ar">حليب<')
		expect(html).toContain("ضريبة القيمة المضافة 5%")
		expect(html).toContain("AED 10.50")
		expect(html).toContain("AED 9.50")
		expect(html).toContain("OFFLINE - PENDING SYNC")
		expect(html).toContain('<svg class="qr"')
		expect(html).toContain("size:80mm auto")
		expect(html).not.toContain("window.print")
	})

	it("escapes text, 58 mm paper, auto print, Arabic symbol", () => {
		const doc = { ...DOC, name: "ACC-SINV-2026-00001", is_offline: false }
		const html = receiptHtml(buildReceiptModel(doc, { ...CTX, lang: "ar" }), {
			paperWidthMm: 58,
			autoPrint: true,
		})
		expect(html).toContain("Walk-in &lt;Customer&gt;")
		expect(html).not.toContain("<Customer>")
		expect(html).toContain("size:58mm auto")
		expect(html).toContain("window.print()")
		expect(html).toContain("10.50 د.إ")
		// Too wide for Code128 at 2 dots per module on 58 mm: QR instead.
		expect(html).toContain('<svg class="qr"')
		expect(html).not.toContain("OFFLINE - PENDING SYNC")
		const wide = receiptHtml(buildReceiptModel(doc, CTX), { paperWidthMm: 80 })
		expect(wide).toContain('<svg class="barcode"')
	})

	it("credit note", () => {
		const doc = { ...DOC, is_return: 1, return_against: "ACC-SINV-2026-00009" }
		const html = receiptHtml(buildReceiptModel(doc, CTX))
		expect(html).toContain("Tax Credit Note")
		expect(html).toContain("إشعار دائن ضريبي")
		expect(html).toContain("الفاتورة الأصلية")
		expect(html).toContain("ACC-SINV-2026-00009")
	})

	it("escapeHtml", () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
		)
		expect(escapeHtml(null)).toBe("")
	})
})
