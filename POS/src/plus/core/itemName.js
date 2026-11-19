// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Item name shown on the till (SPEC section 7): the Arabic name (Item `item_name_ar`)
// when the till is in Arabic and the item has one, else the item name.

/**
 * @param {{ item_name?: string, item_name_ar?: string|null, item_code?: string }|null|undefined} item
 * @param {string|null|undefined} lang document language ("ar", "ar-AE", "en")
 */
export function itemDisplayName(item, lang) {
	if (!item) return ""
	const arabic = String(item.item_name_ar || "").trim()
	if (
		arabic &&
		String(lang || "")
			.toLowerCase()
			.startsWith("ar")
	)
		return arabic
	return item.item_name || item.item_code || ""
}

/** Current document language (browser only; "en" elsewhere). */
export function pageLang() {
	return typeof document !== "undefined"
		? document.documentElement.lang || "en"
		: "en"
}
