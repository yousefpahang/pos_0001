import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { LABELS, fill, rateText, receiptTitle } from "./receiptLabels.js"

const here = dirname(fileURLToPath(import.meta.url))
const CSV = resolve(here, "../../../../pos_next/translations/ar.csv")

/** Frappe translation CSV -> { source: translation } (quoted fields, "" escapes). */
function readCsv(path) {
	const text = readFileSync(path, "utf8")
	const out = {}
	const re = /"((?:[^"]|"")*)","((?:[^"]|"")*)"/g
	for (const line of text.split(/\r?\n/)) {
		re.lastIndex = 0
		const m = re.exec(line)
		if (m) out[m[1].replace(/""/g, '"')] = m[2].replace(/""/g, '"')
	}
	return out
}

describe("UAE receipt wording", () => {
	it("every label's Arabic is the one in ar.csv (the server print format uses the CSV)", () => {
		const csv = readCsv(CSV)
		for (const [key, label] of Object.entries(LABELS)) {
			expect(csv[label.en], `${key}: "${label.en}" missing in ar.csv`).toBe(
				label.ar,
			)
		}
	})

	it("returns are tax credit notes", () => {
		expect(receiptTitle({ isReturn: true, mode: "Tax Invoice" })).toBe(
			LABELS.taxCreditNote,
		)
	})

	it("title modes: fixed, simplified, auto by customer TRN", () => {
		expect(receiptTitle({})).toBe(LABELS.taxInvoice)
		expect(receiptTitle({ mode: "Tax Invoice" })).toBe(LABELS.taxInvoice)
		expect(receiptTitle({ mode: "Simplified Tax Invoice" })).toBe(
			LABELS.simplifiedTaxInvoice,
		)
		expect(
			receiptTitle({ mode: "Auto", customerTaxId: "100123456700003" }),
		).toBe(LABELS.taxInvoice)
		expect(receiptTitle({ mode: "Auto", customerTaxId: " " })).toBe(
			LABELS.simplifiedTaxInvoice,
		)
	})

	it("fills placeholders in both languages", () => {
		expect(fill(LABELS.vatRate, [rateText(5)])).toEqual({
			en: "VAT 5%",
			ar: "ضريبة القيمة المضافة 5%",
		})
		expect(rateText("2.50")).toBe("2.5")
		expect(rateText(0)).toBe("0")
		expect(rateText(null)).toBe("")
	})
})
