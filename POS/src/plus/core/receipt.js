// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Receipt printing logic (SPEC F9), plain JavaScript with JSDoc types:
// - buildReceiptModel(): one receipt shape from a POS Next invoice (server doc, offline
//   queue doc or `printing.get_receipt_data`), so every print mode prints the same data.
// - textReceipt(): `escpos_text` mode bytes.
// - layoutReceipt(): drawing operations for `raster` mode (painted on a canvas in a worker).
// - planPrint() / shouldKickDrawer(): which mode runs and when the drawer opens.

import { code128ModuleCount, code128Widths } from "./code128.js"
import {
	EscPosBuilder,
	center,
	clampCopies,
	columnsForPaper,
	concatBytes,
	leftRight,
	wrap,
} from "./escpos.js"
import { AED_ARABIC, currencySymbol } from "./money.js"
import { encodeQr } from "./qr.js"
import { LABELS, fill, rateText, receiptTitle } from "./receiptLabels.js"

export const PRINT_MODES = Object.freeze([
	"raster",
	"escpos_text",
	"qz_html",
	"browser",
])
export const QZ_MODES = Object.freeze(["raster", "escpos_text", "qz_html"])

/**
 * @typedef {Object} ReceiptLine
 * @property {string} name
 * @property {string|null} nameAr
 * @property {number} qty
 * @property {string} uom
 * @property {number} rate
 * @property {number} amount
 * @property {number} discount
 * @property {number|null} vatRate  VAT % of the line when known
 *
 * @typedef {Object} ReceiptPayment
 * @property {string} mode
 * @property {number} amount
 * @property {boolean} isCash
 *
 * @typedef {Object} ReceiptModel
 * @property {string} title          English title
 * @property {{en: string, ar: string}} titleBi
 * @property {string} symbol         "AED" or "د.إ" (SPEC section 7)
 * @property {string} company
 * @property {string} address
 * @property {string} taxId
 * @property {string} phone
 * @property {string} invoiceName
 * @property {string} barcodeValue
 * @property {string} date
 * @property {string} time
 * @property {string} posProfile
 * @property {string} cashier
 * @property {string} customer
 * @property {string} customerTaxId
 * @property {string[]} salesPersons
 * @property {ReceiptLine[]} lines
 * @property {boolean} lineVat       true when line VAT rates differ (print per line)
 * @property {number} net
 * @property {number} discount
 * @property {{label: string, amount: number, rate: number|null}[]} taxes
 * @property {number} taxTotal
 * @property {number} grandTotal
 * @property {number} roundingAdjustment
 * @property {number} total          amount to pay (rounded total when rounding is used)
 * @property {ReceiptPayment[]} payments
 * @property {number} paid
 * @property {number} change
 * @property {number} outstanding
 * @property {string} currency
 * @property {boolean} isReturn
 * @property {string} returnAgainst
 * @property {boolean} offline
 * @property {boolean} reprint
 * @property {string} footer
 * @property {string|null} logo     data URL
 */

/**
 * @typedef {Object} ReceiptContext
 * @property {{name?: string, address?: string, tax_id?: string, phone?: string}} [company]
 * @property {string[]} [cashModes]   modes of payment of type Cash
 * @property {string} [footer]
 * @property {string|null} [logo]
 * @property {string} [cashier]
 * @property {string} [currency]     used when the invoice has none (offline queue)
 * @property {boolean} [reprint]
 * @property {string} [titleMode]    "Tax Invoice" | "Simplified Tax Invoice" | "Auto"
 * @property {string} [lang]         till language, for the AED symbol
 * @property {string} [symbolMode]   "By language" | "AED" | "د.إ"
 * @property {number|null} [vatRate] the profile's VAT % (local invoices have no tax rows)
 * @property {Record<string, string>} [arabicNames] item code -> item_name_ar
 * @property {(text: string, args?: unknown[]) => string} [t]  not used: the receipt is
 *   bilingual (English + Arabic) whatever the till language
 */

/** @param {unknown} v */
function num(v) {
	const n = Number.parseFloat(/** @type {string} */ (v))
	return Number.isFinite(n) ? n : 0
}

/** @param {unknown} v */
function str(v) {
	return v == null ? "" : String(v).trim()
}

