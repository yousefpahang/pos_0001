// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Browser printing of the bilingual receipt page (plus/core/receiptHtml.js): opens a
// small window with the page, which calls window.print() when loaded. Works offline.

/** @param {string} text */
function t(text) {
	return typeof __ === "function" ? __(text) : text
}

/**
 * @param {string} html full page from receiptHtml(..., { autoPrint: true })
 * @returns {Window}
 */
export function printReceiptWindow(html) {
	const win = window.open("", "_blank", "width=380,height=640")
	if (!win) throw new Error(t("Popup blocked — check your browser settings."))
	win.document.open()
	win.document.write(html)
	win.document.close()
	return win
}
