// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Browser-first barcode scanning (DECISIONS items 3-4): wires plus/core/scanResolve.js
// to POS Next's IndexedDB item cache, the offline scan cache and the server.

import { resolveScan } from "@/plus/core/scanResolve"
import { getScanCache } from "@/plus/scan/scanCache"
import { call } from "@/utils/apiWrapper"
import { getPrecision } from "@/utils/currency"
import { logger } from "@/utils/logger"
import { isOffline } from "@/utils/offline"
import { db } from "@/utils/offline/db"
import { generateUUID } from "@/utils/offline/uuid"
import { __ } from "@/utils/translation"

const log = logger.create("Scanner")
const API = "pos_next.pos_0001.api.barcode"

/** Error with a message meant for the cashier (shown as a warning, not logged). */
export class ScanError extends Error {
	/** @param {string} userMessage */
	constructor(userMessage) {
		super(userMessage)
		this.name = "ScanError"
		this.userMessage = userMessage
	}
}

/**
 * Cashier message for a resolution error.
 * @param {{code: string, item_code?: string, item_name?: string, uom?: string, plu?: string}} error
 * @param {string} barcode
 * @returns {string}
 */
export function scanErrorMessage(error, barcode) {
	switch (error.code) {
		case "check_digit":
			return __(
				"Barcode {0} has a wrong check digit. Scan it again, or ask a manager to check the scale rule.",
				[barcode],
			)
		case "uom":
			return __(
				"Item {0} ({1}) is not sold in {2}, so this scale barcode cannot be used for it.",
				[error.item_code, error.item_name, error.uom],
			)
		case "no_price":
			return __(
				"Item {0} ({1}) has no price, so the price label cannot be turned into a quantity.",
				[error.item_code, error.item_name],
			)
		case "zero_qty":
			return __("Barcode {0} has a zero weight or price.", [barcode])
		case "plu_not_found":
			return __("No item has scale code {0} (barcode {1}).", [
				error.plu,
				barcode,
			])
		default:
			return __("Item Not Found: No item found with barcode: {0}", [barcode])
	}
}

async function findByBarcode(barcode) {
	try {
		const item = await db.items.where("barcodes").equals(barcode).first()
		return item && !item.disabled ? item : null
	} catch (error) {
		log.warn("Cached barcode lookup failed", error)
		return null
	}
}

async function findByItemCode(itemCode) {
	try {
		const item = await db.items.get(itemCode)
		return item && !item.disabled ? item : null
	} catch (error) {
		log.warn("Cached item lookup failed", error)
		return null
	}
}

/**
 * Resolve a scanned code: browser cache, then scale rules, then the server if online.
 * @param {string} barcode
 * @param {string} posProfile
 * @param {{serverSearch: (barcode: string) => Promise<Object|null>}} options
 *   serverSearch is POS Next's search_by_barcode call
 * @returns {Promise<Object|null>} item for the cart, or null when not found
 * @throws {ScanError} for labels that were read but cannot be sold as printed
 */
export async function resolveScannedBarcode(
	barcode,
	posProfile,
	{ serverSearch },
) {
	const started = performance.now()
	const cache = await getScanCache(posProfile)
	const result = await resolveScan(barcode, {
		cache,
		findByBarcode,
		findByItemCode,
		isOnline: () => !isOffline(),
		serverLookup: async (code) => {
			try {
				return (await serverSearch(code)) || null
			} catch (error) {
				log.debug("Server barcode lookup found nothing", error)
				return null
			}
		},
		serverScale: async (code) => {
			try {
				return await call(`${API}.resolve_scale_barcode`, {
					barcode: code,
					pos_profile: posProfile,
				})
			} catch (error) {
				log.debug("Server scale lookup failed", error)
				return null
			}
		},
		lineId: generateUUID,
		rateDecimals: getPrecision().currency ?? 2,
	})
	log.debug("Scan resolved", {
		barcode,
		source: result.source,
		ms: Math.round(performance.now() - started),
	})
	if (result.error) throw new ScanError(scanErrorMessage(result.error, barcode))
	return result.item
}
