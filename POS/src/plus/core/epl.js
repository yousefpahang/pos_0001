// Copyright (c) 2026, pos_0001 contributors
// Portions adapted from POS Awesome V15 (frontend/src/posapp/composables/pos/items/
// useZplGenerator.ts: generateEpl, getEplBarcodeType), Copyright (c) the POS Awesome
// contributors, GPL-3.0. See NOTICE.md.
// License: AGPL-3.0. See license.txt
//
// EPL2 (Eltron / older Zebra) label commands (SPEC F4). Mirrored in
// pos_next/pos_0001/labels.py.

import { stripControls } from "./zpl.js"

/**
 * Text inside "...": EPL printer fonts are 8-bit, so characters outside printable ASCII
 * print as "?"; backslash and quote are escaped.
 * @param {unknown} value
 */
export function eplEscape(value) {
	const text = Array.from(stripControls(value == null ? "" : String(value)))
		.map((c) => {
			const code = c.codePointAt(0) ?? 0
			return code >= 32 && code < 127 ? c : "?"
		})
		.join("")
	return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/**
 * B command: EAN-13 (E30, 12 data digits) or Code128 (1, auto subset), readable text below.
 * @param {{value: string, kind: "EAN13"|"Code128", x: number, y: number, height: number, module: number}} b
 */
export function eplBarcode({ value, kind, x, y, height, module }) {
	const ean = kind === "EAN13"
	const data = (ean ? value.slice(0, 12) : value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')
	return `B${x},${y},0,${ean ? "E30" : "1"},${module},${module},${height},B,"${data}"`
}

/**
 * GW graphic (binary, 0 = black).
 * @param {number} x
 * @param {number} y
 * @param {import("./zpl.js").Bitmap} bitmap
 * @returns {Uint8Array}
 */
export function eplBitmap(x, y, bitmap) {
	const head = new TextEncoder().encode(
		`GW${x},${y},${bitmap.bytesPerRow},${bitmap.height},`,
	)
	const out = new Uint8Array(head.length + bitmap.data.length)
	out.set(head, 0)
	for (let i = 0; i < bitmap.data.length; i++) out[head.length + i] = bitmap.data[i] ^ 0xff
	return out
}