/** @param {number} n */
export function money(n) {
	const v = Math.round(num(n) * 100) / 100
	return (Object.is(v, -0) ? 0 : v).toFixed(2)
}

/** @param {number} q up to 3 decimals, no trailing zeros */
export function quantity(q) {
	const v = Math.round(num(q) * 1000) / 1000
	return String(v)
}

/**
 * "9:05:33.123" or "09:05" -> "09:05"; anything else -> "".
 * @param {unknown} value
 */
export function clockTime(value) {
	const m = /^(\d{1,2}):(\d{2})/.exec(str(value))
	return m ? `${m[1].padStart(2, "0")}:${m[2]}` : ""
}

/** Names POS Next gives invoices that are not on the server yet. @param {string} name */
export function isLocalInvoiceName(name) {
	return (
		typeof name === "string" &&
		(name.startsWith("pos_offline_") || name.startsWith("OFFLINE-"))
	)
}

/**
 * Build the receipt from a POS Next invoice dict.
 * @param {Record<string, any>} doc
 * @param {ReceiptContext} [ctx]
 * @returns {ReceiptModel}
 */
export function buildReceiptModel(doc, ctx = {}) {
	const cashModes = new Set(ctx.cashModes || [])
	const company = ctx.company || {}
	const arabicNames = ctx.arabicNames || {}
	const items = Array.isArray(doc.items) ? doc.items : []
	const lines = items.map((item) => {
		const qty = num(item.qty ?? item.quantity)
		const rate = num(item.rate ?? item.price_list_rate)
		const amount =
			item.amount != null
				? num(item.amount)
				: Math.round(qty * rate * 100) / 100
		return {
			name: str(item.item_name || item.item_code),
			nameAr:
				str(item.item_name_ar) || str(arabicNames[item.item_code]) || null,
			qty,
			uom: str(item.uom || item.stock_uom),
			rate,
			amount,
			discount: num(item.discount_amount),
			vatRate:
				item.vat_rate == null || item.vat_rate === ""
					? null
					: num(item.vat_rate),
		}
	})
	const rates = new Set(
		lines.filter((l) => l.vatRate != null).map((l) => l.vatRate),
	)
	const linesTotal =
		Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100
	const taxRows = Array.isArray(doc.taxes) ? doc.taxes : []
	const taxes = taxRows
		.map((row) => ({
			label: str(row.description || row.account_head) || LABELS.vat.en,
			amount: num(row.tax_amount_after_discount_amount ?? row.tax_amount),
			rate: row.rate == null || row.rate === "" ? null : num(row.rate),
		}))
		.filter((row) => row.amount !== 0)
	const taxTotal = num(doc.total_taxes_and_charges ?? doc.total_tax)
	// Offline / local invoices carry only the VAT total: print it with the profile's rate.
	if (!taxes.length && taxTotal !== 0 && ctx.vatRate != null)
		taxes.push({
			label: LABELS.vat.en,
			amount: taxTotal,
			rate: num(ctx.vatRate),
		})
	const grandTotal = num(doc.grand_total)
	const rounded = num(doc.rounded_total)
	const roundingAdjustment = num(doc.rounding_adjustment)
	// ERPNext sets rounded_total to 0 when rounding is disabled on the invoice.
	const total = rounded !== 0 ? rounded : grandTotal
	const payments = (Array.isArray(doc.payments) ? doc.payments : [])
		.map((p) => {
			const mode = str(p.mode_of_payment)
			return {
				mode,
				amount: num(p.amount),
				isCash: p.type === "Cash" || cashModes.has(mode),
			}
		})
		.filter((p) => p.amount !== 0)
	const paid =
		doc.paid_amount != null
			? num(doc.paid_amount)
			: payments.reduce((s, p) => s + p.amount, 0)
	const change = num(doc.change_amount)
	const outstanding =
		doc.outstanding_amount != null
			? Math.max(0, num(doc.outstanding_amount))
			: Math.max(0, total - paid)
	const name = str(doc.name)
	const isReturn = Boolean(Number(doc.is_return))
	const salesPersons = (Array.isArray(doc.sales_team) ? doc.sales_team : [])
		.map((m) => str(m.sales_person))
		.filter(Boolean)
	const postingTime = clockTime(doc.posting_time)
	const customerTaxId = str(doc.customer_tax_id || doc.tax_id)
	const titleBi = receiptTitle({
		isReturn,
		customerTaxId,
		mode: ctx.titleMode,
	})
	const currency = str(doc.currency || ctx.currency)
	return {
		title: titleBi.en,
		titleBi,
		symbol: currencySymbol(currency, {
			lang: ctx.lang,
			mode: ctx.symbolMode,
		}),
		company: str(company.name || doc.company),
		address: str(company.address),
		taxId: str(company.tax_id || doc.company_tax_id),
		phone: str(company.phone),
		invoiceName: name,
		barcodeValue: name,
		date: str(doc.posting_date),
		time: postingTime,
		posProfile: str(doc.pos_profile),
		cashier: str(ctx.cashier || doc.cashier),
		customer: str(doc.customer_name || doc.customer),
		customerTaxId,
		salesPersons,
		lines,
		lineVat: rates.size > 1,
		net:
			doc.net_total != null
				? num(doc.net_total)
				: Math.round((grandTotal - taxTotal) * 100) / 100 || linesTotal,
		discount: Math.abs(num(doc.discount_amount)),
		taxes,
		taxTotal,
		grandTotal,
		roundingAdjustment: rounded !== 0 ? roundingAdjustment : 0,
		total,
		payments,
		paid,
		change,
		outstanding,
		currency,
		isReturn,
		returnAgainst: str(doc.return_against),
		// An online sale printed before its background submit (DECISIONS item 13) is not offline.
		offline:
			!doc.pos0001_background_submit &&
			(Boolean(doc.is_offline) || isLocalInvoiceName(name)),
		reprint: Boolean(ctx.reprint),
		footer: str(ctx.footer),
		logo: ctx.logo || null,
	}
}

