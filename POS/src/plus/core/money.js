// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Currency display for receipts, labels and the till (SPEC section 7): AED with 2
// decimals, written "AED" or "د.إ" per language setting. Digits stay Western (0-9) and
// amounts stay left-to-right in Arabic layouts. Plain JavaScript, no Vue.

export const AED_ARABIC = "د.إ"
export const SYMBOL_MODES = Object.freeze(["By language", "AED", AED_ARABIC])

/**
 * Language code of a locale ("ar-AE" -> "ar").
 * @param {string|null|undefined} lang
 */
export function baseLang(lang) {
	return String(lang || "en")
		.toLowerCase()
		.split(/[-_]/)[0]
}

/**
 * Symbol for a currency. AED follows the setting: "By language" gives "د.إ" in Arabic
 * and "AED" otherwise. Other currencies keep their ISO code.
 * @param {string|null|undefined} currency
 * @param {{ lang?: string|null, mode?: string|null }} [options]
 */
export function currencySymbol(currency, { lang, mode } = {}) {
	const code = String(currency || "").toUpperCase()
	if (code !== "AED") return code
	if (mode === "AED" || mode === AED_ARABIC) return mode
	return baseLang(lang) === "ar" ? AED_ARABIC : "AED"
}

/**
 * Round half away from zero to 2 decimals and print with exactly 2 decimals.
 * @param {unknown} value
 */
export function amount2(value) {
	const n = Number.parseFloat(/** @type {string} */ (value))
	if (!Number.isFinite(n)) return "0.00"
	const v = (Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-9)) / 100
	return (Object.is(v, -0) || v === 0 ? 0 : v).toFixed(2)
}

/**
 * "AED 12.50", or "12.50 د.إ" with the Arabic symbol (after the number, as Arabic
 * receipts write it). Callers draw the result left to right.
 * @param {unknown} value
 * @param {string|null|undefined} currency
 * @param {{ lang?: string|null, mode?: string|null }} [options]
 */
export function formatMoney(value, currency, options = {}) {
	const number = amount2(value)
	const symbol = currencySymbol(currency, options)
	if (!symbol) return number
	return symbol === AED_ARABIC ? `${number} ${symbol}` : `${symbol} ${number}`
}
