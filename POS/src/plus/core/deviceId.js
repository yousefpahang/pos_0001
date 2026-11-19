// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Stable per-browser device id for POS Device (SPEC section 8). Pure: storage and
// uuid source are injected so it works in tests.

export const DEVICE_ID_KEY = "pos0001_device_id"
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidDeviceId(value) {
	return typeof value === "string" && DEVICE_ID_PATTERN.test(value)
}

/**
 * Read the device id from storage, creating and saving one on first use.
 * @param {{getItem(k: string): string|null, setItem(k: string, v: string): void}} storage
 * @param {() => string} uuid  e.g. () => crypto.randomUUID()
 * @returns {string}
 */
export function getOrCreateDeviceId(storage, uuid) {
	let existing = null
	try {
		existing = storage.getItem(DEVICE_ID_KEY)
	} catch {
		existing = null
	}
	if (isValidDeviceId(existing)) return existing
	const id = uuid()
	if (!isValidDeviceId(id)) throw new Error("Generated device id is invalid")
	try {
		storage.setItem(DEVICE_ID_KEY, id)
	} catch {
		// Private mode or full storage: the id still works for this session.
	}
	return id
}