/**
 * Pick the receipt barcode: Code128 when it fits at 2 dots per module (about 0.25 mm,
 * scannable), otherwise QR (long offline receipt ids).
 * @param {string} value
 * @param {string} preferred "Code128" | "QR" | "None"
 * @param {number} widthDots printable width
 * @returns {"code128"|"qr"|null}
 */
export function chooseBarcode(value, preferred, widthDots) {
	if (!value || preferred === "None") return null
	if (preferred === "QR") return "qr"
	try {
		const modules = code128ModuleCount(value) + 20 // quiet zones
		return modules * 2 <= widthDots ? "code128" : "qr"
	} catch {
		return "qr"
	}
}

/**
 * Amount with the receipt's currency symbol: "AED 12.50" or "12.50 د.إ".
 * @param {ReceiptModel} m
 * @param {number} value
 * @param {boolean} [latinOnly] text mode: printers have no Arabic glyphs
 */
export function withSymbol(m, value, latinOnly = false) {
	const symbol = latinOnly && m.symbol === AED_ARABIC ? m.currency : m.symbol
	if (!symbol) return money(value)
	return symbol === AED_ARABIC
		? `${money(value)} ${symbol}`
		: `${symbol} ${money(value)}`
}

/**
 * VAT row label: "VAT 5%" when the rate is known, else the tax row's description.
 * @param {{label: string, rate: number|null}} tax
 * @returns {{en: string, ar: string}}
 */
export function taxLabel(tax) {
	if (tax.rate != null) return fill(LABELS.vatRate, [rateText(tax.rate)])
	return { en: tax.label, ar: LABELS.vat.ar }
}

/** "1.25 Kg x 4.50" (+ " VAT 5%" when line rates differ). @param {ReceiptModel} m @param {ReceiptLine} line */
function lineDetail(m, line) {
	const vat =
		m.lineVat && line.vatRate != null
			? ` (${fill(LABELS.vatRate, [rateText(line.vatRate)]).en})`
			: ""
	return `${quantity(line.qty)}${line.uom ? ` ${line.uom}` : ""} x ${money(line.rate)}${vat}`
}

const ARABIC_CHARS = /[֐-ࣿיִ-﷿ﹰ-﻿]/

/** Footer lines a text-mode printer can print (lines with Arabic are left out). @param {string} footer */
export function latinFooter(footer) {
	return str(footer)
		.split(/\r?\n/)
		.filter((row) => !ARABIC_CHARS.test(row))
		.join(" ")
		.trim()
}

