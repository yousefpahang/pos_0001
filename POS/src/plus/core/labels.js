// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Barcode labels (SPEC F4): label rows (barcode and price incl. VAT per UOM, scale labels),
// raw jobs for ZPL / EPL / TSPL printers and the A4 sheet HTML. Plain JavaScript, works
// offline. Mirrored in pos_next/pos_0001/labels.py and api/labels.py; a shared snapshot
// (pos_next/pos_0001/tests/label_snapshots.json) is checked by Vitest and by the Python
// tests, so both sides print the same bytes.

import { code128Modules } from "./code128.js"
import { ean13Modules, isDigits, isValidEan13 } from "./ean.js"
import { eplBarcode, eplBitmap, eplEscape } from "./epl.js"
import {
	parseTemplate,
	renderNodes,
	usesQty,
	LabelTemplateError,
} from "./labelTemplate.js"
import {
	generateScaleBarcode,
	itemUomRate,
	normalizeRule,
	roundTo,
} from "./scaleBarcode.js"
import { tsplBarcode, tsplBitmap, tsplEscape } from "./tspl.js"
import { mmToDots, stripControls, zplBarcode, zplBitmap, zplEscape } from "./zpl.js"

export { LabelTemplateError, mmToDots }

export const LANGUAGES = Object.freeze(["ZPL", "EPL", "TSPL", "PDF"])
export const RAW_LANGUAGES = Object.freeze(["ZPL", "EPL", "TSPL"])
export const NEWLINE = Object.freeze({ ZPL: "\n", EPL: "\n", TSPL: "\r\n", PDF: "\n" })
export const MAX_ROWS = 500
export const MAX_QTY = 999
export const MAX_LABELS = 2000
export const A4_WIDTH_MM = 210
export const A4_HEIGHT_MM = 297
const FONT_STACK = "'DejaVu Sans', 'Noto Sans', Arial, sans-serif"

/**
 * @typedef {Object} LabelTemplate
 * @property {string} name
 * @property {"ZPL"|"EPL"|"TSPL"|"PDF"} language
 * @property {number} width_mm
 * @property {number} height_mm
 * @property {number} [dpi]
 * @property {number} [gap_mm]
 * @property {"Code128"|"EAN13"} [barcode_type]
 * @property {string} body
 * @property {number} [a4_columns]
 * @property {number} [a4_rows]
 * @property {number} [margins_mm]
 *
 * @typedef {Object} LabelRow  resolved row
 * @property {string} item_code
 * @property {string} item_name
 * @property {string} [item_name_ar]
 * @property {string} uom
 * @property {string} barcode
 * @property {string} [barcode_type]
 * @property {number} price          incl. VAT
 * @property {string} price_text
 * @property {string} price_label
 * @property {string} [weight_label]
 * @property {number} qty            labels to print
 * @property {number} [is_scale]
 *
 * @typedef {(text: string, height: number, maxWidth: number) => import("./zpl.js").Bitmap} BitmapRenderer
 */

// ---------------------------------------------------------------------------
// Small helpers (same output as Python)
// ---------------------------------------------------------------------------

/** Up to 3 decimals, no trailing zeros (38 -> "38", 37.125 -> "37.125"). */
export function fmtNumber(value) {
	let s = Number(value).toFixed(3)
	s = s.replace(/0+$/, "").replace(/\.$/, "")
	return s === "" || s === "-0" ? "0" : s
}

/** Same as Python's html.escape(text, quote=True). @param {unknown} value */
export function htmlEscape(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#x27;")
}

/**
 * Make a value safe inside the template's language.
 * @param {string} language
 * @param {unknown} value
 */
export function escapeFor(language, value) {
	if (language === "PDF") return htmlEscape(value)
	if (language === "ZPL") return zplEscape(value)
	if (language === "EPL") return eplEscape(value)
	if (language === "TSPL") return tsplEscape(value)
	return stripControls(String(value ?? ""))
}

/** First n characters (code points). */
export function fitText(value, length) {
	const n = Math.max(Math.trunc(Number(length) || 0), 0)
	return Array.from(String(value ?? "")).slice(0, n).join("")
}

