// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Held carts on the till (SPEC F7, DECISIONS.md item 6).
// Online: a held cart goes to the server (pos_0001.api.held_carts) and any till of the same
// POS Profile can resume it. Offline (or when the server refuses it): it stays in POS Next's
// drafts database in this browser and is uploaded on reconnect. A local copy is removed only
// after the server confirms it holds the cart (or that it was already resumed).

import {
	DEFAULT_RETENTION_DAYS,
	buildLocalRecord,
	customerId,
	isExpired,
	makeHoldId,
	mergeHeldLists,
	pendingUploads,
	restoreCart,
	snapshotCart,
	uploadOutcome,
} from "@/plus/core/heldCarts"
import { getDeviceId } from "@/plus/sync/syncClient"
import { session } from "@/data/session"
import { usePOSShiftStore } from "@/stores/posShift"
import { usePOSSyncStore } from "@/stores/posSync"
import { call } from "@/utils/apiWrapper"
import {
	deleteDraft,
	getAllDrafts,
	saveDraft,
	updateDraft,
} from "@/utils/draftManager"
import { logger } from "@/utils/logger"
import { generateUUID } from "@/utils/offline/uuid"
import { defineStore } from "pinia"
import { computed, ref, watch } from "vue"

const API = "pos_next.pos_0001.api.held_carts"
const RETENTION_KEY = "pos0001_held_retention_days"
const log = logger.create("PlusHeldCarts")

/** @param {string} text */
function t(text) {
	return typeof __ === "function" ? __(text) : text
}

function readRetention() {
	try {
		const value = Number.parseInt(localStorage.getItem(RETENTION_KEY) ?? "", 10)
		return Number.isFinite(value) ? value : DEFAULT_RETENTION_DAYS
	} catch {
		return DEFAULT_RETENTION_DAYS
	}
}

