// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Bilingual UAE tax invoice as an HTML page (SPEC section 7), for `browser` print mode
// and the browser fallback when QZ Tray is down. Same receipt model and wording as the
// raster receipt (plus/core/receipt.js) and the server print format
// "UAE Tax Invoice 80mm". Plain JavaScript, no Vue, no DOM.

import { code128Widths } from "./code128.js"
import { encodeQr } from "./qr.js"
import {
	chooseBarcode,
	money,
	quantity,
	taxLabel,
	withSymbol,
} from "./receipt.js"
import { LABELS, fill, rateText } from "./receiptLabels.js"

/** @param {unknown} value */
export function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;")
}

/** @param {number[]} widths @param {number} height */
function code128Svg(widths, height) {
	const total = widths.reduce((a, b) => a + b, 0)
	let x = 0
	const bars = []
	widths.forEach((w, i) => {
		if (i % 2 === 0)
			bars.push(`<rect x="${x}" y="0" width="${w}" height="${height}"/>`)
		x += w
	})
	return `<svg class="barcode" viewBox="0 0 ${total} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${bars.join("")}</svg>`
}

/** @param {number[][]} modules */
function qrSvg(modules) {
	const n = modules.length
	const cells = []
	modules.forEach((row, r) => {
		row.forEach((dark, c) => {
			if (dark) cells.push(`<rect x="${c}" y="${r}" width="1" height="1"/>`)
		})
	})
	return `<svg class="qr" viewBox="-2 -2 ${n + 4} ${n + 4}" xmlns="http://www.w3.org/2000/svg">${cells.join("")}</svg>`
}

/**
 * Row with an English label, Arabic label and value.
 * @param {{en: string, ar: string}} label
 * @param {string} value
 * @param {string} [cls]
 */
function bi(label, value, cls = "") {
	return `<div class="bi ${cls}"><span class="en">${escapeHtml(label.en)}</span><span class="ar" dir="rtl" lang="ar">${escapeHtml(label.ar)}</span><span class="val" dir="ltr">${escapeHtml(value)}</span></div>`
}

/**
 * The receipt page.
 * @param {import("./receipt.js").ReceiptModel} m
 * @param {{ paperWidthMm?: number, barcode?: string, autoPrint?: boolean }} [options]
 * @returns {string}
 */
