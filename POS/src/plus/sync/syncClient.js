// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Server calls for offline sync (pos_next.pos_0001.api.sync).

import { getOrCreateDeviceId } from "@/plus/core/deviceId"
import { call } from "@/utils/apiWrapper"
import { generateUUID } from "@/utils/offline/uuid"

const API = "pos_next.pos_0001.api.sync"

/** In-memory fallback when localStorage is not available (tests, workers). */
const memoryStorage = (() => {
	const data = {}
	return {
		getItem: (k) => data[k] ?? null,
		setItem: (k, v) => {
			data[k] = v
		},
	}
})()

/** @returns {string} stable id of this browser */
export function getDeviceId() {
	const storage =
		typeof localStorage !== "undefined" ? localStorage : memoryStorage
	return getOrCreateDeviceId(storage, generateUUID)
}

/**
 * Submit one queued invoice. Never throws for a server-side rejection: the answer
 * says Synced, Failed (stored) or Pending. Network errors still throw.
 * @param {Object} invoiceData
 * @returns {Promise<import("@/plus/core/syncOutcome").SubmitResponse>}
 */
export function submitQueuedInvoice(invoiceData) {
	return call(`${API}.submit_offline_invoice`, {
		invoice: JSON.stringify(invoiceData),
		device_id: getDeviceId(),
	})
}

/**
 * Submit several queued invoices in one request. One answer per invoice, in order.
 * An answer with status "Error" (not stored) means: send this invoice again on its own.
 * @param {Object[]} invoices
 * @returns {Promise<import("@/plus/core/syncOutcome").SubmitResponse[]>}
 */
export function submitQueuedInvoices(invoices) {
	return call(`${API}.submit_offline_invoices`, {
		invoices: JSON.stringify(invoices),
		device_id: getDeviceId(),
	})
}

/**
 * @param {number} [limit]
 * @returns {Promise<{rows: Array<Object>, failed_count: number}>}
 */
export function fetchSyncStatus(limit = 50) {
	return call(`${API}.get_sync_status`, { device_id: getDeviceId(), limit })
}

/**
 * @param {string[]} offlineIds
 * @returns {Promise<Array<{offline_id: string, status: string, invoice_name: string|null, error: string|null}>>}
 */
export function retryFailed(offlineIds) {
	return call(`${API}.retry_failed`, {
		offline_ids: JSON.stringify(offlineIds),
	})
}

/**
 * @param {string} posProfile
 * @param {string} [appVersion]
 */
export function registerDevice(posProfile, appVersion) {
	const id = getDeviceId()
	return call(`${API}.register_device`, {
		device_id: id,
		device_name: defaultDeviceName(id),
		pos_profile: posProfile,
		app_version: appVersion,
	})
}

/** @param {string} id */
function defaultDeviceName(id) {
	const platform =
		typeof navigator !== "undefined" ? navigator.platform || "" : ""
	return `${platform ? `${platform} ` : ""}${id.slice(0, 8)}`.trim()
}