export const usePlusHeldCartStore = defineStore("plusHeldCarts", () => {
	const posShift = usePOSShiftStore()
	const posSync = usePOSSyncStore()

	/** @type {import("vue").Ref<Array<Object>>} */
	const localRecords = ref([])
	/** @type {import("vue").Ref<Array<Object>>} */
	const serverRows = ref([])
	const serverLoaded = ref(false)
	const loading = ref(false)
	const uploading = ref(false)
	const lastError = ref(null)
	const retentionDays = ref(readRetention())
	let started = false

	const profile = computed(() => posShift.profileName || null)
	const entries = computed(() =>
		mergeHeldLists(
			localRecords.value.filter(
				(r) => !profile.value || r.pos_profile === profile.value,
			),
			serverRows.value,
		),
	)
	const count = computed(() => entries.value.length)
	const pendingCount = computed(
		() => pendingUploads(localRecords.value, profile.value).length,
	)

	async function loadLocal() {
		const all = await getAllDrafts()
		// POS Next drafts made before this phase have no hold id; give them one so they can be
		// uploaded like any other held cart.
		const records = []
		for (const record of all) {
			if (!record.hold_id) {
				const holdId = makeHoldId(generateUUID)
				const { id: _oldKey, ...rest } = record
				const upgraded = {
					...rest,
					draft_id: holdId,
					hold_id: holdId,
					held_at: record.created_at,
					server_state: "local",
				}
				try {
					// Save the new copy first, then drop the old one: never lose a cart.
					await saveDraft(upgraded)
					await deleteDraft(record.draft_id)
					records.push(upgraded)
				} catch (error) {
					log.warn("Could not upgrade an old draft", error)
				}
			} else {
				records.push(record)
			}
		}
		const kept = []
		for (const record of records) {
			if (isExpired(record, retentionDays.value)) {
				await deleteDraft(record.draft_id).catch(() => {})
			} else {
				kept.push(record)
			}
		}
		localRecords.value = kept
	}

	async function loadServer() {
		if (!profile.value || posSync.isOffline) return
		const result = await call(`${API}.list_held_carts`, {
			pos_profile: profile.value,
		})
		serverRows.value = result?.held || []
		serverLoaded.value = true
		if (Number.isFinite(Number(result?.retention_days))) {
			retentionDays.value = Number(result.retention_days)
			try {
				localStorage.setItem(RETENTION_KEY, String(retentionDays.value))
			} catch {
				// storage full or private mode
			}
		}
	}

	/** Reload both lists; uploads local carts first when online. */
	async function refresh() {
		loading.value = true
		lastError.value = null
		try {
			await loadLocal()
			if (!posSync.isOffline) {
				await uploadPending()
				await loadServer()
			} else {
				serverRows.value = []
				serverLoaded.value = false
			}
		} catch (error) {
			lastError.value = error?.message || String(error)
			log.warn("Held carts refresh failed", error)
		} finally {
			loading.value = false
		}
	}

	async function upload(record) {
		return call(`${API}.hold_cart`, {
			pos_profile: record.pos_profile,
			hold_id: record.hold_id,
			cart: JSON.stringify({
				items: record.items,
				customer: record.customer,
				applied_offers: record.applied_offers || [],
				sales_team: record.sales_team || [],
			}),
			invoice: JSON.stringify(record.invoice || {}),
			note: record.note || "",
			device_id: record.device_id || getDeviceId(),
			held_at: record.held_at,
		})
	}

	/** Apply an upload answer to the local copy. */
	async function settle(record, result) {
		const outcome = uploadOutcome(result)
		if (outcome.action === "remove") {
			await deleteDraft(record.draft_id).catch(() => {})
			localRecords.value = localRecords.value.filter(
				(r) => r.draft_id !== record.draft_id,
			)
			if (result?.held) {
				serverRows.value = [
					result.held,
					...serverRows.value.filter((r) => r.hold_id !== result.held.hold_id),
				]
			}
			return true
		}
		if (outcome.error) {
			const updated = await updateDraft(record.draft_id, {
				server_state: "error",
				error: outcome.error,
			}).catch(() => null)
			localRecords.value = localRecords.value.map((r) =>
				r.draft_id === record.draft_id
					? updated || { ...r, server_state: "error", error: outcome.error }
					: r,
			)
		}
		return false
	}

	/** Upload carts held while offline (and ones the server refused before). */
	async function uploadPending() {
		if (uploading.value || posSync.isOffline || !profile.value) return 0
		uploading.value = true
		let uploaded = 0
		try {
			for (const record of pendingUploads(localRecords.value, profile.value)) {
				try {
					if (await settle(record, await upload(record))) uploaded += 1
				} catch (error) {
					// Network or server error: keep the local copy for the next try.
					log.warn("Held cart upload failed", error)
					break
				}
			}
		} finally {
			uploading.value = false
		}
		return uploaded
	}

	/**
	 * Park the cart. Always stored locally first, so nothing is lost if the network drops.
	 * @param {Object} args
	 * @param {Array<Object>} args.items
	 * @param {any} args.customer
	 * @param {Array<Object>} [args.appliedOffers]
	 * @param {Array<Object>} [args.salesTeam]
	 * @param {Object} args.invoice   Draft payload (see core buildDraftInvoice)
	 * @param {string|null} [args.note]
	 * @returns {Promise<{stored: "server"|"local", error: string|null, holdId: string}>}
	 */
	async function hold({
		items,
		customer,
		appliedOffers,
		salesTeam,
		invoice,
		note,
	}) {
		const holdId = makeHoldId(generateUUID)
		const cart = snapshotCart({ items, customer, appliedOffers, salesTeam })
		const record = buildLocalRecord({
			holdId,
			posProfile: profile.value,
			cart,
			invoice: JSON.parse(JSON.stringify(invoice || {})),
			note,
			user: session.user || null,
			deviceId: getDeviceId(),
		})
		if (!record.invoice.customer) record.invoice.customer = customerId(customer)
		await saveDraft(record)
		localRecords.value = [record, ...localRecords.value]

		if (posSync.isOffline) return { stored: "local", error: null, holdId }
		try {
			const result = await upload(record)
			const removed = await settle(record, result)
			if (removed) return { stored: "server", error: null, holdId }
			return { stored: "local", error: result?.error || null, holdId }
		} catch (error) {
			log.warn("Hold upload failed; kept on this till", error)
			return { stored: "local", error: null, holdId }
		}
	}

	/**
	 * Take a held cart back into the till. A server cart is claimed (deleted on the server) in the
	 * same call, so no other till can resume it twice.
	 * @param {import("@/plus/core/heldCarts").HeldEntry} entry
	 */
	async function resume(entry) {
		if (entry.source === "server") {
			if (posSync.isOffline) {
				throw new Error(
					t("Connect to the network to resume a cart held on the server."),
				)
			}
			try {
				const result = await call(`${API}.resume_held_cart`, {
					pos_profile: profile.value,
					name: entry.name,
				})
				return restoreCart(result?.cart)
			} finally {
				serverRows.value = serverRows.value.filter((r) => r.name !== entry.name)
			}
		}
		const record =
			entry.record ||
			localRecords.value.find((r) => r.hold_id === entry.hold_id)
		if (!record) throw new Error(t("This held cart is no longer on this till."))
		await deleteDraft(record.draft_id)
		localRecords.value = localRecords.value.filter(
			(r) => r.draft_id !== record.draft_id,
		)
		return restoreCart(record)
	}

	/** @param {import("@/plus/core/heldCarts").HeldEntry|string} entryOrId */
	async function remove(entryOrId) {
		const entry =
			typeof entryOrId === "string"
				? entries.value.find((e) => e.hold_id === entryOrId)
				: entryOrId
		if (!entry) return false
		if (entry.source === "server") {
			if (posSync.isOffline) {
				throw new Error(
					t("Connect to the network to delete a cart held on the server."),
				)
			}
			await call(`${API}.delete_held_cart`, {
				pos_profile: profile.value,
				name: entry.name,
			})
			serverRows.value = serverRows.value.filter((r) => r.name !== entry.name)
			return true
		}
		const record =
			entry.record ||
			localRecords.value.find((r) => r.hold_id === entry.hold_id)
		if (record) await deleteDraft(record.draft_id)
		localRecords.value = localRecords.value.filter(
			(r) => r.hold_id !== entry.hold_id,
		)
		return true
	}

	/** Watch the network: upload local carts on reconnect. Safe to call more than once. */
	function start() {
		if (started) return
		started = true
		watch(
			() => [profile.value, posSync.isOffline],
			([name, offline], previous) => {
				if (!name) return
				const reconnected = previous?.[1] && !offline
				if (reconnected || !previous) refresh()
			},
			{ immediate: true },
		)
	}

	return {
		entries,
		count,
		pendingCount,
		localRecords,
		serverRows,
		serverLoaded,
		loading,
		uploading,
		lastError,
		retentionDays,
		refresh,
		uploadPending,
		hold,
		resume,
		remove,
		start,
	}
})
