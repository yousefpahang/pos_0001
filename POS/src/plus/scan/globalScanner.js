// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Scanner input captured on the whole page (SPEC section 6): scans work without focusing the
// search box. Keys typed into inputs are left alone (the search box has its own Enter handling).

import {
	createScannerCapture,
	isEditableTarget,
} from "@/plus/core/scannerCapture"

let lastCollectAt = Number.NEGATIVE_INFINITY
let burstLength = 0

/**
 * True while a scanner burst is arriving (at least two fast keys), so "+" or "-" inside a code
 * is not taken as a shortcut. A single key pressed by a person is never a burst.
 */
export function scanInProgress(now = performance.now(), windowMs = 60) {
	return burstLength > 1 && now - lastCollectAt <= windowMs
}

/** A modal dialog is on screen (frappe-ui / Headless UI dialogs render only while open). */
export function dialogIsOpen() {
	if (typeof document === "undefined") return false
	return Array.from(document.querySelectorAll('[role="dialog"]')).some(
		(el) => el.getClientRects().length > 0,
	)
}

/**
 * @param {Object} options
 * @param {(code: string) => void} options.onScan
 * @param {() => boolean} [options.isBlocked]  e.g. a dialog is open
 * @param {number} [options.maxGapMs]
 * @returns {() => void} uninstall
 */
export function installGlobalScanner({
	onScan,
	isBlocked = dialogIsOpen,
	maxGapMs,
}) {
	if (typeof document === "undefined") return () => {}
	const capture = createScannerCapture({ maxGapMs })

	function onKeyDown(event) {
		if (
			isEditableTarget(event.target) ||
			isEditableTarget(document.activeElement)
		) {
			capture.reset()
			return
		}
		if (isBlocked?.()) {
			capture.reset()
			return
		}
		const result = capture.feed({
			key: event.key,
			time: event.timeStamp || performance.now(),
			ctrl: event.ctrlKey || event.altKey || event.metaKey,
		})
		burstLength = result.type === "collect" ? capture.buffer.length : 0
		if (result.type === "collect") lastCollectAt = performance.now()
		if (result.type === "scan") {
			// The scanner's Enter must not also press a focused button.
			event.preventDefault()
			event.stopPropagation()
			onScan(result.code)
		}
	}

	document.addEventListener("keydown", onKeyDown, true)
	return () => document.removeEventListener("keydown", onKeyDown, true)
}
