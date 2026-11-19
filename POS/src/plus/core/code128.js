// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Code128 encoder for drawing the receipt barcode into a raster image (SPEC F9).
// Plain JavaScript; returns bar widths, the painter turns them into pixels.

/** Bar/space widths of the 107 Code128 symbols (values 0-105 and Stop). */
export const PATTERNS = Object.freeze([
	"212222",
	"222122",
	"222221",
	"121223",
	"121322",
	"131222",
	"122213",
	"122312",
	"132212",
	"221213",
	"221312",
	"231212",
	"112232",
	"122132",
	"122231",
	"113222",
	"123122",
	"123221",
	"223211",
	"221132",
	"221231",
	"213212",
	"223112",
	"312131",
	"311222",
	"321122",
	"321221",
	"312212",
	"322112",
	"322211",
	"212123",
	"212321",
	"232121",
	"111323",
	"131123",
	"131321",
	"112313",
	"132113",
	"132311",
	"211313",
	"231113",
	"231311",
	"112133",
	"112331",
	"132131",
	"113123",
	"113321",
	"133121",
	"313121",
	"211331",
	"231131",
	"213113",
	"213311",
	"213131",
	"311123",
	"311321",
	"331121",
	"312113",
	"312311",
	"332111",
	"314111",
	"221411",
	"431111",
	"111224",
	"111422",
	"121124",
	"121421",
	"141122",
	"141221",
	"112214",
	"112412",
	"122114",
	"122411",
	"142112",
	"142211",
	"241211",
	"221114",
	"413111",
	"241112",
	"134111",
	"111242",
	"121142",
	"121241",
	"114212",
	"124112",
	"124211",
	"411212",
	"421112",
	"421211",
	"212141",
	"214121",
	"412121",
	"111143",
	"111341",
	"131141",
	"114113",
	"114311",
	"411113",
	"411311",
	"113141",
	"114131",
	"311141",
	"411131",
	"211412",
	"211214",
	"211232",
	"2331112",
])

const START_B = 104
const START_C = 105
const CODE_B = 100
const CODE_C = 99
const STOP = 106

/** @param {string} s @param {number} i */
function digitRun(s, i) {
	let n = 0
	while (
		i + n < s.length &&
		s.charCodeAt(i + n) >= 48 &&
		s.charCodeAt(i + n) <= 57
	)
		n++
	return n
}

/**
 * Symbol values (start, data, checksum, stop). Code set B, switching to code set C
 * for runs of digits where that is shorter.
 * @param {string} text printable ASCII (32-126)
 * @returns {number[]}
 */
export function encodeCode128(text) {
	const s = String(text ?? "")
	if (!s) throw new Error("Code128 needs a value")
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i)
		if (c < 32 || c > 126)
			throw new Error("Code128 value must be printable ASCII")
	}
	/** @type {number[]} */
	const values = []
	let set = ""
	let i = 0
	const allDigits = digitRun(s, 0) === s.length
	if (allDigits && s.length >= 2 && s.length % 2 === 0) {
		values.push(START_C)
		set = "C"
	} else {
		values.push(START_B)
		set = "B"
	}
	while (i < s.length) {
		const run = digitRun(s, i)
		if (set === "C") {
			if (run >= 2) {
				values.push(Number(s.slice(i, i + 2)))
				i += 2
				continue
			}
			values.push(CODE_B)
			set = "B"
			continue
		}
		// In set B: switch to C for 4+ digits at the end or 6+ in the middle (even part only).
		const atEnd = i + run === s.length
		if ((atEnd && run >= 4) || run >= 6) {
			if (run % 2 === 1) {
				values.push(s.charCodeAt(i) - 32)
				i += 1
			}
			values.push(CODE_C)
			set = "C"
			continue
		}
		values.push(s.charCodeAt(i) - 32)
		i += 1
	}
	let sum = values[0]
	for (let k = 1; k < values.length; k++) sum += values[k] * k
	values.push(sum % 103, STOP)
	return values
}

/**
 * Module widths (bar, space, bar, ...) including the stop pattern.
 * @param {string} text
 * @returns {number[]}
 */
export function code128Widths(text) {
	/** @type {number[]} */
	const widths = []
	for (const v of encodeCode128(text)) {
		for (const ch of PATTERNS[v]) widths.push(Number(ch))
	}
	return widths
}

/**
 * Total width in modules (without quiet zones).
 * @param {string} text
 */
export function code128ModuleCount(text) {
	return code128Widths(text).reduce((a, b) => a + b, 0)
}
