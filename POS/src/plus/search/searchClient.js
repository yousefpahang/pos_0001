// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Main-thread side of the search index worker (plus/search/searchIndex.worker.js).
// quickSearch() answers from the in-memory index in a few milliseconds, with no debounce, so
// the first results show while the cashier is still typing. It returns null when the index is
// not ready (or workers are not available); callers then use POS Next's own search.

import { logger } from "@/utils/logger"

const log = logger.create("PlusSearch")
const REBUILD_DELAY_MS = 2_000

let worker = null
let failed = false
let nextId = 1
const pending = new Map()
let initPromise = null
let initProfile = null
let rebuildTimer = null
let latestSearch = 0

function getWorker() {
	if (failed) return null
	if (worker) return worker
	if (typeof Worker === "undefined") {
		failed = true
		return null
	}
	try {
		worker = new Worker(new URL("./searchIndex.worker.js", import.meta.url), {
			type: "module",
		})
		worker.onmessage = (event) => {
			const { id, ok, result, error } = event.data || {}
			const entry = pending.get(id)
			if (!entry) return
			pending.delete(id)
			if (ok) entry.resolve(result)
			else entry.reject(new Error(error))
		}
		worker.onerror = (event) => {
			log.warn("Search index worker failed", event?.message)
			failed = true
			for (const entry of pending.values())
				entry.reject(new Error("search worker failed"))
			pending.clear()
			worker = null
		}
	} catch (error) {
		log.warn("Search index worker not available", error)
		failed = true
		worker = null
	}
	return worker
}

function send(type, payload) {
	const w = getWorker()
	if (!w) return Promise.resolve(null)
	const id = nextId++
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject })
		w.postMessage({ id, type, payload })
	})
}

/**
 * Load the stored index (or build it) for the till. Safe to call repeatedly.
 * @param {string} profile
 */
export function initSearchIndex(profile) {
	if (initPromise && initProfile === profile) return initPromise
	initProfile = profile
	initPromise = send("INIT", { profile })
		.then((result) => {
			if (result)
				log.info(`Search index ready: ${result.count} items (${result.ms} ms)`)
			return result
		})
		.catch((error) => {
			log.warn("Search index init failed", error)
			initPromise = null
			return null
		})
	return initPromise
}

/**
 * Rebuild after the item cache changed (debounced; the build runs in the worker).
 * @param {string} profile
 */
export function scheduleRebuild(profile) {
	if (rebuildTimer) clearTimeout(rebuildTimer)
	rebuildTimer = setTimeout(() => {
		rebuildTimer = null
		send("REBUILD", { profile })
			.then(
				(result) =>
					result &&
					log.info(
						`Search index rebuilt: ${result.count} items (${result.ms} ms)`,
					),
			)
			.catch((error) => log.warn("Search index rebuild failed", error))
	}, REBUILD_DELAY_MS)
}

/**
 * Search the index. Resolves to cached item objects, or null when the index cannot answer or
 * a newer search has started (stale answers are dropped).
 * @param {string} term
 * @param {{limit?: number, offset?: number, itemGroups?: string[], showVariantsAsItems?: boolean}} [options]
 * @returns {Promise<Array<Object>|null>}
 */
export async function quickSearch(term, options = {}) {
	const ticket = ++latestSearch
	try {
		const result = await send("SEARCH", { term, ...options })
		if (ticket !== latestSearch || !result) return null
		return result.items
	} catch (error) {
		log.warn("Quick search failed", error)
		return null
	}
}

/** @returns {Promise<{ready: boolean, count: number, builtAt: string|null, buildMs: number|null}|null>} */
export function searchIndexStatus() {
	return send("STATUS", {}).catch(() => null)
}

// For e2e tests and support: window.pos0001Search.status() in the browser console.
if (typeof window !== "undefined") {
	window.pos0001Search = {
		status: searchIndexStatus,
		search: (term, options) => send("SEARCH", { term, ...options }),
	}
}
