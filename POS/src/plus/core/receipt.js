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
import { encodeQr } from "./qr.js"

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
 *
 * @typedef {Object} ReceiptPayment
 * @property {string} mode
 * @property {number} amount
 * @property {boolean} isCash
 *
 * @typedef {Object} ReceiptModel
 * @property {string} title
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
 * @property {number} net
 * @property {number} discount
 * @property {{label: string, amount: number}[]} taxes
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
 * @property {(text: string, args?: unknown[]) => string} [t]  translator (POS `__`)
 */

/** @param {string} text @param {unknown[]} [args] */
function identity(text, args) {
	if (!args) return text
	return text.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ""))
}

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
	const t = ctx.t || identity
	const cashModes = new Set(ctx.cashModes || [])
	const company = ctx.company || {}
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
			nameAr: str(item.item_name_ar) || null,
			qty,
			uom: str(item.uom || item.stock_uom),
			rate,
			amount,
			discount: num(item.discount_amount),
		}
	})
	const linesTotal =
		Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100
	const taxRows = Array.isArray(doc.taxes) ? doc.taxes : []
	const taxes = taxRows
		.map((row) => ({
			label: str(row.description || row.account_head) || t("Tax"),
			amount: num(row.tax_amount_after_discount_amount ?? row.tax_amount),
		}))
		.filter((row) => row.amount !== 0)
	const taxTotal = num(doc.total_taxes_and_charges ?? doc.total_tax)
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
	return {
		title: isReturn ? t("Credit Note") : t("Tax Invoice"),
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
		customerTaxId: str(doc.customer_tax_id || doc.tax_id),
		salesPersons,
		lines,
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
		currency: str(doc.currency || ctx.currency),
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
 * Text lines of the receipt body (shared by text mode and tests).
 * @param {ReceiptModel} m
 * @param {number} width characters per line
 * @param {(text: string, args?: unknown[]) => string} [t]
 * @returns {{ head: string[], body: string[] }}
 */
export function receiptTextLines(m, width, t = identity) {
	const head = []
	if (m.company) head.push(center(m.company, width))
	for (const row of wrap(m.address, width)) head.push(center(row, width))
	if (m.taxId) head.push(center(`${t("TRN")}: ${m.taxId}`, width))
	if (m.phone) head.push(center(m.phone, width))
	const body = []
	const rule = "-".repeat(width)
	body.push(center(m.title.toUpperCase(), width))
	if (m.reprint) body.push(center(t("REPRINT"), width))
	if (m.offline) body.push(center(t("OFFLINE - PENDING SYNC"), width))
	body.push(rule)
	body.push(leftRight(t("Invoice"), m.invoiceName, width))
	if (m.isReturn && m.returnAgainst)
		body.push(leftRight(t("Against"), m.returnAgainst, width))
	const when = [m.date, m.time].filter(Boolean).join(" ")
	if (when) body.push(leftRight(t("Date"), when, width))
	if (m.posProfile) body.push(leftRight(t("Till"), m.posProfile, width))
	if (m.cashier) body.push(leftRight(t("Cashier"), m.cashier, width))
	if (m.salesPersons.length)
		body.push(leftRight(t("Sales person"), m.salesPersons.join(", "), width))
	if (m.customer) body.push(leftRight(t("Customer"), m.customer, width))
	if (m.customerTaxId)
		body.push(leftRight(t("Customer TRN"), m.customerTaxId, width))
	body.push(rule)
	for (const line of m.lines) {
		for (const row of wrap(line.name, width)) body.push(row)
		const detail = `  ${quantity(line.qty)}${line.uom ? ` ${line.uom}` : ""} x ${money(line.rate)}`
		body.push(leftRight(detail, money(line.amount), width))
	}
	body.push(rule)
	body.push(leftRight(t("Net total"), money(m.net), width))
	if (m.discount)
		body.push(leftRight(t("Discount"), `-${money(m.discount)}`, width))
	if (m.taxes.length) {
		for (const tax of m.taxes)
			body.push(leftRight(tax.label, money(tax.amount), width))
	} else if (m.taxTotal)
		body.push(leftRight(t("VAT"), money(m.taxTotal), width))
	if (m.roundingAdjustment)
		body.push(leftRight(t("Rounding"), money(m.roundingAdjustment), width))
	return { head, body }
}

/**
 * `escpos_text` mode: the whole print job (all copies).
 * @param {ReceiptModel} m
 * @param {{ paperWidthMm?: number, columns?: number, cut?: boolean, drawer?: boolean,
 *   copies?: number, barcode?: string, t?: (text: string, args?: unknown[]) => string }} [options]
 * @returns {Uint8Array}
 */
export function textReceipt(m, options = {}) {
	const t = options.t || identity
	const width = columnsForPaper(options.paperWidthMm ?? 80, options.columns)
	const widthDots = width === 32 ? 384 : 576
	const { head, body } = receiptTextLines(m, width, t)
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
		b.line(
			leftRight(
				t("TOTAL"),
				`${m.currency ? `${m.currency} ` : ""}${money(m.total)}`,
				width,
			),
		)
		b.size(1, 1).bold(false)
		if (m.payments.length) {
			for (const p of m.payments)
				b.line(leftRight(p.mode, money(p.amount), width))
		}
		if (m.change) b.line(leftRight(t("Change"), money(m.change), width))
		if (m.outstanding > 0.004)
			b.line(leftRight(t("Balance due"), money(m.outstanding), width))
		b.line("-".repeat(width))
		for (const row of wrap(m.footer || t("Thank you"), width))
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
 *   | {type: "rule", style?: "dashed"|"solid"}
 *   | {type: "space", height: number}
 *   | {type: "logo"}
 *   | {type: "code128", widths: number[], moduleWidth: number, height: number, label: string}
 *   | {type: "qr", modules: number[][], moduleSize: number, label: string}} DrawOp
 */

/**
 * `raster` mode: drawing operations for the painter. Text keeps its own script, so
 * Arabic item names are shaped by the browser's text engine, not the printer.
 * @param {ReceiptModel} m
 * @param {{ widthDots?: number, barcode?: string, t?: (text: string, args?: unknown[]) => string }} [options]
 * @returns {DrawOp[]}
 */
export function layoutReceipt(m, options = {}) {
	const t = options.t || identity
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
	if (m.logo) ops.push({ type: "logo" })
	text(m.company, { size: "lg", bold: true })
	text(m.address, { size: "sm" })
	if (m.taxId) text(`${t("TRN")}: ${m.taxId}`, { size: "sm" })
	text(m.phone, { size: "sm" })
	ops.push({ type: "space", height: 6 })
	text(m.title, { size: "lg", bold: true })
	if (m.reprint) text(t("REPRINT"), { bold: true })
	if (m.offline) text(t("OFFLINE - PENDING SYNC"), { size: "sm", bold: true })
	ops.push({ type: "rule", style: "dashed" })
	pair(t("Invoice"), m.invoiceName, { size: "sm" })
	if (m.isReturn && m.returnAgainst)
		pair(t("Against"), m.returnAgainst, { size: "sm" })
	const when = [m.date, m.time].filter(Boolean).join(" ")
	if (when) pair(t("Date"), when, { size: "sm" })
	if (m.posProfile) pair(t("Till"), m.posProfile, { size: "sm" })
	if (m.cashier) pair(t("Cashier"), m.cashier, { size: "sm" })
	if (m.salesPersons.length)
		pair(t("Sales person"), m.salesPersons.join(", "), { size: "sm" })
	if (m.customer) pair(t("Customer"), m.customer, { size: "sm" })
	if (m.customerTaxId) pair(t("Customer TRN"), m.customerTaxId, { size: "sm" })
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
		pair(
			`${quantity(line.qty)}${line.uom ? ` ${line.uom}` : ""} x ${money(line.rate)}`,
			money(line.amount),
			{
				size: "sm",
			},
		)
	}
	ops.push({ type: "rule", style: "dashed" })
	pair(t("Net total"), money(m.net))
	if (m.discount) pair(t("Discount"), `-${money(m.discount)}`)
	if (m.taxes.length)
		for (const tax of m.taxes) pair(tax.label, money(tax.amount))
	else if (m.taxTotal) pair(t("VAT"), money(m.taxTotal))
	if (m.roundingAdjustment) pair(t("Rounding"), money(m.roundingAdjustment))
	ops.push({ type: "rule", style: "solid" })
	pair(t("TOTAL"), `${m.currency ? `${m.currency} ` : ""}${money(m.total)}`, {
		size: "lg",
		bold: true,
	})
	for (const p of m.payments) pair(p.mode, money(p.amount))
	if (m.change) pair(t("Change"), money(m.change), { bold: true })
	if (m.outstanding > 0.004)
		pair(t("Balance due"), money(m.outstanding), { bold: true })
	ops.push({ type: "rule", style: "dashed" })
	text(m.footer || t("Thank you"), { size: "sm" })
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
