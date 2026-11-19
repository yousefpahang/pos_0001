// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
/**
 * Item search index (SPEC section 6): one compact row per item with the lowercased name, code,
 * barcodes and Arabic name, kept in IndexedDB and searched in memory in a Web Worker.
 * Pure functions, no DOM, no Vue: used by plus/search/searchIndex.worker.js and Vitest.
 *
 * @typedef {Object} IndexRow
 * @property {string} c   item_code
 * @property {string} n   normalised item name
 * @property {string} k   normalised item code
 * @property {string[]} b barcodes (as stored, trimmed)
 * @property {string} a   normalised Arabic name ("" when none)
 * @property {string} g   item group (for group filters)
 * @property {number} d   1 = disabled
 * @property {number} t   1 = template (has variants)
 * @property {number} v   1 = variant (variant_of set)
 */

export const INDEX_VERSION = 1

// Arabic diacritics (harakat, tanween, shadda, sukun, superscript alef) and tatweel.
const ARABIC_MARKS = /[ً-ٰٟـ]/g
const ALEF_FORMS = /[آأإٱ]/g

/**
 * Lowercase, trim, fold Arabic letter forms so "أرز" matches "ارز" and "ة" matches "ه".
 * @param {unknown} text
 * @returns {string}
 */
export function normalize(text) {
	if (text === null || text === undefined) return ""
	return String(text)
		.toLowerCase()
		.normalize("NFKC")
		.replace(ARABIC_MARKS, "")
		.replace(ALEF_FORMS, "ا")
		.replace(/ى/g, "ي") // alef maqsura -> ya
		.replace(/ة/g, "ه") // ta marbuta -> ha
		.replace(/\s+/g, " ")
		.trim()
}

/**
 * Barcodes of a cached POS Next item. POS Next stores them as an array (`barcodes`) or a
 * comma-joined string (`barcode`, from GROUP_CONCAT).
 * @param {Object} item
 * @returns {string[]}
 */
export function itemBarcodes(item) {
	const out = new Set()
	const add = (value) => {
		if (value === null || value === undefined) return
		for (const part of String(value).split(",")) {
			const code = part.trim()
			if (code) out.add(code)
		}
	}
	if (Array.isArray(item?.barcodes)) {
		for (const b of item.barcodes) add(typeof b === "object" ? b?.barcode : b)
	} else if (item?.barcodes) add(item.barcodes)
	add(item?.barcode)
	if (Array.isArray(item?.item_barcode)) {
		for (const b of item.item_barcode)
			add(typeof b === "object" ? b?.barcode : b)
	}
	return [...out]
}

/**
 * @param {Object} item         Cached POS Next item
 * @param {string} [arabicName] Arabic name when known (Item `item_name_ar`)
 * @returns {IndexRow}
 */
export function buildIndexRow(item, arabicName) {
	return {
		c: String(item.item_code),
		n: normalize(item.item_name),
		k: normalize(item.item_code),
		b: itemBarcodes(item),
		a: normalize(arabicName ?? item.item_name_ar ?? ""),
		g: item.item_group || "",
		d: item.disabled ? 1 : 0,
		t: item.has_variants ? 1 : 0,
		v: item.variant_of ? 1 : 0,
	}
}

/**
 * Same visibility rule as POS Next's worker (`shouldShowItem`).
 * @param {IndexRow} row
 * @param {boolean} showVariantsAsItems
 */
export function isVisible(row, showVariantsAsItems) {
	if (row.d) return false
	return showVariantsAsItems ? !row.t : !row.v
}

/**
 * Score of one row for the query, 0 = no match. Every word must appear in the name, code,
 * Arabic name or a barcode.
 * @param {IndexRow} row
 * @param {string} term     normalised full query
 * @param {string[]} words  normalised words
 * @param {string} raw      trimmed query as typed (for barcodes)
 */
export function scoreRow(row, term, words, raw) {
	if (row.b.length && row.b.includes(raw)) return 10_000
	if (row.k === term) return 9_000
	let score = 0
	if (row.k.startsWith(term)) score = 6_000
	else if (row.n === term || row.a === term) score = 5_000
	else if (row.n.startsWith(term) || row.a.startsWith(term)) score = 4_000
	for (const word of words) {
		const inName = row.n.indexOf(word)
		const inArabic = row.a ? row.a.indexOf(word) : -1
		const inCode = row.k.indexOf(word)
		if (
			inName < 0 &&
			inArabic < 0 &&
			inCode < 0 &&
			!row.b.some((b) => b.startsWith(word))
		)
			return 0
		// Word starts (beginning of the name or after a space) rank above matches inside a word.
		const atWordStart =
			inName === 0 ||
			(inName > 0 && row.n[inName - 1] === " ") ||
			inArabic === 0 ||
			(inArabic > 0 && row.a[inArabic - 1] === " ") ||
			inCode === 0
		score += atWordStart ? 100 : 10
	}
	return score
}

/**
 * Search the index. Returns item codes, best first; ties keep index order (by item name).
 * @param {IndexRow[]} rows
 * @param {string} query
 * @param {Object} [options]
 * @param {number} [options.limit]
 * @param {number} [options.offset]
 * @param {boolean} [options.showVariantsAsItems]
 * @param {string[]} [options.itemGroups]  only these groups when given
 * @returns {{codes: string[], total: number}}
 */
export function searchRows(rows, query, options = {}) {
	const limit = options.limit ?? 50
	const offset = options.offset ?? 0
	const raw = String(query ?? "").trim()
	const term = normalize(raw)
	const groups = options.itemGroups?.length ? new Set(options.itemGroups) : null
	const visible = (row) =>
		isVisible(row, Boolean(options.showVariantsAsItems)) &&
		(!groups || groups.has(row.g))

	if (!term) {
		const codes = []
		let total = 0
		for (const row of rows) {
			if (!visible(row)) continue
			if (total >= offset && codes.length < limit) codes.push(row.c)
			total += 1
		}
		return { codes, total }
	}
	const words = term.split(" ").filter(Boolean)
	/** @type {Array<[number, number]>} */
	const hits = []
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i]
		if (!visible(row)) continue
		const score = scoreRow(row, term, words, raw)
		if (score > 0) hits.push([score, i])
	}
	hits.sort((x, y) => y[0] - x[0] || x[1] - y[1])
	return {
		codes: hits.slice(offset, offset + limit).map(([, i]) => rows[i].c),
		total: hits.length,
	}
}

/**
 * Sort rows the way POS Next lists items (by item name), so an empty query pages like POS Next.
 * @param {IndexRow[]} rows
 */
export function sortRows(rows) {
	return rows.sort((x, y) =>
		x.n < y.n ? -1 : x.n > y.n ? 1 : x.c < y.c ? -1 : 1,
	)
}
