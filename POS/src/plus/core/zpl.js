// Copyright (c) 2026, pos_0001 contributors
// Portions adapted from POS Awesome V15 (frontend/src/posapp/composables/pos/items/
// useZplGenerator.ts: mmToDots, escapeZpl, ^BY/^BC/^BE barcode fields),
// Copyright (c) the POS Awesome contributors, GPL-3.0. See NOTICE.md.
// License: AGPL-3.0. See license.txt
//
// ZPL (Zebra) label commands (SPEC F4). Plain JavaScript, no imports from Vue; mirrored in
// pos_next/pos_0001/labels.py.

/**
 * @typedef {Object} Bitmap
 * @property {number} width          dots
 * @property {number} height         dots
 * @property {number} bytesPerRow
 * @property {Uint8Array} data       bit-packed rows, MSB first, 1 = black
 */

/**
 * Millimetres to printer dots.
 * @param {number} mm
 * @param {number} dpi 203 or 300
 */
export function mmToDots(mm, dpi) {
	return Math.round((Number(mm) * Number(dpi)) / 25.4)
}

/** Control characters become spaces (they would break a command line). @param {string} text */
export function stripControls(text) {
	let out = ""
	for (const ch of text) {
		const code = ch.charCodeAt(0)
		out += code < 32 || code === 127 ? " " : ch
	}
	return out
}

/**
 * Text for a ^FD field: control characters, ^ and ~ (command prefixes) become spaces.
 * @param {unknown} value
 */
export function zplEscape(value) {
	return stripControls(value == null ? "" : String(value)).replace(
		/[\^~]/g,
		" ",
	)
}

/**
 * Barcode field. EAN-13 gets its 12 data digits (the printer adds the check digit);
 * Code128 doubles ">" because ^BC reads ">x" as an invocation code.
 * @param {{value: string, kind: "EAN13"|"Code128", x: number, y: number, height: number, module: number}} b
 */
export function zplBarcode({ value, kind, x, y, height, module }) {
	if (kind === "EAN13") {
		const data = value.slice(0, 12).replace(/[\^~]/g, " ")
		return `^FO${x},${y}^BY${module},3,${height}^BEN,${height},Y,N^FD${data}^FS`
	}
	const data = value.replace(/[\^~]/g, " ").replace(/>/g, "><")
	return `^FO${x},${y}^BY${module},3,${height}^BCN,${height},Y,N,N^FD${data}^FS`
}

/**
 * ^GFA graphic field (ASCII hex, 1 = black).
 * @param {number} x
 * @param {number} y
 * @param {Bitmap} bitmap
 * @returns {Uint8Array}
 */
export function zplBitmap(x, y, bitmap) {
	const total = bitmap.data.length
	let hex = ""
	for (const b of bitmap.data) hex += b.toString(16).padStart(2, "0")
	return new TextEncoder().encode(
		`^FO${x},${y}^GFA,${total},${total},${bitmap.bytesPerRow},${hex.toUpperCase()}^FS`,
	)
}