/** Round half up like Python's floor(x + 0.5). */
function num(value, fallback = 0) {
	const n = Number(value)
	return value === undefined || value === null || value === "" || Number.isNaN(n)
		? fallback
		: Math.floor(n + 0.5)
}

/** EAN-13 only when wanted and valid; anything else prints as Code128. */
export function effectiveBarcodeType(preferred, value) {
	return preferred === "EAN13" && isValidEan13(String(value ?? "")) ? "EAN13" : "Code128"
}

/** Printable ASCII for Code128, falling back to the item code. */
export function code128Safe(value, fallback) {
	const keep = (s) =>
		Array.from(String(s ?? ""))
			.filter((c) => {
				const code = c.codePointAt(0) ?? 0
				return code >= 32 && code <= 126
			})
			.join("")
	return keep(value) || keep(fallback) || "0"
}

/**
 * Pack a 1-bit image (1 = black).
 * @param {number} width
 * @param {number} height
 * @param {(x: number, y: number) => boolean} isBlack
 * @returns {import("./zpl.js").Bitmap}
 */
export function packBits(width, height, isBlack) {
	const bytesPerRow = (width + 7) >> 3
	const data = new Uint8Array(bytesPerRow * height)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (isBlack(x, y)) data[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7)
		}
	}
	return { width, height, bytesPerRow, data }
}

/** Deterministic stand-in used by tests in both languages. @type {BitmapRenderer} */
export function fakeBitmap(text, height, maxWidth) {
	const width = Math.max(1, Math.min(Math.trunc(maxWidth), 4 * Array.from(text).length))
	const h = Math.max(1, Math.min(Math.trunc(height), 6))
	return packBits(width, h, (x, y) => (x + y) % 3 === 0)
}

/**
 * Date in the site's format (dd, mm, yyyy tokens).
 * @param {Date} date
 * @param {string} [format]
 */
export function formatDate(date, format = "yyyy-mm-dd") {
	const dd = String(date.getDate()).padStart(2, "0")
	const mm = String(date.getMonth() + 1).padStart(2, "0")
	const yyyy = String(date.getFullYear())
	return String(format || "yyyy-mm-dd")
		.replace("yyyy", yyyy)
		.replace("dd", dd)
		.replace("mm", mm)
}

// ---------------------------------------------------------------------------
// Rows: barcode and price incl. VAT per UOM (offline copy of api/labels.py)
// ---------------------------------------------------------------------------

/**
 * Shelf price: amount with VAT added, unless prices already include it.
 * @param {number} amount
 * @param {number} vatRate percent
 * @param {number|boolean} pricesIncludeVat
 */
export function priceInclVat(amount, vatRate, pricesIncludeVat) {
	if (Number(pricesIncludeVat)) return roundTo(Number(amount) || 0, 2)
	return roundTo((Number(amount) || 0) * (1 + (Number(vatRate) || 0) / 100), 2)
}

/** @param {number} value */
export function formatPrice(value) {
	return roundTo(Number(value) || 0, 2).toFixed(2)
}

/** Cached item barcodes as a flat list (POS Next may join them with commas). */
export function itemBarcodes(item) {
	const raw = Array.isArray(item?.barcodes)
		? item.barcodes
		: item?.barcodes
			? [item.barcodes]
			: item?.barcode
				? [item.barcode]
				: []
	return raw
		.flatMap((b) => String(b ?? "").split(","))
		.map((b) => b.trim())
		.filter(Boolean)
}

/**
 * Barcode to print for an item in a UOM: that UOM's barcode, else (stock UOM) a barcode
 * without its own UOM, else the item code.
 * @param {Object} item cached item
 * @param {string} uom
 * @param {Record<string, {item_code: string, uom: string}>} [uomBarcodes] scan cache map
 */
export function barcodeFor(item, uom, uomBarcodes = {}) {
	const stockUom = item.stock_uom || item.uom
	for (const [code, info] of Object.entries(uomBarcodes || {})) {
		if (info.item_code === item.item_code && info.uom === uom) return code
	}
	if (uom === stockUom) {
		for (const code of itemBarcodes(item)) {
			const info = uomBarcodes?.[code]
			if (!info || info.uom === stockUom) return code
		}
	}
	return item.item_code
}

