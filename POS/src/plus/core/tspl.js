// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// TSPL (TSC, Xprinter and other label printers) commands (SPEC F4). POS Awesome has no
// TSPL builder; written from the TSPL/TSPL2 programming manual. Mirrored in
// pos_next/pos_0001/labels.py.

import { stripControls } from "./zpl.js"

/**
 * Text inside "...": a quote is written \["].
 * @param {unknown} value
 */
export function tsplEscape(value) {
	return stripControls(value == null ? "" : String(value)).replace(
		/"/g,
		'\\["]',
	)
}

/**
 * BARCODE command: EAN13 (12 data digits) or 128, readable text below.
 * @param {{value: string, kind: "EAN13"|"Code128", x: number, y: number, height: number, module: number}} b
 */
export function tsplBarcode({ value, kind, x, y, height, module }) {
	const ean = kind === "EAN13"
	const data = (ean ? value.slice(0, 12) : value).replace(/"/g, '\\["]')
	return `BARCODE ${x},${y},"${ean ? "EAN13" : "128"}",${height},1,0,${module},${module},"${data}"`
}

/**
 * BITMAP command, mode 0 (overwrite), binary, 0 = black.
 * @param {number} x
 * @param {number} y
 * @param {import("./zpl.js").Bitmap} bitmap
 * @returns {Uint8Array}
 */
export function tsplBitmap(x, y, bitmap) {
	const head = new TextEncoder().encode(
		`BITMAP ${x},${y},${bitmap.bytesPerRow},${bitmap.height},0,`,
	)
	const out = new Uint8Array(head.length + bitmap.data.length)
	out.set(head, 0)
	for (let i = 0; i < bitmap.data.length; i++)
		out[head.length + i] = bitmap.data[i] ^ 0xff
	return out
}
