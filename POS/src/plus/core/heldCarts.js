// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
/**
 * Held (parked) carts, pure logic (SPEC F7, DECISIONS.md item 6). No Vue, no network.
 *
 * A held cart lives in one of two places:
 * - on the server as a held draft Sales Invoice (any till of the POS Profile can resume it);
 * - in this browser only, while offline or when the server refused it. Such a local record keeps
 *   `server_state: "local"` (or `"error"` with the reason) and is uploaded on reconnect. It leaves
 *   the browser only when the server confirms it is stored (or already resumed).
 *
 * @typedef {Object} CartSnapshot
 * @property {Array<Object>} items          POS Next cart lines as they were
 * @property {Object|string|null} customer
 * @property {Array<Object>} applied_offers
 * @property {Array<{sales_person: string, allocated_percentage: number}>} sales_team
 *
 * @typedef {Object} HeldEntry  One row of the held list (local or server).
 * @property {string} hold_id
 * @property {string|null} name          Server draft name (= hold_id) when stored on the server
 * @property {"server"|"local"|"error"} source
 * @property {string} held_at            ISO time the cart was parked
 * @property {string|null} customer_name
 * @property {number} total
 * @property {number} item_count
 * @property {string|null} note
 * @property {string|null} held_by
 * @property {string|null} till
 * @property {string|null} error
 */

export const NOTE_MAX_LENGTH = 500
export const DEFAULT_RETENTION_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * New hold id, also the server draft's name.
 * @param {() => string} [uuid]
 * @returns {string}
 */