/** @param {Object} item */
export function itemUoms(item) {
	const stockUom = item.stock_uom || item.uom
	const others = (item.item_uoms || [])
		.map((u) => u.uom)
		.filter((u) => u && u !== stockUom)
	return [stockUom, ...new Set(others)]
}

/**
 * Scale code (PLU) of an item that fits a rule.
 * @param {ReturnType<typeof normalizeRule>} rule
 * @param {Object} item
 * @param {Record<string, string>} pluMap plu -> item_code
 */
export function itemPlu(rule, item, pluMap = {}) {
	if (rule.item_match === "Scale PLU") {
		const plu =
			item.scale_plu ||
			Object.keys(pluMap || {}).find((p) => pluMap[p] === item.item_code)
		return plu && isDigits(plu) && plu.length <= rule.item_code_length ? plu : null
	}
	return (
		itemBarcodes(item).find((b) => isDigits(b) && b.length <= rule.item_code_length) ||
		null
	)
}

export class LabelRowError extends Error {
	/** @param {string} code @param {Record<string, any>} details */
	constructor(code, details = {}) {
		super(code)
		this.name = "LabelRowError"
		this.code = code
		this.details = details
	}
}

/**
 * One label row from the browser cache (offline): names, barcode and price incl. VAT.
 * @param {{item_code: string, uom?: string, qty?: number, price?: number|string|null,
 *          scale_rule?: string, scale_value?: number}} row
 * @param {Object} item cached item (POS Next item cache)
 * @param {{currency?: string, vat_rate?: number, prices_include_vat?: number,
 *          item_vat?: Record<string, number>, ar_names?: Record<string, string>}} cache label cache
 * @param {{rules?: Object[], plu_map?: Record<string,string>, uom_barcodes?: Object}} [scan] scan cache
 * @returns {LabelRow & {uoms: string[]}}
 */
export function resolveRow(row, item, cache, scan = {}) {
	const qty = Math.trunc(Number(row.qty ?? 1))
	if (!(qty >= 1 && qty <= MAX_QTY)) throw new LabelRowError("qty", { max: MAX_QTY })
	const vatRate = cache.item_vat?.[item.item_code] ?? cache.vat_rate ?? 0
	const include = cache.prices_include_vat ?? 0
	const stockUom = item.stock_uom || item.uom
	const out = {
		item_code: item.item_code,
		item_name: item.item_name || item.item_code,
		item_name_ar: item.item_name_ar || cache.ar_names?.[item.item_code] || "",
		qty,
		uoms: itemUoms(item),
		weight_label: "",
		is_scale: 0,
	}
	let price
	if (row.scale_rule) {
		const raw = (scan.rules || []).find((r) => r.name === row.scale_rule)
		const rule = normalizeRule(raw)
		if (!rule) throw new LabelRowError("rule", { rule: row.scale_rule })
		const value = Number(row.scale_value)
		if (!(value > 0)) throw new LabelRowError("scale_value", { item_code: item.item_code })
		const plu = itemPlu(rule, item, scan.plu_map)
		if (!plu)
			throw new LabelRowError("plu", {
				item_code: item.item_code,
				rule: rule.name,
				digits: rule.item_code_length,
			})
		const uom = rule.uom || stockUom
		const info = itemUomRate(item, uom)
		if (!info) throw new LabelRowError("uom", { item_code: item.item_code, uom })
		const code = generateScaleBarcode(rule, plu, value)
		let amount
		if (rule.value_type === "Weight") {
			const weight = roundTo(value, 3)
			amount = roundTo(weight * info.unitRate, 2)
			out.weight_label = `${weight.toFixed(3)} ${uom}`
		} else {
			amount = roundTo(value, 2)
		}
		price = priceInclVat(amount, vatRate, include)
		Object.assign(out, {
			uom,
			barcode: code,
			is_scale: 1,
			scale_rule: rule.name,
			scale_value: value,
		})
	} else {
		const uom = row.uom || stockUom
		const info = itemUomRate(item, uom)
		if (!info) throw new LabelRowError("uom", { item_code: item.item_code, uom })
		price = priceInclVat(info.unitRate, vatRate, include)
		Object.assign(out, { uom, barcode: barcodeFor(item, uom, scan.uom_barcodes) })
	}
	if (row.price !== undefined && row.price !== null && row.price !== "") {
		price = roundTo(Number(row.price), 2)
		out.price_override = price
	}
	const text = formatPrice(price)
	return Object.assign(out, {
		price,
		price_text: text,
		price_label: `${cache.currency || ""} ${text}`.trim(),
	})
}