/**
 * Text lines of the receipt body (shared by text mode and tests). Text mode prints
 * English only: ESC/POS fonts cannot shape Arabic (use raster mode for Arabic).
 * @param {ReceiptModel} m
 * @param {number} width characters per line
 * @returns {{ head: string[], body: string[] }}
 */
export function receiptTextLines(m, width) {
	const L = (key) => LABELS[key].en
	const head = []
	if (m.company) head.push(center(m.company, width))
	for (const row of wrap(m.address, width)) head.push(center(row, width))
	if (m.taxId) head.push(center(`${L("trn")}: ${m.taxId}`, width))
	if (m.phone) head.push(center(m.phone, width))
	const body = []
	const rule = "-".repeat(width)
	body.push(center(m.title.toUpperCase(), width))
	if (m.reprint) body.push(center(L("reprint"), width))
	if (m.offline) body.push(center(L("offline"), width))
	body.push(rule)
	body.push(
		leftRight(
			L(m.isReturn ? "creditNoteNo" : "invoiceNo"),
			m.invoiceName,
			width,
		),
	)
	if (m.isReturn && m.returnAgainst)
		body.push(leftRight(L("originalInvoice"), m.returnAgainst, width))
	const when = [m.date, m.time].filter(Boolean).join(" ")
	if (when) body.push(leftRight(L("date"), when, width))
	if (m.posProfile) body.push(leftRight(L("till"), m.posProfile, width))
	if (m.cashier) body.push(leftRight(L("cashier"), m.cashier, width))
	if (m.salesPersons.length)
		body.push(leftRight(L("salesPerson"), m.salesPersons.join(", "), width))
	if (m.customer) body.push(leftRight(L("customer"), m.customer, width))
	if (m.customerTaxId)
		body.push(leftRight(L("customerTrn"), m.customerTaxId, width))
	body.push(rule)
	for (const line of m.lines) {
		for (const row of wrap(line.name, width)) body.push(row)
		body.push(leftRight(`  ${lineDetail(m, line)}`, money(line.amount), width))
	}
	body.push(rule)
	body.push(leftRight(L("net"), withSymbol(m, m.net, true), width))
	if (m.discount)
		body.push(leftRight(L("discount"), `-${money(m.discount)}`, width))
	if (m.taxes.length) {
		for (const tax of m.taxes)
			body.push(
				leftRight(taxLabel(tax).en, withSymbol(m, tax.amount, true), width),
			)
	} else if (m.taxTotal)
		body.push(leftRight(L("vat"), withSymbol(m, m.taxTotal, true), width))
	if (m.roundingAdjustment)
		body.push(leftRight(L("rounding"), money(m.roundingAdjustment), width))
	return { head, body }
}

/**
 * `escpos_text` mode: the whole print job (all copies). English only.
 * @param {ReceiptModel} m
 * @param {{ paperWidthMm?: number, columns?: number, cut?: boolean, drawer?: boolean,
 *   copies?: number, barcode?: string }} [options]
 * @returns {Uint8Array}
 */
export function textReceipt(m, options = {}) {
	const L = (key) => LABELS[key].en
	const width = columnsForPaper(options.paperWidthMm ?? 80, options.columns)
	const widthDots = width === 32 ? 384 : 576
	const { head, body } = receiptTextLines(m, width)
	const n = clampCopies(options.copies)
	const jobs = []
	for (let copy = 0; copy < n; copy++) {
		const b = new EscPosBuilder().init()
		if (options.drawer && copy === 0) b.drawerKick()
		b.align("left")
		if (head.length) {
			b.bold(true).line(head[0]).bold(false)
			for (const row of head.slice(1)) b.line(row)
		}
		for (const row of body) b.line(row)
		b.bold(true).size(1, 2)
		b.line(leftRight(L("total"), withSymbol(m, m.total, true), width))
		b.size(1, 1).bold(false)
		if (m.payments.length) {
			for (const p of m.payments)
				b.line(leftRight(p.mode, money(p.amount), width))
		}
		if (m.change) b.line(leftRight(L("change"), money(m.change), width))
		if (m.outstanding > 0.004)
			b.line(leftRight(L("balanceDue"), money(m.outstanding), width))
		b.line("-".repeat(width))
		for (const row of wrap(latinFooter(m.footer) || L("thankYou"), width))
			b.line(center(row, width))
		const kind = chooseBarcode(
			m.barcodeValue,
			options.barcode || "Code128",
			widthDots,
		)
		if (kind) {
			b.align("center")
			if (kind === "code128")
				b.code128(m.barcodeValue, { height: 60, moduleWidth: 2, hri: true })
			else b.qr(m.barcodeValue, { moduleSize: width === 32 ? 4 : 6 })
			b.align("left")
		}
		if (options.cut !== false) b.cut()
		else b.feed(4)
		jobs.push(b.bytes())
	}
	return concatBytes(...jobs)
}