export function makeHoldId(uuid) {
	const id =
		typeof uuid === "function"
			? uuid()
			: globalThis.crypto?.randomUUID?.() ||
				`${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
	return `HOLD-${id}`
}

/** @param {string|null|undefined} note */
export function cleanNote(note) {
	const value = String(note ?? "").trim()
	return value ? value.slice(0, NOTE_MAX_LENGTH) : null
}

/** @param {Object|string|null|undefined} customer */
export function customerName(customer) {
	if (!customer) return null
	if (typeof customer === "string") return customer
	return customer.customer_name || customer.name || null
}

/** @param {Object|string|null|undefined} customer */
export function customerId(customer) {
	if (!customer) return null
	if (typeof customer === "string") return customer
	return customer.name || null
}

/** @param {number} value */
function round2(value) {
	return Math.round((Number(value) || 0) * 100 + Number.EPSILON) / 100
}

/**
 * Cart total as the till shows it in the list (server rows use ERPNext's grand total).
 * @param {Array<Object>} items
 */
export function cartTotal(items) {
	return round2(
		(items || []).reduce((sum, item) => {
			if (item.amount != null && Number.isFinite(Number(item.amount))) {
				return sum + Number(item.amount)
			}
			const qty = Number(item.quantity ?? item.qty ?? 1) || 0
			return sum + round2(qty * (Number(item.rate) || 0))
		}, 0),
	)
}

/**
 * Plain copy of the cart (no Vue proxies) to store and send.
 * @param {{items: Array<Object>, customer?: any, appliedOffers?: Array<Object>, salesTeam?: Array<Object>}} cart
 * @returns {CartSnapshot}
 */
export function snapshotCart(cart) {
	return JSON.parse(
		JSON.stringify({
			items: cart.items || [],
			customer: cart.customer ?? null,
			applied_offers: cart.appliedOffers || [],
			sales_team: (cart.salesTeam || []).map((row) => ({
				sales_person: row.sales_person,
				sales_person_name: row.sales_person_name || row.sales_person,
				allocated_percentage: Number(row.allocated_percentage) || 0,
			})),
		}),
	)
}

/**
 * Local record stored in POS Next's drafts database (`pos_next_drafts`).
 * `draft_id` = hold id so POS Next's draft helpers find it.
 *
 * @param {Object} args
 * @param {string} args.holdId
 * @param {string} args.posProfile
 * @param {CartSnapshot} args.cart
 * @param {Object} args.invoice       Draft payload for the server (POS Next's saveDraft shape)
 * @param {string|null} [args.note]
 * @param {string|null} [args.user]
 * @param {string|null} [args.deviceId]
 * @param {Date} [args.now]
 */
export function buildLocalRecord({
	holdId,
	posProfile,
	cart,
	invoice,
	note,
	user,
	deviceId,
	now,
}) {
	const time = (now || new Date()).toISOString()
	return {
		draft_id: holdId,
		hold_id: holdId,
		pos_profile: posProfile,
		customer: cart.customer,
		items: cart.items,
		applied_offers: cart.applied_offers,
		sales_team: cart.sales_team,
		invoice,
		note: cleanNote(note),
		held_by: user || null,
		device_id: deviceId || null,
		held_at: time,
		server_state: "local",
		error: null,
	}
}

/**
 * Draft payload for the server from the till's submission lines (no payments, no shift).
 * @param {Object} args
 * @param {string} args.posProfile
 * @param {string|null} args.customer
 * @param {Array<Object>} args.items  Output of POS Next's formatItemsForSubmission()
 * @param {number} [args.discountAmount]
 */
export function buildDraftInvoice({
	posProfile,
	customer,
	items,
	discountAmount,
}) {
	return {
		doctype: "Sales Invoice",
		pos_profile: posProfile,
		customer,
		items,
		discount_amount: Number(discountAmount) || 0,
		is_pos: 1,
		update_stock: 1,
	}
}

/**
 * @param {Object} record  Local record
 * @returns {HeldEntry}
 */
export function localEntry(record) {
	return {
		hold_id: record.hold_id || record.draft_id,
		name: null,
		source: record.server_state === "error" ? "error" : "local",
		held_at: record.held_at || record.created_at,
		customer_name: customerName(record.customer),
		total: cartTotal(record.items),
		item_count: (record.items || []).length,
		items: record.items || [],
		note: record.note || null,
		held_by: record.held_by || null,
		till: null,
		error: record.error || null,
		record,
	}
}

/**
 * @param {Object} row  Row of `held_carts.list_held_carts`
 * @returns {HeldEntry}
 */
export function serverEntry(row) {
	return {
		hold_id: row.hold_id,
		name: row.name,
		source: "server",
		held_at: row.held_at_utc || row.held_at,
		customer_name: row.customer_name || row.customer || null,
		total: Number(row.rounded_total || row.grand_total) || 0,
		item_count: Number(row.item_count) || (row.items || []).length || null,
		total_qty: Number(row.total_qty) || 0,
		items: (row.items || []).map((line) => ({ ...line, quantity: line.qty })),
		note: row.note || null,
		held_by: row.held_by_name || row.held_by || null,
		till: row.device_name || row.pos_device || null,
		error: null,
		record: null,
	}
}

/**
 * One list, newest first. A cart in both places (uploaded, local copy not yet removed) shows once,
 * as the server row.
 * @param {Array<Object>} localRecords
 * @param {Array<Object>} serverRows
 * @returns {HeldEntry[]}
 */
export function mergeHeldLists(localRecords, serverRows) {
	const server = (serverRows || []).map(serverEntry)
	const onServer = new Set(server.map((e) => e.hold_id))
	const local = (localRecords || [])
		.filter((r) => !onServer.has(r.hold_id || r.draft_id))
		.map(localEntry)
	return [...local, ...server].sort(
		(a, b) => timeOf(b.held_at) - timeOf(a.held_at),
	)
}

/** @param {string|null|undefined} iso */
function timeOf(iso) {
	if (!iso) return 0
	const t = Date.parse(
		String(iso).includes("T") ? iso : String(iso).replace(" ", "T"),
	)
	return Number.isFinite(t) ? t : 0
}

/**
 * Local records that still have to reach the server. Records the server refused ("error") are
 * retried too: the cause (a disabled customer, a missing price) may have been fixed.
 * @param {Array<Object>} records
 * @param {string} posProfile
 */
export function pendingUploads(records, posProfile) {
	return (records || []).filter(
		(r) =>
			r.hold_id &&
			r.pos_profile === posProfile &&
			(r.server_state === "local" || r.server_state === "error"),
	)
}

/**
 * What to do with a local record after an upload answer.
 * @param {{status?: string, error?: string}|null} result
 * @returns {{action: "remove"} | {action: "keep", error: string|null}}
 */
export function uploadOutcome(result) {
	if (result?.status === "Held" || result?.status === "Resumed")
		return { action: "remove" }
	if (result?.status === "Failed")
		return { action: "keep", error: result.error || null }
	return { action: "keep", error: null }
}

/**
 * Local records older than the retention days (the server deletes its own).
 * @param {Object} record
 * @param {number} days  0 = keep forever
 * @param {Date} [now]
 */
export function isExpired(record, days, now) {
	if (!days || days <= 0) return false
	const held = timeOf(record.held_at || record.created_at)
	if (!held) return false
	return (now || new Date()).getTime() - held > days * DAY_MS
}

/**
 * A held entry in the shape POS Next's draft lists read (`draft_id`, `customer`, `created_at`,
 * `items`), so its Invoice Management screen keeps working.
 * @param {HeldEntry} entry
 */
export function asLegacyDraft(entry) {
	return {
		...entry,
		draft_id: entry.hold_id,
		customer: entry.customer_name,
		created_at: entry.held_at,
		items: entry.items || [],
	}
}

/**
 * Cart state to put back into the till from a resumed cart (server or local).
 * @param {CartSnapshot|Object} cart
 */
export function restoreCart(cart) {
	return {
		items: Array.isArray(cart?.items) ? cart.items : [],
		customer: cart?.customer ?? null,
		applied_offers: Array.isArray(cart?.applied_offers)
			? cart.applied_offers
			: [],
		sales_team: Array.isArray(cart?.sales_team) ? cart.sales_team : [],
	}
}
