// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Till keyboard shortcuts (SPEC section 6). The map lives in plus/core/shortcuts.js; this file
// listens on the page and calls the handlers the till screen passes in. F9 stays with the
// printing store; Esc is handled by the dialogs themselves.

import { isEditableTarget } from "@/plus/core/scannerCapture"
import { resolveShortcut } from "@/plus/core/shortcuts"
import { dialogIsOpen, scanInProgress } from "@/plus/scan/globalScanner"
import { onBeforeUnmount, onMounted } from "vue"

/**
 * @param {Record<string, () => void>} handlers  action name -> handler (see SHORTCUTS)
 * @param {{isActive?: () => boolean}} [options]  e.g. the till screen is shown
 */
export function useShortcuts(handlers, options = {}) {
	function onKeyDown(event) {
		if (options.isActive && !options.isActive()) return
		const action = resolveShortcut(event, {
			typing:
				isEditableTarget(event.target) ||
				isEditableTarget(document.activeElement),
			dialogOpen: dialogIsOpen(),
		})
		if (!action) return
		// A key inside a fast scanner burst belongs to the barcode, not to a shortcut.
		if (
			["qtyUp", "qtyDown", "removeLine", "help"].includes(action) &&
			scanInProgress()
		)
			return
		const handler = handlers[action]
		if (!handler) return
		event.preventDefault()
		event.stopPropagation()
		handler()
	}

	onMounted(() => window.addEventListener("keydown", onKeyDown))
	onBeforeUnmount(() => window.removeEventListener("keydown", onKeyDown))
	return { onKeyDown }
}