/**
 * Barcode type each row prints with (scale labels always EAN-13 when valid).
 * @param {LabelTemplate} template
 * @param {LabelRow[]} rows
 */
export function withBarcodeTypes(template, rows) {
	return rows.map((row) => ({
		...row,
		barcode_type: effectiveBarcodeType(
			row.is_scale ? "EAN13" : template.barcode_type || "Code128",
			row.barcode || "",
		),
	}))
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * @param {LabelTemplate} template
 * @param {Partial<LabelRow>} row
 * @param {{currency?: string, company?: string, date?: string}} base
 */
export function labelContext(template, row, base) {
	const dpi = Number(template.dpi) || 203
	const gap =
		template.gap_mm === undefined || template.gap_mm === null || template.gap_mm === ""
			? 2
			: Number(template.gap_mm)
	return {
		item_code: row.item_code || "",
		item_name: row.item_name || "",
		item_name_ar: row.item_name_ar || "",
		barcode: row.barcode || "",
		barcode_type: row.barcode_type || "Code128",
		uom: row.uom || "",
		price: row.price_text || "",
		price_label: row.price_label || "",
		currency: base.currency || "",
		company: base.company || "",
		date: base.date || "",
		weight: row.weight_label || "",
		qty: Math.trunc(Number(row.qty) || 1),
		width_mm: fmtNumber(template.width_mm),
		height_mm: fmtNumber(template.height_mm),
		width_dots: mmToDots(template.width_mm, dpi),
		height_dots: mmToDots(template.height_mm, dpi),
		gap_mm: fmtNumber(gap),
		gap_dots: mmToDots(gap, dpi),
		dpi,
	}
}

/**
 * Inline SVG barcode for the A4 sheet, digits under it.
 * @param {string} value
 * @param {"EAN13"|"Code128"} kind
 * @param {number} heightMm
 */
export function barcodeSvg(value, kind, heightMm) {
	const modules = kind === "EAN13" ? ean13Modules(value) : code128Modules(value)
	const quiet = 10
	const total = modules.length + 2 * quiet
	let rects = ""
	let i = 0
	while (i < modules.length) {
		if (modules[i] === "1") {
			let j = i
			while (j < modules.length && modules[j] === "1") j++
			rects += `<rect x="${i + quiet}" y="0" width="${j - i}" height="1"/>`
			i = j
		} else i++
	}
	return (
		`<svg class="bc" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} 1" ` +
		`preserveAspectRatio="none" style="height:${fmtNumber(heightMm)}mm">` +
		`${rects}</svg><div class="bc-text">${htmlEscape(value)}</div>`
	)
}

const RAW_BARCODE = { ZPL: zplBarcode, EPL: eplBarcode, TSPL: tsplBarcode }
const RAW_BITMAP = { ZPL: zplBitmap, EPL: eplBitmap, TSPL: tsplBitmap }
const parsed = new Map()

/** @param {string} body */
function nodesFor(body) {
	let nodes = parsed.get(body)
	if (!nodes) {
		nodes = parseTemplate(body)
		if (parsed.size > 50) parsed.clear()
		parsed.set(body, nodes)
	}
	return nodes
}

/**
 * One label: text with \u0000n\u0000 placeholders, plus the binary parts they stand for.
 * @param {LabelTemplate} template
 * @param {Partial<LabelRow>} row
 * @param {{currency?: string, company?: string, date?: string}} base
 * @param {BitmapRenderer} [bitmap]
 * @returns {{text: string, parts: Uint8Array[]}}
 */
export function renderLabel(template, row, base, bitmap) {
	const language = template.language
	const ctx = labelContext(template, row, base)
	/** @type {Uint8Array[]} */
	const parts = []
	const placeholder = (data) => {
		parts.push(data)
		return `\u0000${parts.length - 1}\u0000`
	}
	const helpers = {
		draw_barcode: (...args) => {
			let value = ctx.barcode || ctx.item_code
			if (!value) return ""
			const kind = ctx.barcode_type
			if (kind !== "EAN13") value = code128Safe(value, ctx.item_code)
			if (language === "PDF") {
				const height = args.length ? Number(args[0]) : 10
				return barcodeSvg(value, kind, height)
			}
			return RAW_BARCODE[language]({
				value,
				kind,
				x: num(args[0], 0),
				y: num(args[1], 0),
				height: num(args[2], 50),
				module: Math.max(num(args[3], 2), 1),
			})
		},
		draw_arabic: (text = "", ...args) => {
			const value = text === null || text === undefined ? "" : String(text)
			if (!value.trim()) return ""
			if (language === "PDF")
				return `<span class="ar" dir="rtl" lang="ar">${htmlEscape(value)}</span>`
			if (!bitmap) throw new LabelTemplateError("No Arabic text renderer available.")
			const height = Math.max(num(args[2], 24), 8)
			const maxWidth = Math.max(num(args[3], ctx.width_dots), 8)
			return placeholder(
				RAW_BITMAP[language](num(args[0], 0), num(args[1], 0), bitmap(value, height, maxWidth)),
			)
		},
		fit: (value = "", length = 0) => escapeFor(language, fitText(value, length)),
	}
	let text = renderNodes(nodesFor(template.body), ctx, {
		escape: (value) =>
			value === undefined || value === null ? "" : escapeFor(language, value),
		helpers,
	})
	if (NEWLINE[language] !== "\n") text = text.replace(/\n/g, NEWLINE[language])
	return { text, parts }
}

/**
 * Text (UTF-8) with each placeholder replaced by its binary part.
 * @param {string} text
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
export function assemble(text, parts) {
	const enc = new TextEncoder()
	/** @type {Uint8Array[]} */
	const chunks = text.split("\u0000").map((piece, k) =>
		k % 2 === 0 ? enc.encode(piece) : parts[Number(piece)],
	)
	return concat(chunks)
}

