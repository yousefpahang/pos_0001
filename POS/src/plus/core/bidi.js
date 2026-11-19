// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Numbers stay left to right in Arabic layouts (SPEC section 6 UI rules). A date such as
// "11/19/2026, 4:09:35 AM" placed in right-to-left text is reordered by the Unicode bidi
// algorithm ("AM 4:09:35 ,11/19/2026"). Wrapping it in a left-to-right isolate keeps it
// whole. Plain JavaScript, no Vue.

export const LRI = "⁦"
export const PDI = "⁩"

/**
 * Wrap text in a left-to-right isolate when the page is right to left.
 * @param {unknown} text
 * @param {string|null|undefined} dir page direction ("rtl" / "ltr")
 * @returns {string}
 */
export function ltrIsolate(text, dir) {
	const value = text == null ? "" : String(text)
	if (!value || dir !== "rtl" || value.startsWith(LRI)) return value
	return `${LRI}${value}${PDI}`
}

/** Direction of the page ("ltr" outside a browser). */
export function pageDir() {
	return typeof document !== "undefined"
		? document.documentElement.getAttribute("dir") || "ltr"
		: "ltr"
}

/**
 * Wrap a formatter so its result stays left to right on an Arabic page.
 * @template {(...args: any[]) => string} F
 * @param {F} format
 * @returns {F}
 */
export function keepLtr(format) {
	return /** @type {F} */ ((...args) => ltrIsolate(format(...args), pageDir()))
}
