// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Pure logic for the offline invoice queue and the cashier sync log (F1, F12).
// No Vue imports: runs in the browser, the worker and Vitest.

/**
 * @typedef {"Synced" | "Failed" | "Pending" | "Not Found"} ServerSyncStatus
 *
 * @typedef {Object} SubmitResponse  Answer from pos_0001.api.sync.submit_offline_invoice
 * @property {string} offline_id
 * @property {ServerSyncStatus} status
 * @property {string|null} [invoice_name]
 * @property {string|null} [error]
 * @property {boolean} [stored]  true when the server saved payload + error (status Failed)
 *
 * @typedef {"synced" | "stored_failed" | "retry_later"} QueueAction
 *
 * @typedef {Object} SubmitOutcome
 * @property {QueueAction} action
 * @property {string|null} invoiceName
 * @property {string|null} error
 */

/**
 * Decide what the browser queue does with an invoice after the server answered.
 * The invoice leaves the queue only on "synced" or "stored_failed" (DECISIONS.md item 2).
 * Anything unexpected keeps it queued.
 * @param {SubmitResponse|null|undefined} response
 * @returns {SubmitOutcome}
 */
export function classifySubmitResponse(response) {
	if (!response || typeof response !== "object") {
		return {
			action: "retry_later",
			invoiceName: null,
			error: "Invalid server response",
		}
	}
	if (response.status === "Synced" && response.invoice_name) {
		return { action: "synced", invoiceName: response.invoice_name, error: null }
	}
	if (response.status === "Failed" && response.stored === true) {
		return {
			action: "stored_failed",
			invoiceName: null,
			error: response.error || "Rejected by the server",
		}
	}
	return {
		action: "retry_later",
		invoiceName: null,
		error: response.error || null,
	}
}

/**
 * Fields to write on the invoice_queue row for an outcome.
 * A "stored_failed" row is marked synced (it is safe on the server) and keeps the
 * server error so the sync panel can show it while offline.
 * @param {SubmitOutcome} outcome
 * @param {number} [now]
 * @returns {Record<string, unknown>|null} null means "leave the row as it is"
 */
export function queueUpdateFor(outcome, now = Date.now()) {
	if (outcome.action === "synced") {
		return {
			synced: true,
			server_invoice: outcome.invoiceName,
			server_status: "Synced",
			server_error: null,
			synced_at: now,
		}
	}
	if (outcome.action === "stored_failed") {
		return {
			synced: true,
			server_invoice: null,
			server_status: "Failed",
			server_error: outcome.error,
			synced_at: now,
		}
	}
	return null
}

/** Invoices per batch request (server limit: pos_0001.api.sync.MAX_BATCH = 25). */
export const SYNC_BATCH_SIZE = 10

/** Batch requests in flight at the same time. */
export const SYNC_BATCH_LANES = 2

/**
 * Split the queue into batches, keeping the queue order.
 * @template T
 * @param {T[]} rows
 * @param {number} [size]
 * @returns {T[][]}
 */
export function chunkQueue(rows = [], size = SYNC_BATCH_SIZE) {
	const n = Math.max(1, Math.floor(Number(size) || 1))
	/** @type {T[][]} */
	const out = []
	for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n))
	return out
}

/**
 * Pair each queued invoice with its answer from a batch request, by offline_id.
 * An invoice without a matching answer gets null (it is then sent again on its own).
 * @param {string[]} offlineIds  offline_id of each invoice in the batch, in order
 * @param {unknown} responses    answer list from submit_offline_invoices
 * @returns {Array<SubmitResponse|null>}
 */
export function matchBatchResponses(offlineIds, responses) {
	/** @type {Map<string, SubmitResponse>} */
	const byId = new Map()
	if (Array.isArray(responses)) {
		for (const r of responses) {
			if (r && typeof r === "object" && r.offline_id && !byId.has(r.offline_id))
				byId.set(r.offline_id, r)
		}
	}
	return offlineIds.map((id) => (id && byId.get(id)) || null)
}

/**
 * Run async jobs with at most `lanes` running at the same time.
 * Each job's error is caught and returned, so one bad batch does not stop the others.
 * @template T
 * @param {Array<() => Promise<T>>} jobs
 * @param {number} [lanes]
 * @returns {Promise<Array<{ok: true, value: T} | {ok: false, error: unknown}>>}
 */
export async function runInLanes(jobs, lanes = SYNC_BATCH_LANES) {
	/** @type {Array<{ok: true, value: T} | {ok: false, error: unknown}>} */
	const results = new Array(jobs.length)
	let next = 0
	const worker = async () => {
		while (next < jobs.length) {
			const index = next++
			try {
				results[index] = { ok: true, value: await jobs[index]() }
			} catch (error) {
				results[index] = { ok: false, error }
			}
		}
	}
	const count = Math.max(
		1,
		Math.min(Math.floor(Number(lanes) || 1), jobs.length),
	)
	await Promise.all(Array.from({ length: count }, worker))
	return results
}