/**
 * @typedef {{type: "text", text: string, align?: "left"|"center"|"right", size?: "sm"|"md"|"lg", bold?: boolean}
 *   | {type: "pair", left: string, right: string, size?: "sm"|"md"|"lg", bold?: boolean}
 *   | {type: "bi", en: string, ar: string, value: string, size?: "sm"|"md"|"lg", bold?: boolean}
 *   | {type: "rule", style?: "dashed"|"solid"}
 *   | {type: "space", height: number}
 *   | {type: "logo"}
 *   | {type: "code128", widths: number[], moduleWidth: number, height: number, label: string}
 *   | {type: "qr", modules: number[][], moduleSize: number, label: string}} DrawOp
 */

/**
 * `raster` mode: drawing operations for the painter, bilingual (UAE tax invoice, SPEC
 * section 7). Text keeps its own script, so Arabic is shaped by the browser's text
 * engine, not the printer.
 * @param {ReceiptModel} m
 * @param {{ widthDots?: number, barcode?: string }} [options]
 * @returns {DrawOp[]}
 */
export function layoutReceipt(m, options = {}) {
	const widthDots = options.widthDots || 576
	/** @type {DrawOp[]} */
	const ops = []
	const text = (value, extra = {}) => {
		if (str(value))
			ops.push({
				type: "text",
				text: str(value),
				align: "center",
				size: "md",
				...extra,
			})
	}
	const pair = (left, right, extra = {}) =>
		ops.push({
			type: "pair",
			left: str(left),
			right: str(right),
			size: "md",
			...extra,
		})
	/** English label, Arabic label, value. @param {{en: string, ar: string}} label */
	const bi = (label, value, extra = {}) =>
		ops.push({
			type: "bi",
			en: label.en,
			ar: label.ar,
			value: str(value),
			size: "md",
			...extra,
		})
	const sm = { size: "sm" }
	if (m.logo) ops.push({ type: "logo" })
	text(m.company, { size: "lg", bold: true })
	text(m.address, sm)
	if (m.taxId) bi(LABELS.trn, m.taxId, { size: "sm", bold: true })
	text(m.phone, sm)
	ops.push({ type: "space", height: 6 })
	text(m.titleBi.en, { size: "lg", bold: true })
	text(m.titleBi.ar, { size: "lg", bold: true })
	if (m.reprint) {
		text(LABELS.reprint.en, { bold: true })
		text(LABELS.reprint.ar, { bold: true })
	}
	if (m.offline) {
		text(LABELS.offline.en, { size: "sm", bold: true })
		text(LABELS.offline.ar, { size: "sm", bold: true })
	}
	ops.push({ type: "rule", style: "dashed" })
	bi(m.isReturn ? LABELS.creditNoteNo : LABELS.invoiceNo, m.invoiceName, sm)
	if (m.isReturn && m.returnAgainst)
		bi(LABELS.originalInvoice, m.returnAgainst, sm)
	const when = [m.date, m.time].filter(Boolean).join(" ")
	if (when) bi(LABELS.date, when, sm)
	if (m.posProfile) bi(LABELS.till, m.posProfile, sm)
	if (m.cashier) bi(LABELS.cashier, m.cashier, sm)
	if (m.salesPersons.length)
		bi(LABELS.salesPerson, m.salesPersons.join(", "), sm)
	if (m.customer) bi(LABELS.customer, m.customer, sm)
	if (m.customerTaxId) bi(LABELS.customerTrn, m.customerTaxId, sm)
	ops.push({ type: "rule", style: "dashed" })
	for (const line of m.lines) {
		ops.push({
			type: "text",
			text: line.name,
			align: "left",
			size: "md",
			bold: true,
		})
		if (line.nameAr)
			ops.push({ type: "text", text: line.nameAr, align: "right", size: "md" })
		pair(lineDetail(m, line), money(line.amount), sm)
	}
	ops.push({ type: "rule", style: "dashed" })
	bi(LABELS.net, withSymbol(m, m.net))
	if (m.discount) bi(LABELS.discount, `-${money(m.discount)}`)
	if (m.taxes.length)
		for (const tax of m.taxes) bi(taxLabel(tax), withSymbol(m, tax.amount))
	else if (m.taxTotal) bi(LABELS.vat, withSymbol(m, m.taxTotal))
	if (m.roundingAdjustment) bi(LABELS.rounding, money(m.roundingAdjustment))
	ops.push({ type: "rule", style: "solid" })
	bi(LABELS.total, withSymbol(m, m.total), { size: "lg", bold: true })
	for (const p of m.payments) pair(p.mode, money(p.amount))
	if (m.change) bi(LABELS.change, withSymbol(m, m.change), { bold: true })
	if (m.outstanding > 0.004)
		bi(LABELS.balanceDue, withSymbol(m, m.outstanding), { bold: true })
	ops.push({ type: "rule", style: "dashed" })
	if (m.footer) text(m.footer, sm)
	else {
		text(LABELS.thankYou.en, sm)
		text(LABELS.thankYou.ar, sm)
	}
	const kind = chooseBarcode(
		m.barcodeValue,
		options.barcode || "Code128",
		widthDots,
	)
	if (kind === "code128") {
		ops.push({ type: "space", height: 8 })
		ops.push({
			type: "code128",
			widths: code128Widths(m.barcodeValue),
			moduleWidth: 2,
			height: 70,
			label: m.barcodeValue,
		})
	} else if (kind === "qr") {
		ops.push({ type: "space", height: 8 })
		const qr = encodeQr(m.barcodeValue)
		ops.push({
			type: "qr",
			modules: qr.modules,
			moduleSize: Math.max(
				3,
				Math.min(6, Math.floor((widthDots * 0.45) / qr.size)),
			),
			label: m.barcodeValue,
		})
	}
	return ops
}

