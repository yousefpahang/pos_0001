// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
/**
 * Global barcode scanner capture (SPEC section 6): a keyboard-wedge scanner "types" the code
 * very fast and ends with Enter. Keys that arrive at most `maxGapMs` (30 ms) apart are collected;
 * a slower key starts over, so a person typing is never mistaken for a scanner.
 * Pure state machine: feed it key events with their time stamps. No DOM, no Vue.
 *
 * @typedef {Object} ScanKey
 * @property {string} key       KeyboardEvent.key
 * @property {number} time      ms (event.timeStamp or performance.now())
 * @property {boolean} [ctrl]   ctrl / alt / meta held: never part of a scan
 *
 * @typedef {{type: "none"} | {type: "collect"} | {type: "scan", code: string}} ScanResult
 */

export const DEFAULT_MAX_GAP_MS = 30
export const DEFAULT_MIN_LENGTH = 4

/**
 * @param {{maxGapMs?: number, minLength?: number}} [options]
 */
export function createScannerCapture(options = {}) {
	const maxGap = options.maxGapMs ?? DEFAULT_MAX_GAP_MS
	const minLength = options.minLength ?? DEFAULT_MIN_LENGTH
	let buffer = ""
	let last = Number.NEGATIVE_INFINITY

	function reset() {
		buffer = ""
		last = Number.NEGATIVE_INFINITY
	}

	/**
	 * @param {ScanKey} event
	 * @returns {ScanResult}
	 */
	function feed(event) {
		const { key, time } = event
		if (event.ctrl) {
			reset()
			return { type: "none" }
		}
		const gap = time - last
		if (key === "Enter" || key === "Tab") {
			const code = buffer
			const fast = gap <= maxGap
			reset()
			if (fast && code.length >= minLength) return { type: "scan", code }
			return { type: "none" }
		}
		if (typeof key !== "string" || key.length !== 1) {
			// Shift and other modifiers come between scanner keys; ignore them without resetting.
			if (key === "Shift")
				return buffer ? { type: "collect" } : { type: "none" }
			reset()
			return { type: "none" }
		}
		if (buffer && gap > maxGap) buffer = ""
		buffer += key
		last = time
		return { type: "collect" }
	}

	return {
		feed,
		reset,
		get buffer() {
			return buffer
		},
	}
}

/**
 * True when the key goes to a place where the cashier types (inputs, text areas, selects,
 * content-editable), so the global capture must leave it alone.
 * @param {{tagName?: string, isContentEditable?: boolean, type?: string}|null} el
 */
export function isEditableTarget(el) {
	if (!el) return false
	if (el.isContentEditable) return true
	const tag = String(el.tagName || "").toUpperCase()
	if (tag === "TEXTAREA" || tag === "SELECT") return true
	if (tag !== "INPUT") return false
	const type = String(el.type || "text").toLowerCase()
	return ![
		"button",
		"checkbox",
		"radio",
		"submit",
		"reset",
		"range",
		"color",
		"file",
	].includes(type)
}
