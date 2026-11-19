// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
/**
 * Keyboard shortcut map (SPEC section 6), shown in the "?" overlay. Pure: maps a key event to an
 * action name. Function keys and Ctrl+S work everywhere; Del, + and - and ? only when the cashier
 * is not typing in a field (so they still type into inputs normally).
 *
 * @typedef {Object} Shortcut
 * @property {string} action
 * @property {string[]} keys     labels shown in the overlay
 * @property {string} label      English text, translated by the overlay with __()
 * @property {boolean} [anywhere] also when a text field has focus
 * @property {boolean} [native]  handled elsewhere (dialogs, printing store); listed only
 */

/** @type {Shortcut[]} */
export const SHORTCUTS = [
	{ action: "search", keys: ["F2"], label: "Search items", anywhere: true },
	{
		action: "customer",
		keys: ["F3"],
		label: "Choose customer",
		anywhere: true,
	},
	{ action: "pay", keys: ["F4"], label: "Pay", anywhere: true },
	{
		action: "salesPerson",
		keys: ["F6"],
		label: "Choose sales person",
		anywhere: true,
	},
	{ action: "hold", keys: ["F8"], label: "Hold cart", anywhere: true },
	{
		action: "reprint",
		keys: ["F9"],
		label: "Reprint last receipt",
		anywhere: true,
		native: true,
	},
	{
		action: "saveDraft",
		keys: ["Ctrl", "S"],
		label: "Save cart as draft (hold)",
		anywhere: true,
	},
	{
		action: "close",
		keys: ["Esc"],
		label: "Close dialog",
		anywhere: true,
		native: true,
	},
	{ action: "removeLine", keys: ["Del"], label: "Remove last line" },
	{ action: "qtyUp", keys: ["+"], label: "Last line quantity +1" },
	{ action: "qtyDown", keys: ["-"], label: "Last line quantity -1" },
	{ action: "help", keys: ["?"], label: "Show this list" },
]

const BY_KEY = {
	F2: "search",
	F3: "customer",
	F4: "pay",
	F6: "salesPerson",
	F8: "hold",
	Delete: "removeLine",
	"+": "qtyUp",
	"-": "qtyDown",
	"?": "help",
}

/**
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, repeat?: boolean}} event
 * @param {{typing?: boolean, dialogOpen?: boolean}} [context]
 *   typing: focus is in a text field; dialogOpen: a modal dialog is open
 * @returns {string|null} action, or null to leave the key alone
 */
export function resolveShortcut(event, context = {}) {
	if (!event || event.altKey) return null
	const key = event.key
	if ((event.ctrlKey || event.metaKey) && (key === "s" || key === "S")) {
		return context.dialogOpen ? null : "saveDraft"
	}
	if (event.ctrlKey || event.metaKey) return null
	const action = BY_KEY[key]
	if (!action) return null
	const def = SHORTCUTS.find((s) => s.action === action)
	if (!def.anywhere && context.typing) return null
	// With a dialog open the keys belong to the dialog (Esc closes it there).
	if (context.dialogOpen) return null
	if (event.repeat && action !== "qtyUp" && action !== "qtyDown") return null
	return action
}
