// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// GS1 mod-10 check digits (EAN-8, UPC-A, EAN-13, GTIN-14 and longer custom codes).
// Pure JavaScript, no imports: used offline by the scanner and by label printing.
// Mirrored in Python by pos_next/pos_0001/scale_barcode.py.

/**
 * True if the string is made of ASCII digits only (and is not empty).
 * @param {unknown} value
 * @returns {value is string}
 */
export function isDigits(value) {
	return typeof value === "string" && /^[0-9]+$/.test(value)
}

/**
 * GS1 check digit for a code body (all digits except the check digit).
 * Weights 3,1,3,1... from the rightmost body digit.
 * @param {string} body
 * @returns {number} 0-9
 */
export function gs1CheckDigit(body) {
	if (!isDigits(body)) throw new Error(`Not a digit string: ${body}`)
	let sum = 0
	for (let i = 0; i < body.length; i++) {
		const digit = body.charCodeAt(body.length - 1 - i) - 48
		sum += i % 2 === 0 ? digit * 3 : digit
	}
	return (10 - (sum % 10)) % 10
}

/**
 * True if the last digit of `code` is its correct GS1 check digit.
 * @param {string} code full code including the check digit (2+ digits)
 * @returns {boolean}
 */
export function hasValidCheckDigit(code) {
	if (!isDigits(code) || code.length < 2) return false
	return gs1CheckDigit(code.slice(0, -1)) === Number(code[code.length - 1])
}

/**
 * Append the GS1 check digit to a body.
 * @param {string} body
 * @returns {string}
 */
export function withCheckDigit(body) {
	return body + String(gs1CheckDigit(body))
}

/**
 * Valid EAN-13 (13 digits, correct check digit).
 * @param {string} code
 * @returns {boolean}
 */
export function isValidEan13(code) {
	return isDigits(code) && code.length === 13 && hasValidCheckDigit(code)
}

const EAN_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"]
const EAN_G = ["0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111"]
const EAN_R = ["1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100"]
const EAN_PARITY = ["LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL"]

/**
 * The 95 modules of a valid EAN-13 ("1" bar, "0" space), guards included.
 * Mirrored by pos_next/pos_0001/barcodes.py `ean13_modules`.
 * @param {string} code
 * @returns {string}
 */
export function ean13Modules(code) {
	if (!isValidEan13(code)) throw new Error("Not a valid EAN-13")
	const parity = EAN_PARITY[Number(code[0])]
	let left = ""
	for (let i = 1; i <= 6; i++) {
		left += (parity[i - 1] === "L" ? EAN_L : EAN_G)[Number(code[i])]
	}
	let right = ""
	for (let i = 7; i <= 12; i++) right += EAN_R[Number(code[i])]
	return `101${left}01010${right}101`
}

/**
 * Valid UPC-A (12 digits, correct check digit).
 * @param {string} code
 * @returns {boolean}
 */
export function isValidUpcA(code) {
	return isDigits(code) && code.length === 12 && hasValidCheckDigit(code)
}

/**
 * Valid EAN-8 (8 digits, correct check digit).
 * @param {string} code
 * @returns {boolean}
 */
export function isValidEan8(code) {
	return isDigits(code) && code.length === 8 && hasValidCheckDigit(code)
}
