// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Search index worker (SPEC section 6). Builds the item search index from POS Next's item cache
// (IndexedDB "pos_next_offline", store "items") off the main thread, keeps it in its own
// IndexedDB database "pos0001_search" so a reopened till does not rebuild it, and answers
// searches from memory. POS Next's database is only read, never upgraded.
//
// Messages: { id, type, payload } -> { id, ok, result | error }
//   INIT     { profile }                       load the stored index, rebuild when stale
//   REBUILD  { profile }                       rebuild from the item cache now
//   SEARCH   { term, limit, offset, itemGroups, showVariantsAsItems }
//            -> { items, total, ms } or null when the index is not ready
//   STATUS   -> { ready, count, builtAt, buildMs }

import {
	INDEX_VERSION,
	buildIndexRow,
	searchRows,
	sortRows,
} from "@/plus/core/searchIndex"

const POS_DB = "pos_next_offline"
const INDEX_DB = "pos0001_search"
const INDEX_DB_VERSION = 1

/** @type {import("@/plus/core/searchIndex").IndexRow[]} */
let rows = []
let ready = false
let builtAt = null
let buildMs = null
let building = null

function promisify(req) {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result)
		req.onerror = () => reject(req.error)
	})
}

function txDone(tx) {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve()
		tx.onerror = () => reject(tx.error)
		tx.onabort = () => reject(tx.error || new Error("transaction aborted"))
	})
}

/** Open POS Next's database at its current version (never triggers an upgrade). */
async function openPosDb() {
	const db = await promisify(indexedDB.open(POS_DB))
	db.onversionchange = () => db.close()
	return db
}

async function openIndexDb() {
	const req = indexedDB.open(INDEX_DB, INDEX_DB_VERSION)
	req.onupgradeneeded = () => {
		const db = req.result
		if (!db.objectStoreNames.contains("rows"))
			db.createObjectStore("rows", { keyPath: "c" })
		if (!db.objectStoreNames.contains("meta"))
			db.createObjectStore("meta", { keyPath: "key" })
	}
	const db = await promisify(req)
	db.onversionchange = () => db.close()
	return db
}

async function itemCount() {
	const db = await openPosDb()
	try {
		if (!db.objectStoreNames.contains("items")) return 0
		return await promisify(db.transaction("items").objectStore("items").count())
	} finally {
		db.close()
	}
}

/** Arabic names known to this till (Phase 5 label cache) until the item cache carries them. */
async function arabicNames(db, profile) {
	if (!profile || !db.objectStoreNames.contains("settings")) return {}
	try {
		const entry = await promisify(
			db
				.transaction("settings")
				.objectStore("settings")
				.get(`pos0001_label_cache::${profile}`),
		)
		return entry?.value?.ar_names || {}
	} catch {
		return {}
	}
}

async function loadStored() {
	const db = await openIndexDb()
	try {
		const tx = db.transaction(["rows", "meta"])
		const meta = await promisify(tx.objectStore("meta").get("index"))
		if (!meta || meta.version !== INDEX_VERSION) return null
		const stored = await promisify(tx.objectStore("rows").getAll())
		return { meta, rows: stored }
	} finally {
		db.close()
	}
}

async function rebuild(profile) {
	if (building) return building
	building = (async () => {
		const start = performance.now()
		const posDb = await openPosDb()
		let items = []
		let names = {}
		try {
			if (posDb.objectStoreNames.contains("items")) {
				items = await promisify(
					posDb.transaction("items").objectStore("items").getAll(),
				)
			}
			names = await arabicNames(posDb, profile)
		} finally {
			posDb.close()
		}
		const built = sortRows(
			items.map((item) => buildIndexRow(item, names[item.item_code])),
		)
		const indexDb = await openIndexDb()
		try {
			const tx = indexDb.transaction(["rows", "meta"], "readwrite")
			const store = tx.objectStore("rows")
			store.clear()
			for (const row of built) store.put(row)
			tx.objectStore("meta").put({
				key: "index",
				version: INDEX_VERSION,
				count: built.length,
				profile: profile || null,
				builtAt: new Date().toISOString(),
			})
			await txDone(tx)
		} finally {
			indexDb.close()
		}
		rows = built
		ready = true
		builtAt = new Date().toISOString()
		buildMs = Math.round(performance.now() - start)
		return { count: rows.length, built: true, ms: buildMs }
	})()
	try {
		return await building
	} finally {
		building = null
	}
}

async function init(profile) {
	const start = performance.now()
	const [stored, count] = await Promise.all([
		loadStored().catch(() => null),
		itemCount(),
	])
	if (stored?.rows.length && stored.meta.count === count) {
		rows = sortRows(stored.rows)
		ready = true
		builtAt = stored.meta.builtAt
		return {
			count: rows.length,
			built: false,
			ms: Math.round(performance.now() - start),
		}
	}
	if (stored?.rows.length) {
		// Serve the old index while the new one is built.
		rows = sortRows(stored.rows)
		ready = true
	}
	if (!count)
		return {
			count: rows.length,
			built: false,
			ms: Math.round(performance.now() - start),
		}
	return rebuild(profile)
}

async function search({
	term,
	limit = 50,
	offset = 0,
	itemGroups,
	showVariantsAsItems,
}) {
	if (!ready) return null
	const start = performance.now()
	const { codes, total } = searchRows(rows, term, {
		limit,
		offset,
		itemGroups,
		showVariantsAsItems,
	})
	if (!codes.length)
		return { items: [], total, ms: Math.round(performance.now() - start) }
	const db = await openPosDb()
	let items
	try {
		const store = db.transaction("items").objectStore("items")
		items = await Promise.all(codes.map((code) => promisify(store.get(code))))
	} finally {
		db.close()
	}
	return {
		items: items.filter(Boolean),
		total,
		ms: Math.round(performance.now() - start),
	}
}

self.onmessage = async (event) => {
	const { id, type, payload = {} } = event.data || {}
	try {
		let result
		if (type === "INIT") result = await init(payload.profile)
		else if (type === "REBUILD") result = await rebuild(payload.profile)
		else if (type === "SEARCH") result = await search(payload)
		else if (type === "STATUS")
			result = { ready, count: rows.length, builtAt, buildMs }
		else throw new Error(`Unknown message ${type}`)
		self.postMessage({ id, ok: true, result })
	} catch (error) {
		self.postMessage({ id, ok: false, error: String(error?.message || error) })
	}
}
