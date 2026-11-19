// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Offline scan cache (SPEC F1/F5): scale barcode rules, Scale PLU map and UOM barcodes
// for the POS Profile, kept in IndexedDB (POS Next's `settings` store) so scanning works
// with the network off. Refreshed in the background while online.

import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"
import { isOffline } from "@/utils/offline"
import { db } from "@/utils/offline/db"

const log = logger.create("ScanCache")
const API = "pos_next.pos_0001.api.barcode"
const KEY_PREFIX = "pos0001_scan_cache::"
const DEFAULT_REFRESH_MINUTES = 5

/** @type {import("@/plus/core/scanResolve").ScanCache} */
const EMPTY = Object.freeze({ rules: [], plu_map: {}, uom_barcodes: {} })

/** @type {Map<string, {cache: Object, loadedAt: number, refreshMinutes: number}>} */
const memory = new Map()
/** @type {Map<string, Promise<Object|null>>} */
const inflight = new Map()
let timer = null
let timerProfile = null

/**
 * @param {string} profile
 * @returns {Promise<{cache: Object, loadedAt: number, refreshMinutes: number}|null>}
 */
async function readStored(profile) {
	if (memory.has(profile)) return memory.get(profile)
	try {
		const row = await db.settings.get(KEY_PREFIX + profile)
		if (row?.value) {
			memory.set(profile, row.value)
			return row.value
		}
	} catch (error) {
		log.warn("Could not read the scan cache", error)
	}
	return null
}

/**
 * Fetch the scan cache from the server and store it. Returns null on failure.
 * @param {string} profile
 * @returns {Promise<Object|null>}
 */
export function refreshScanCache(profile) {
	if (!profile || isOffline()) return Promise.resolve(null)
	if (inflight.has(profile)) return inflight.get(profile)
	const job = (async () => {
		try {
			const data = await call(`${API}.get_scan_cache`, { pos_profile: profile })
			const entry = {
				cache: {
					rules: data?.rules || [],
					plu_map: data?.plu_map || {},
					uom_barcodes: data?.uom_barcodes || {},
				},
				loadedAt: Date.now(),
				refreshMinutes:
					Number(data?.refresh_minutes) || DEFAULT_REFRESH_MINUTES,
			}
			memory.set(profile, entry)
			await db.settings.put({ key: KEY_PREFIX + profile, value: entry })
			return entry.cache
		} catch (error) {
			log.warn("Could not refresh the scan cache", error)
			return null
		} finally {
			inflight.delete(profile)
		}
	})()
	inflight.set(profile, job)
	return job
}

/**
 * Scan cache for a profile: from memory or IndexedDB, never waiting on the network
 * when a stored copy exists. A stale copy triggers a background refresh while online.
 * @param {string} profile
 * @returns {Promise<import("@/plus/core/scanResolve").ScanCache>}
 */
export async function getScanCache(profile) {
	if (!profile) return EMPTY
	const stored = await readStored(profile)
	if (stored) {
		const ageMs = Date.now() - (stored.loadedAt || 0)
		if (ageMs > (stored.refreshMinutes || DEFAULT_REFRESH_MINUTES) * 60_000) {
			refreshScanCache(profile)
		}
		return stored.cache
	}
	return (await refreshScanCache(profile)) || EMPTY
}

/**
 * Load the cache now and keep it fresh every `cache_refresh_minutes` while online.
 * Safe to call repeatedly; switching profile restarts the timer.
 * @param {string} profile
 */
export function startScanCacheRefresh(profile) {
	if (!profile) return
	if (timer && timerProfile === profile) return
	stopScanCacheRefresh()
	timerProfile = profile
	refreshScanCache(profile)
	const minutes = memory.get(profile)?.refreshMinutes || DEFAULT_REFRESH_MINUTES
	timer = setInterval(() => refreshScanCache(profile), minutes * 60_000)
}

export function stopScanCacheRefresh() {
	if (timer) clearInterval(timer)
	timer = null
	timerProfile = null
}