export function receiptHtml(m, options = {}) {
	const width = Number(options.paperWidthMm) === 58 ? 58 : 80
	const parts = []
	const line = (html) => parts.push(html)
	if (m.logo)
		line(
			`<div class="c"><img class="logo" src="${escapeHtml(m.logo)}" alt=""></div>`,
		)
	if (m.company) line(`<div class="c company">${escapeHtml(m.company)}</div>`)
	if (m.address) line(`<div class="c sm">${escapeHtml(m.address)}</div>`)
	if (m.taxId) line(bi(LABELS.trn, m.taxId, "sm b"))
	if (m.phone) line(`<div class="c sm" dir="ltr">${escapeHtml(m.phone)}</div>`)
	line(
		`<div class="c title" data-testid="receipt-title">${escapeHtml(m.titleBi.en)}<br><span dir="rtl" lang="ar">${escapeHtml(m.titleBi.ar)}</span></div>`,
	)
	if (m.reprint)
		line(
			`<div class="c b">${escapeHtml(LABELS.reprint.en)} / <span dir="rtl">${escapeHtml(LABELS.reprint.ar)}</span></div>`,
		)
	if (m.offline)
		line(
			`<div class="c b sm">${escapeHtml(LABELS.offline.en)}<br><span dir="rtl">${escapeHtml(LABELS.offline.ar)}</span></div>`,
		)
	line('<hr class="dash">')
	line(
		bi(
			m.isReturn ? LABELS.creditNoteNo : LABELS.invoiceNo,
			m.invoiceName,
			"sm",
		),
	)
	if (m.isReturn && m.returnAgainst)
		line(bi(LABELS.originalInvoice, m.returnAgainst, "sm"))
	const when = [m.date, m.time].filter(Boolean).join(" ")
	if (when) line(bi(LABELS.date, when, "sm"))
	if (m.posProfile) line(bi(LABELS.till, m.posProfile, "sm"))
	if (m.cashier) line(bi(LABELS.cashier, m.cashier, "sm"))
	if (m.salesPersons.length)
		line(bi(LABELS.salesPerson, m.salesPersons.join(", "), "sm"))
	if (m.customer) line(bi(LABELS.customer, m.customer, "sm"))
	if (m.customerTaxId) line(bi(LABELS.customerTrn, m.customerTaxId, "sm"))
	line('<hr class="dash">')
	for (const l of m.lines) {
		const vat =
			m.lineVat && l.vatRate != null
				? ` · ${escapeHtml(fill(LABELS.vatRate, [rateText(l.vatRate)]).en)}`
				: ""
		line(
			`<div class="item"><div class="b">${escapeHtml(l.name)}</div>${
				l.nameAr
					? `<div class="ar-name" dir="rtl" lang="ar">${escapeHtml(l.nameAr)}</div>`
					: ""
			}<div class="pair sm"><span dir="ltr">${escapeHtml(
				`${quantity(l.qty)}${l.uom ? ` ${l.uom}` : ""} x ${money(l.rate)}`,
			)}${vat}</span><span dir="ltr">${money(l.amount)}</span></div></div>`,
		)
	}
	line('<hr class="dash">')
	line(bi(LABELS.net, withSymbol(m, m.net)))
	if (m.discount) line(bi(LABELS.discount, `-${money(m.discount)}`))
	if (m.taxes.length)
		for (const tax of m.taxes)
			line(bi(taxLabel(tax), withSymbol(m, tax.amount)))
	else if (m.taxTotal) line(bi(LABELS.vat, withSymbol(m, m.taxTotal)))
	if (m.roundingAdjustment)
		line(bi(LABELS.rounding, money(m.roundingAdjustment)))
	line('<hr class="solid">')
	line(bi(LABELS.total, withSymbol(m, m.total), "lg b"))
	for (const p of m.payments)
		line(
			`<div class="pair"><span>${escapeHtml(p.mode)}</span><span dir="ltr">${money(p.amount)}</span></div>`,
		)
	if (m.change) line(bi(LABELS.change, withSymbol(m, m.change), "b"))
	if (m.outstanding > 0.004)
		line(bi(LABELS.balanceDue, withSymbol(m, m.outstanding), "b"))
	line('<hr class="dash">')
	if (m.footer)
		line(
			`<div class="c sm footer">${escapeHtml(m.footer).replace(/\n/g, "<br>")}</div>`,
		)
	else
		line(
			`<div class="c sm">${escapeHtml(LABELS.thankYou.en)}<br><span dir="rtl">${escapeHtml(LABELS.thankYou.ar)}</span></div>`,
		)
	const kind = chooseBarcode(
		m.barcodeValue,
		options.barcode || "Code128",
		width === 58 ? 384 : 576,
	)
	if (kind === "code128")
		line(
			`<div class="c">${code128Svg(code128Widths(m.barcodeValue), 50)}<div class="sm">${escapeHtml(m.barcodeValue)}</div></div>`,
		)
	else if (kind === "qr")
		line(
			`<div class="c">${qrSvg(encodeQr(m.barcodeValue).modules)}<div class="sm code">${escapeHtml(m.barcodeValue)}</div></div>`,
		)
	const script = options.autoPrint
		? "<script>window.addEventListener('load',function(){setTimeout(function(){window.print()},200)})</script>"
		: ""
	return `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><title>${escapeHtml(
		`${m.titleBi.en} ${m.invoiceName}`,
	)}</title><style>
@page{size:${width}mm auto;margin:0}
*{box-sizing:border-box}
body{margin:0 auto;padding:3mm;width:${width}mm;font-family:Arial,"Noto Sans Arabic",Tahoma,sans-serif;font-size:12px;line-height:1.35;color:#000}
.c{text-align:center}.b{font-weight:bold}.sm{font-size:11px}.lg{font-size:15px}
.company{font-size:16px;font-weight:bold}.title{font-size:16px;font-weight:bold;margin:6px 0}
.logo{max-width:60%;max-height:30mm}
.bi{display:flex;align-items:baseline;gap:6px;margin:2px 0}
.bi .en{flex:0 1 auto}.bi .ar{flex:1 1 auto;text-align:right}.bi .val{flex:0 0 auto;text-align:right;white-space:nowrap;max-width:60%;overflow-wrap:anywhere;white-space:normal}
.pair{display:flex;justify-content:space-between;gap:6px;margin:2px 0}
.item{margin:4px 0}.ar-name{text-align:right}
hr{border:0;margin:6px 0}hr.dash{border-top:1px dashed #000}hr.solid{border-top:2px solid #000}
.barcode{width:90%;height:50px;margin-top:6px}.qr{width:40%;margin-top:6px}.code{overflow-wrap:anywhere}
</style></head><body>${parts.join("\n")}${script}</body></html>`
}