/** @param {Uint8Array[]} chunks */
function concat(chunks) {
	const total = chunks.reduce((n, c) => n + c.length, 0)
	const out = new Uint8Array(total)
	let at = 0
	for (const c of chunks) {
		out.set(c, at)
		at += c.length
	}
	return out
}

/**
 * Total labels; throws when rows or quantities are out of range.
 * @param {Array<{qty?: number}>} rows
 */
export function checkRows(rows) {
	if (rows.length > MAX_ROWS)
		throw new LabelTemplateError(`At most ${MAX_ROWS} rows per print.`)
	let total = 0
	for (const row of rows) {
		const qty = Math.trunc(Number(row.qty ?? 1) || 1)
		if (qty < 1 || qty > MAX_QTY)
			throw new LabelTemplateError(`Label quantity must be between 1 and ${MAX_QTY}.`)
		total += qty
	}
	if (total > MAX_LABELS)
		throw new LabelTemplateError(`At most ${MAX_LABELS} labels per print.`)
	return total
}

/**
 * Raw printer job (ZPL / EPL / TSPL) for all rows.
 * @param {LabelTemplate} template
 * @param {LabelRow[]} rows rows with barcode_type set (withBarcodeTypes)
 * @param {{currency?: string, company?: string, date?: string}} base
 * @param {BitmapRenderer} [bitmap]
 * @returns {Uint8Array}
 */
export function renderRaw(template, rows, base, bitmap) {
	if (!RAW_LANGUAGES.includes(template.language))
		throw new LabelTemplateError("Use renderPdfHtml for PDF templates.")
	checkRows(rows)
	const nl = new TextEncoder().encode(NEWLINE[template.language])
	const ownQty = usesQty(template.body)
	/** @type {Uint8Array[]} */
	const chunks = []
	for (const row of rows) {
		const { text, parts } = renderLabel(template, row, base, bitmap)
		const label = concat([assemble(text, parts), nl])
		const copies = ownQty ? 1 : Math.trunc(Number(row.qty) || 1)
		for (let i = 0; i < copies; i++) chunks.push(label)
	}
	return concat(chunks)
}