/**
 * @typedef {Object} PrinterProfile
 * @property {string} name
 * @property {string} print_mode        raster | escpos_text | qz_html | browser
 * @property {string} connection        "QZ Local Printer" | "Network"
 * @property {string} [qz_printer]
 * @property {string} [network_host]
 * @property {number} [network_port]
 * @property {number} paper_width_mm
 * @property {number} [dpi]
 * @property {number|boolean} auto_cut
 * @property {number} copies
 * @property {number|boolean} drawer_kick
 * @property {string} [receipt_barcode]
 * @property {number} [characters_per_line]
 * @property {string} [print_format]
 */

/**
 * Decide what actually runs. No printer profile keeps POS Next's own printing.
 * Modes that need QZ fall back to the browser when QZ is not connected.
 * @param {PrinterProfile|null|undefined} printer
 * @param {{ qzConnected: boolean }} state
 * @returns {{ mode: string, fallback: boolean, reason: string|null }}
 */
export function planPrint(printer, { qzConnected }) {
	if (!printer) return { mode: "pos_next", fallback: false, reason: null }
	const mode = PRINT_MODES.includes(printer.print_mode)
		? printer.print_mode
		: "raster"
	if (QZ_MODES.includes(mode) && !qzConnected) {
		return { mode: "browser", fallback: true, reason: "qz_not_connected" }
	}
	if (
		mode !== "browser" &&
		printer.connection === "Network" &&
		!str(printer.network_host)
	) {
		return { mode: "browser", fallback: true, reason: "no_network_host" }
	}
	return { mode, fallback: false, reason: null }
}

/**
 * The drawer opens after a sale paid (or refunded) at least partly in cash, never on
 * reprints. No Sale opens it separately.
 * @param {PrinterProfile|null|undefined} printer
 * @param {ReceiptModel} model
 * @param {{ reason: "sale"|"reprint"|"test" }} job
 */
export function shouldKickDrawer(printer, model, { reason }) {
	if (!printer || !Number(printer.drawer_kick) || reason !== "sale")
		return false
	return model.payments.some((p) => p.isCash && p.amount !== 0)
}
