// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Cashier sync log (F12): merges the browser queue with Offline Invoice Sync rows,
// runs the "every 30 s while pending" sync timer, registers this browser as a POS Device.

import {
	AUTO_SYNC_INTERVAL_MS,
	badgeState,
	buildSyncLogRows,
	plainError,
	shouldAutoSync,
} from "@/plus/core/syncOutcome"
import {
	fetchSyncStatus,
	registerDevice,
	retryFailed,
} from "@/plus/sync/syncClient"
import { startScanCacheRefresh } from "@/plus/scan/scanCache"
import { usePlusPrintingStore } from "@/plus/printing/printingStore"
import { usePlusSalesPersonStore } from "@/plus/salesPerson/salesPersonStore"
import { usePOSShiftStore } from "@/stores/posShift"
import { usePOSSyncStore } from "@/stores/posSync"
import { logger } from "@/utils/logger"
import { db } from "@/utils/offline/db"
import { defineStore } from "pinia"
import { computed, ref, watch } from "vue"
import { version } from "../../../package.json"

const log = logger.create("SyncLog")
const LOCAL_ROW_LIMIT = 200

export const usePlusSyncLogStore = defineStore("plusSyncLog", () => {
	const posSync = usePOSSyncStore()
	const posShift = usePOSShiftStore()

	/** @type {import("vue").Ref<Array<Object>>} */
	const localRows = ref([])
	/** @type {import("vue").Ref<Array<Object>>} */
	const serverRows = ref([])
	const serverFailedCount = ref(0)
	const loading = ref(false)
	const retrying = ref(/** @type {Set<string>} */ (new Set()))
	const lastError = ref(/** @type {string|null} */ (null))
	const registeredProfile = ref(/** @type {string|null} */ (null))

	let timer = null

	const rows = computed(() =>
		buildSyncLogRows(localRows.value, serverRows.value),
	)
	const failedCount = computed(() => {
		const localFailed = rows.value.filter((r) => r.status === "Failed").length
		return Math.max(localFailed, serverFailedCount.value)
	})
	const badge = computed(() =>
		badgeState({
			isOffline: posSync.isOffline,
			pending: posSync.pendingInvoicesCount,
			failed: failedCount.value,
		}),
	)

	async function loadLocalRows() {
		try {
			const all = await db.invoice_queue
				.orderBy("timestamp")
				.reverse()
				.limit(LOCAL_ROW_LIMIT)
				.toArray()
			localRows.value = all
		} catch (error) {
			log.warn("Could not read the offline queue", error)
		}
	}

	async function loadServerRows() {
		if (posSync.isOffline) return
		try {
			const result = await fetchSyncStatus()
			serverRows.value = result?.rows || []
			serverFailedCount.value = Number(result?.failed_count) || 0
			lastError.value = null
		} catch (error) {
			lastError.value = plainError(error)
			log.warn("Could not load sync status", error)
		}
	}

	async function refresh() {
		loading.value = true
		try {
			await Promise.all([loadLocalRows(), loadServerRows()])
		} finally {
			loading.value = false
		}
	}

	/** Sync the browser queue now (button or timer). */
	async function syncNow() {
		if (posSync.isOffline || posSync.isSyncing) return null
		try {
			const result = await posSync.syncPending()
			return result
		} catch (error) {
			lastError.value = plainError(error)
			return null
		} finally {
			await refresh()
		}
	}

	/**
	 * Retry invoices stored as Failed on the server.
	 * @param {string[]} offlineIds
	 */
	async function retry(offlineIds) {
		if (posSync.isOffline || !offlineIds?.length) return []
		const next = new Set(retrying.value)
		for (const id of offlineIds) next.add(id)
		retrying.value = next
		try {
			const results = (await retryFailed(offlineIds)) || []
			for (const r of results) {
				if (r.status === "Synced") {
					const row = await db.invoice_queue
						.where("offline_id")
						.equals(r.offline_id)
						.first()
					if (row) {
						await db.invoice_queue.update(row.id, {
							server_status: "Synced",
							server_invoice: r.invoice_name,
							server_error: null,
						})
					}
				}
			}
			lastError.value = null
			return results
		} catch (error) {
			lastError.value = plainError(error)
			return []
		} finally {
			const done = new Set(retrying.value)
			for (const id of offlineIds) done.delete(id)
			retrying.value = done
			await refresh()
		}
	}

	async function tick() {
		if (
			shouldAutoSync({
				isOffline: posSync.isOffline,
				pending: posSync.pendingInvoicesCount,
				isSyncing: posSync.isSyncing,
			})
		) {
			await syncNow()
		}
	}

	async function ensureDeviceRegistered() {
		const profile = posShift.profileName
		if (!profile || posSync.isOffline || registeredProfile.value === profile)
			return
		try {
			await registerDevice(profile, version)
			registeredProfile.value = profile
		} catch (error) {
			log.warn("Device registration failed", error)
		}
	}

	/** Start the timer once; safe to call from several components. */
	function start() {
		if (timer) return
		timer = setInterval(tick, AUTO_SYNC_INTERVAL_MS)
		watch(
			() => [posShift.profileName, posSync.isOffline],
			() => {
				ensureDeviceRegistered()
				// Scale rules and barcode index for offline scanning (Phase 2)
				if (posShift.profileName && !posSync.isOffline) {
					startScanCacheRefresh(posShift.profileName)
				}
				// Sales person mode, list and default for offline picking (Phase 3)
				if (posShift.profileName) {
					usePlusSalesPersonStore().load(posShift.profileName)
					// Receipt printer, header, cash modes, No Sale permission (Phase 4)
					usePlusPrintingStore().load(posShift.profileName)
				}
			},
			{ immediate: true },
		)
		watch(
			() => [posSync.pendingInvoicesCount, posSync.isOffline],
			() => {
				refresh()
			},
		)
		refresh()
	}

	function stop() {
		if (timer) clearInterval(timer)
		timer = null
	}

	return {
		rows,
		badge,
		failedCount,
		loading,
		retrying,
		lastError,
		refresh,
		syncNow,
		retry,
		start,
		stop,
	}
})