/**
 * Cell size and position on an A4 sheet: the grid is centred on the page.
 * @param {LabelTemplate} template
 */
export function gridLayout(template) {
	const cols = Math.trunc(Number(template.a4_columns) || 0)
	const rows = Math.trunc(Number(template.a4_rows) || 0)
	const width = Number(template.width_mm) || 0
	const height = Number(template.height_mm) || 0
	if (cols < 1 || rows < 1)
		throw new LabelTemplateError("A4 Columns and A4 Rows must be at least 1.")
	if (width <= 0 || height <= 0)
		throw new LabelTemplateError("Label width and height must be more than 0.")
	if (cols * width > A4_WIDTH_MM + 0.001 || rows * height > A4_HEIGHT_MM + 0.001)
		throw new LabelTemplateError("The grid does not fit on an A4 sheet (210 x 297 mm).")
	return {
		cols,
		rows,
		width,
		height,
		left: (A4_WIDTH_MM - cols * width) / 2,
		top: (A4_HEIGHT_MM - rows * height) / 2,
		padding: Math.max(Number(template.margins_mm) || 0, 0),
	}
}

/**
 * HTML of the A4 sheets (printed by the browser in the POS; PDF on the server).
 * @param {LabelTemplate} template
 * @param {LabelRow[]} rows
 * @param {{currency?: string, company?: string, date?: string}} base
 */
export function renderPdfHtml(template, rows, base) {
	if (template.language !== "PDF")
		throw new LabelTemplateError("Only PDF templates print on A4 sheets.")
	checkRows(rows)
	const g = gridLayout(template)
	/** @type {string[]} */
	const cells = []
	for (const row of rows) {
		const { text } = renderLabel(template, row, base)
		const copies = Math.trunc(Number(row.qty) || 1)
		for (let i = 0; i < copies; i++) cells.push(text)
	}
	const perPage = g.cols * g.rows
	const pages = []
	for (let start = 0; start < Math.max(cells.length, 1); start += perPage) {
		let chunk = ""
		cells.slice(start, start + perPage).forEach((body, k) => {
			const left = g.left + (k % g.cols) * g.width
			const top = g.top + Math.floor(k / g.cols) * g.height
			chunk += `<div class="cell" style="left:${fmtNumber(left)}mm;top:${fmtNumber(top)}mm">${body}</div>`
		})
		pages.push(`<div class="page">${chunk}</div>`)
	}
	const css =
		"@page{size:A4;margin:0}" +
		"html,body{margin:0;padding:0}" +
		`body{font-family:${FONT_STACK};color:#000}` +
		`.page{position:relative;width:${A4_WIDTH_MM}mm;height:296mm;overflow:hidden;page-break-after:always}` +
		".page:last-child{page-break-after:auto}" +
		`.cell{position:absolute;box-sizing:border-box;width:${fmtNumber(g.width)}mm;` +
		`height:${fmtNumber(g.height)}mm;padding:${fmtNumber(g.padding)}mm;overflow:hidden;font-size:9pt;line-height:1.2}` +
		".name{font-weight:bold;white-space:nowrap;overflow:hidden}" +
		".ar{display:block;direction:rtl;text-align:right;white-space:nowrap;overflow:hidden}" +
		".price{font-size:13pt;font-weight:bold}" +
		".small{font-size:7pt}" +
		".bc{display:block;width:100%}" +
		".bc-text{font-size:7pt;text-align:center;letter-spacing:1px}"
	return (
		'<!DOCTYPE html><html dir="ltr"><head><meta charset="utf-8">' +
		`<title>${htmlEscape(template.name)}</title><style>${css}</style></head>` +
		`<body>${pages.join("")}</body></html>`
	)
}

/** Bytes to base64 (for QZ raw jobs and snapshots). @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
	let bin = ""
	for (let i = 0; i < bytes.length; i += 0x8000) {
		bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	}
	return btoa(bin)
}
