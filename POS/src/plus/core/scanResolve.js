// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Order in which a scanned code is resolved (SPEC F5 rule 2, DECISIONS items 3-4):
//   1. exact barcode in the browser cache (UOM barcodes first, then the item barcodes index)
//   2. scale barcode rules, with the PLU looked up in the browser cache
//   3. the server, only when online and still not found
// Pure orchestration: every lookup is injected, so it runs in Vitest and offline.

import { buildScaleItem, itemUomRate, parseScaleBarcode, pluCandidates } from "./scaleBarcode.js"

/**
 * @typedef {Object} ScanCache
 * @property {Array<Object>} rules                                   scale rules for the profile
 * @property {Record<string, string>} plu_map                        scale_plu -> item_code
 * @property {Record<string, {item_code: string, uom?: string}>} uom_barcodes  barcode -> item and UOM
 */

/**
 * @typedef {Object} ScanDeps
 * @property {ScanCache} cache
 * @property {(barcode: string) => Promise<Object|null>} findByBarcode   cached item by barcodes index
 * @property {(itemCode: string) => Promise<Object|null>} findByItemCode  cached item by code
 * @property {() => boolean} isOnline
 * @property {(barcode: string) => Promise<Object|null>} [serverLookup]   POS Next search_by_barcode
 * @property {(barcode: string) => Promise<{item_code: string}|null>} [serverScale]  resolve_scale_barcode
 * @property {() => string} [lineId]
 * @property {number} [rateDecimals]
 */

/**
 * @typedef {Object} ScanResult
 * @property {Object|null} item          item ready for the cart, or null
 * @property {"cache"|"scale"|"server"|null} source
 * @property {{code: string, item_code?: string, item_name?: string, uom?: string}|null} error
 */

/**
 * Apply the UOM a barcode belongs to (for example a box barcode) to a cached item.
 * @param {Object} item
 * @param {string|undefined} uom
 * @returns {Object}
 */
export function withBarcodeUom(item, uom) {
	if (!uom || uom === item.uom) return item
	const info = itemUomRate(item, uom)
	if (!info) return item
	return {
		...item,
		uom: info.uom,
		conversion_factor: info.conversion_factor,
		rate: info.unitRate,
		price_list_rate: info.unitRate,
	}
}

/**
 * Exact barcode match in the browser cache.
 * @param {string} barcode
 * @param {ScanDeps} deps
 * @returns {Promise<Object|null>}
 */
async function findCachedExact(barcode, deps) {
	const mapped = deps.cache?.uom_barcodes?.[barcode]
	if (mapped?.item_code) {
		const item = await deps.findByItemCode(mapped.item_code)
		if (item) return withBarcodeUom(item, mapped.uom)
	}
	return (await deps.findByBarcode(barcode)) || null
}

/**
 * Item a scale PLU points to, from the browser cache.
 * @param {import("./scaleBarcode.js").ParsedScaleBarcode} parsed
 * @param {ScanDeps} deps
 * @returns {Promise<Object|null>}
 */
async function findCachedPlu(parsed, deps) {
	for (const plu of pluCandidates(parsed.plu)) {
		if (parsed.rule.item_match === "Scale PLU") {
			const code = deps.cache?.plu_map?.[plu]
			if (code) {
				const item = await deps.findByItemCode(code)
				if (item) return item
			}
		} else {
			const item = await findCachedExact(plu, deps)
			if (item) return item
		}
	}
	return null
}

/**
 * Resolve a scanned code. Never throws for "not found"; network errors from the
 * server lookups are swallowed when a local answer exists, and rethrown otherwise.
 * @param {string} rawBarcode
 * @param {ScanDeps} deps
 * @returns {Promise<ScanResult>}
 */
export async function resolveScan(rawBarcode, deps) {
	const barcode = String(rawBarcode ?? "").trim()
	const none = { item: null, source: null, error: null }
	if (!barcode) return none

	const exact = await findCachedExact(barcode, deps)
	if (exact) return { item: exact, source: "cache", error: null }

	const parsed = parseScaleBarcode(barcode, deps.cache?.rules || [])
	if (parsed && !parsed.ok) {
		return { item: null, source: null, error: { code: parsed.error } }
	}

	const online = deps.isOnline()
	const opts = { lineId: deps.lineId?.(), rateDecimals: deps.rateDecimals }

	if (parsed) {
		let item = await findCachedPlu(parsed, deps)
		if (!item && online && deps.serverScale && deps.serverLookup) {
			const resolved = await deps.serverScale(barcode)
			if (resolved?.item_code) item = await deps.serverLookup(resolved.item_code)
		}
		if (!item) {
			return { item: null, source: null, error: { code: "plu_not_found", plu: parsed.plu } }
		}
		const built = buildScaleItem(item, parsed, opts)
		if ("error" in built) return { item: null, source: null, error: built.error }
		return { item: built.item, source: "scale", error: null }
	}

	if (online && deps.serverLookup) {
		const item = await deps.serverLookup(barcode)
		if (item) return { item, source: "server", error: null }
	}
	return none
}