/**
 * @typedef {Object} SyncLogRow  One line of the sync panel
 * @property {string} offlineId
 * @property {number} time       ms since epoch
 * @property {number} total
 * @property {string} customer
 * @property {"Pending" | "Synced" | "Failed"} status
 * @property {string|null} error  plain words
 * @property {string|null} invoiceName
 * @property {boolean} canRetry   true for server-stored failures
 * @property {"local" | "server"} source
 */

/**
 * Merge the browser queue with Offline Invoice Sync rows from the server.
 * Server rows win for the same offline_id (they are the source of truth once stored).
 * @param {Array<Object>} localRows   invoice_queue rows
 * @param {Array<Object>} serverRows  rows from pos_0001.api.sync.get_sync_status
 * @returns {SyncLogRow[]} newest first
 */
export function buildSyncLogRows(localRows = [], serverRows = []) {
	/** @type {Map<string, SyncLogRow>} */
	const byId = new Map()

	for (const row of localRows) {
		if (!row || row.superseded) continue
		const offlineId = row.offline_id || row.data?.offline_id
		if (!offlineId) continue
		/** @type {SyncLogRow["status"]} */
		let status = "Pending"
		if (row.synced)
			status = row.server_status === "Failed" ? "Failed" : "Synced"
		byId.set(offlineId, {
			offlineId,
			time: Number(row.timestamp) || 0,
			total: Number(row.data?.grand_total ?? row.data?.rounded_total ?? 0),
			customer: row.data?.customer || "",
			status,
			error: plainError(row.synced ? row.server_error : row.error),
			invoiceName: row.server_invoice || null,
			canRetry: status === "Failed",
			source: "local",
		})
	}

	for (const row of serverRows) {
		if (!row?.offline_id) continue
		const local = byId.get(row.offline_id)
		const status =
			row.status === "Synced" || row.status === "Failed"
				? row.status
				: "Pending"
		byId.set(row.offline_id, {
			offlineId: row.offline_id,
			time: local?.time || toMillis(row.creation),
			total: Number(row.grand_total ?? local?.total ?? 0),
			customer: row.customer || local?.customer || "",
			status,
			error: status === "Synced" ? null : plainError(row.error),
			invoiceName: row.sales_invoice || null,
			canRetry: status === "Failed",
			source: "server",
		})
	}

	return [...byId.values()].sort((a, b) => b.time - a.time)
}

/**
 * @typedef {Object} BadgeState
 * @property {"online" | "offline" | "pending" | "failed"} tone
 * @property {number} pending
 * @property {number} failed
 */

/**
 * State of the header sync badge (Online / Offline / n pending / n failed).
 * Failed wins over pending, offline wins over online.
 * @param {{isOffline: boolean, pending: number, failed: number}} input
 * @returns {BadgeState}
 */
export function badgeState({ isOffline, pending = 0, failed = 0 }) {
	const p = Math.max(0, Number(pending) || 0)
	const f = Math.max(0, Number(failed) || 0)
	let tone = isOffline ? "offline" : "online"
	if (p > 0) tone = isOffline ? "offline" : "pending"
	if (f > 0) tone = "failed"
	return { tone, pending: p, failed: f }
}

/**
 * Turn a server or network error into one short line for the cashier.
 * Strips HTML and Python tracebacks; keeps the last meaningful line.
 * @param {unknown} error
 * @returns {string|null}
 */
export function plainError(error) {
	if (error === null || error === undefined || error === "") return null
	let text =
		typeof error === "string"
			? error
			: /** @type {any} */ (error)?.message ||
				/** @type {any} */ (error)?.exc ||
				String(error)
	text = String(text)
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&")
	if (text.includes("Traceback (most recent call last)")) {
		const lines = text
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
		text = lines[lines.length - 1] || text
	}
	text = text.replace(/^[\w.]+(Error|Exception):\s*/, "")
	text = text.replace(/\s+/g, " ").trim()
	if (!text) return null
	return text.length > 300 ? `${text.slice(0, 297)}...` : text
}

/**
 * Whether the sync timer should run now: online, something pending, nothing in flight.
 * @param {{isOffline: boolean, pending: number, isSyncing: boolean}} state
 * @returns {boolean}
 */
export function shouldAutoSync({ isOffline, pending, isSyncing }) {
	return !isOffline && !isSyncing && Number(pending) > 0
}

/** Interval of the "while items are pending" sync timer (SPEC F1). */
export const AUTO_SYNC_INTERVAL_MS = 30_000

/**
 * @param {string|number|Date|null|undefined} value  Frappe datetime "YYYY-MM-DD HH:mm:ss[.ffffff]"
 * @returns {number}
 */
function toMillis(value) {
	if (!value) return 0
	if (typeof value === "number") return value
	if (value instanceof Date) return value.getTime()
	const parsed = Date.parse(String(value).replace(" ", "T"))
	return Number.isNaN(parsed) ? 0 : parsed
}
