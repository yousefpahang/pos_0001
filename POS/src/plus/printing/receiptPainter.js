// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Paints raster receipt draw operations (plus/core/receipt.js layoutReceipt) on a 2D
// canvas context. Uses only the Canvas 2D API, so it runs on an OffscreenCanvas in the
// raster Web Worker and on a normal canvas as a fallback. The browser's text engine
// shapes Arabic, which is why raster mode prints Arabic on any ESC/POS printer.

const MARGIN = 8
const GAP = 12
const FONT_FAMILY = "Arial, 'Noto Sans Arabic', 'Segoe UI', Tahoma, sans-serif"
const SIZES = { sm: 21, md: 25, lg: 34 }
const ARABIC = /[֐-ࣿיִ-﷿ﹰ-﻿]/

/** @param {string} text */
export function isRtlText(text) {
	return ARABIC.test(text || "")
}

/** @param {string|undefined} size @param {boolean|undefined} bold */
function font(size, bold) {
	return `${bold ? "bold " : ""}${SIZES[size || "md"]}px ${FONT_FAMILY}`
}

/** @param {string|undefined} size */
function lineHeight(size) {
	return Math.round(SIZES[size || "md"] * 1.3)
}

/**
 * Word wrap by measured width.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} maxWidth
 */
function wrapText(ctx, text, maxWidth) {
	const words = String(text || "")
		.split(/\s+/)
		.filter(Boolean)
	const rows = []
	let current = ""
	for (const word of words) {
		const next = current ? `${current} ${word}` : word
		if (ctx.measureText(next).width <= maxWidth || !current) {
			current = next
			// A single word wider than the line is cut by characters.
			while (ctx.measureText(current).width > maxWidth && current.length > 1) {
				let cut = current.length - 1
				while (
					cut > 1 &&
					ctx.measureText(current.slice(0, cut)).width > maxWidth
				)
					cut--
				rows.push(current.slice(0, cut))
				current = current.slice(cut)
			}
		} else {
			rows.push(current)
			current = word
		}
	}
	if (current) rows.push(current)
	return rows.length ? rows : [""]
}

/**
 * @typedef {Object} PaintOptions
 * @property {number} widthDots
 * @property {CanvasImageSource|null} [logo]
 */

/**
 * Lay out operations: measure every row so the canvas can be sized before drawing.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {import("@/plus/core/receipt").DrawOp[]} ops
 * @param {PaintOptions} options
 */
export function measure(ctx, ops, { widthDots, logo }) {
	const inner = widthDots - MARGIN * 2
	/** @type {Array<Record<string, any>>} */
	const rows = []
	let y = MARGIN
	for (const op of ops) {
		switch (op.type) {
			case "text": {
				ctx.font = font(op.size, op.bold)
				const h = lineHeight(op.size)
				for (const text of wrapText(ctx, op.text, inner)) {
					rows.push({
						kind: "text",
						text,
						y,
						h,
						font: ctx.font,
						align: op.align || "center",
					})
					y += h
				}
				break
			}
			case "pair": {
				ctx.font = font(op.size, op.bold)
				const h = lineHeight(op.size)
				const fullRight = ctx.measureText(op.right).width
				const labelWidth = ctx.measureText(op.left).width
				if (op.right && fullRight + labelWidth + GAP > inner) {
					// Too long for one line: label, then the value right-aligned below it.
					rows.push({
						kind: "pair",
						left: op.left,
						right: "",
						y,
						h,
						font: ctx.font,
					})
					y += h
					for (const text of wrapText(ctx, op.right, inner)) {
						rows.push({
							kind: "text",
							text,
							y,
							h,
							font: ctx.font,
							align: "right",
						})
						y += h
					}
					break
				}
				const rightWidth = Math.min(fullRight, inner * 0.6)
				const leftRows = wrapText(
					ctx,
					op.left,
					Math.max(40, inner - rightWidth - GAP),
				)
				leftRows.forEach((text, i) => {
					rows.push({
						kind: "pair",
						left: text,
						right: i === 0 ? op.right : "",
						y,
						h,
						font: ctx.font,
					})
					y += h
				})
				break
			}
			case "rule":
				rows.push({ kind: "rule", y: y + 6, style: op.style || "dashed" })
				y += 14
				break
			case "space":
				y += op.height
				break
			case "logo": {
				if (!logo) break
				const lw = /** @type {any} */ (logo).width || 1
				const lh = /** @type {any} */ (logo).height || 1
				const scale = Math.min((inner * 0.6) / lw, 160 / lh, 1)
				const w = Math.round(lw * scale)
				const h = Math.round(lh * scale)
				rows.push({ kind: "logo", x: Math.round((widthDots - w) / 2), y, w, h })
				y += h + 8
				break
			}
			case "code128": {
				const total = op.widths.reduce((a, b) => a + b, 0) * op.moduleWidth
				rows.push({
					kind: "code128",
					x: Math.round((widthDots - total) / 2),
					y,
					op,
				})
				y += op.height + 4
				ctx.font = font("sm")
				rows.push({
					kind: "text",
					text: op.label,
					y,
					h: lineHeight("sm"),
					font: ctx.font,
					align: "center",
				})
				y += lineHeight("sm")
				break
			}
			case "qr": {
				const size = op.modules.length * op.moduleSize
				rows.push({ kind: "qr", x: Math.round((widthDots - size) / 2), y, op })
				y += size + 4
				ctx.font = font("sm")
				for (const text of wrapText(ctx, op.label, inner)) {
					rows.push({
						kind: "text",
						text,
						y,
						h: lineHeight("sm"),
						font: ctx.font,
						align: "center",
					})
					y += lineHeight("sm")
				}
				break
			}
			default:
				break
		}
	}
	return { rows, height: y + MARGIN }
}

