// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// UAE tax invoice wording (SPEC section 7). The receipt is bilingual whatever language
// the till shows, so each label carries its English and Arabic text. The Arabic here must
// match pos_next/translations/ar.csv (checked by receiptLabels.test.js), which the server
// print format "UAE Tax Invoice 80mm" uses through `_(text, "ar")`.

/** @typedef {{ en: string, ar: string }} Bilingual */

export const LABELS = Object.freeze({
	taxInvoice: { en: "Tax Invoice", ar: "فاتورة ضريبية" },
	simplifiedTaxInvoice: {
		en: "Simplified Tax Invoice",
		ar: "فاتورة ضريبية مبسطة",
	},
	taxCreditNote: { en: "Tax Credit Note", ar: "إشعار دائن ضريبي" },
	trn: { en: "TRN", ar: "الرقم الضريبي" },
	invoiceNo: { en: "Invoice No.", ar: "رقم الفاتورة" },
	creditNoteNo: { en: "Credit Note No.", ar: "رقم الإشعار الدائن" },
	originalInvoice: { en: "Original invoice", ar: "الفاتورة الأصلية" },
	date: { en: "Date", ar: "التاريخ" },
	till: { en: "Till", ar: "نقطة البيع" },
	cashier: { en: "Cashier", ar: "أمين الصندوق" },
	salesPerson: { en: "Sales person", ar: "مندوب المبيعات" },
	customer: { en: "Customer", ar: "العميل" },
	customerTrn: { en: "Customer TRN", ar: "الرقم الضريبي للعميل" },
	net: { en: "Total excl. VAT", ar: "الإجمالي غير شامل الضريبة" },
	discount: { en: "Discount", ar: "خصم" },
	vat: { en: "VAT", ar: "ضريبة القيمة المضافة" },
	vatRate: { en: "VAT {0}%", ar: "ضريبة القيمة المضافة {0}%" },
	rounding: { en: "Rounding", ar: "التقريب" },
	total: { en: "Total incl. VAT", ar: "الإجمالي شامل الضريبة" },
	payments: { en: "Payments", ar: "المدفوعات" },
	change: { en: "Change", ar: "الباقي" },
	refund: { en: "Refund", ar: "استرداد" },
	balanceDue: { en: "Balance due", ar: "المبلغ المستحق" },
	thankYou: { en: "Thank you", ar: "شكراً لكم" },
	reprint: { en: "REPRINT", ar: "نسخة معادة" },
	offline: { en: "OFFLINE - PENDING SYNC", ar: "دون اتصال - بانتظار المزامنة" },
})

export const TITLE_MODES = Object.freeze([
	"Tax Invoice",
	"Simplified Tax Invoice",
	"Auto",
])

/**
 * Receipt title. Returns are always a tax credit note. "Auto" prints a full tax invoice
 * when the customer has a TRN and a simplified one otherwise (UAE: simplified tax
 * invoices are allowed for retail sales to customers who are not VAT registered).
 * @param {{ isReturn?: boolean, customerTaxId?: string|null, mode?: string|null }} input
 * @returns {Bilingual}
 */
export function receiptTitle({ isReturn, customerTaxId, mode }) {
	if (isReturn) return LABELS.taxCreditNote
	if (mode === "Simplified Tax Invoice") return LABELS.simplifiedTaxInvoice
	if (mode === "Auto")
		return String(customerTaxId || "").trim()
			? LABELS.taxInvoice
			: LABELS.simplifiedTaxInvoice
	return LABELS.taxInvoice
}

/**
 * Fill "{0}" placeholders in both languages.
 * @param {Bilingual} label
 * @param {unknown[]} args
 * @returns {Bilingual}
 */
export function fill(label, args) {
	const sub = (text) =>
		text.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""))
	return { en: sub(label.en), ar: sub(label.ar) }
}

/**
 * VAT rate as printed: "5", "0", "2.5".
 * @param {unknown} rate
 */
export function rateText(rate) {
	const n = Number.parseFloat(/** @type {string} */ (rate))
	if (!Number.isFinite(n)) return ""
	return String(Math.round(n * 100) / 100)
}