/**
 * Draw measured rows. The context must belong to a canvas at least `height` tall.
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {ReturnType<typeof measure>} layout
 * @param {PaintOptions} options
 */
export function draw(ctx, layout, { widthDots, logo }) {
	ctx.fillStyle = "#fff"
	ctx.fillRect(0, 0, widthDots, layout.height)
	ctx.fillStyle = "#000"
	ctx.strokeStyle = "#000"
	ctx.textBaseline = "top"
	const left = MARGIN
	const right = widthDots - MARGIN
	for (const row of layout.rows) {
		switch (row.kind) {
			case "text": {
				ctx.font = row.font
				const rtl = isRtlText(row.text)
				ctx.direction = rtl ? "rtl" : "ltr"
				let align = row.align
				if (align === "left" && rtl) align = "right"
				ctx.textAlign =
					align === "center" ? "center" : align === "right" ? "right" : "left"
				const x =
					align === "center" ? widthDots / 2 : align === "right" ? right : left
				ctx.fillText(row.text, x, row.y)
				break
			}
			case "pair": {
				ctx.font = row.font
				ctx.direction = isRtlText(row.left) ? "rtl" : "ltr"
				ctx.textAlign = isRtlText(row.left) ? "right" : "left"
				// RTL labels still sit on the left side so amounts line up on the right.
				const lx = isRtlText(row.left)
					? left + Math.min(ctx.measureText(row.left).width, right - left)
					: left
				ctx.fillText(row.left, lx, row.y)
				if (row.right) {
					ctx.direction = "ltr"
					ctx.textAlign = "right"
					ctx.fillText(row.right, right, row.y)
				}
				break
			}
			case "rule": {
				ctx.lineWidth = row.style === "solid" ? 3 : 2
				ctx.setLineDash(row.style === "solid" ? [] : [8, 6])
				ctx.beginPath()
				ctx.moveTo(left, row.y)
				ctx.lineTo(right, row.y)
				ctx.stroke()
				ctx.setLineDash([])
				break
			}
			case "logo":
				if (logo) ctx.drawImage(logo, row.x, row.y, row.w, row.h)
				break
			case "code128": {
				let x = row.x
				row.op.widths.forEach((w, i) => {
					const px = w * row.op.moduleWidth
					if (i % 2 === 0) ctx.fillRect(x, row.y, px, row.op.height)
					x += px
				})
				break
			}
			case "qr": {
				const s = row.op.moduleSize
				row.op.modules.forEach((line, r) => {
					line.forEach((dark, c) => {
						if (dark) ctx.fillRect(row.x + c * s, row.y + r * s, s, s)
					})
				})
				break
			}
			default:
				break
		}
	}
}
