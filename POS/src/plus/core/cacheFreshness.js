// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
/**
 * Is the till's item cache fresh enough to show at once when the POS is reopened (SPEC section 6:
 * reopen in < 3 s)? POS Next refetches the first page and re-syncs the whole catalogue on every
 * page load; within `cache_refresh_minutes` (POS 0001 Settings, default 5) of the last item sync
 * the till now shows its cache first. Pure.
 */

export const DEFAULT_REFRESH_MINUTES = 5
export const REFRESH_MINUTES_KEY = "pos0001_cache_refresh_minutes"

/**
 * @param {number|string|null|undefined} lastSync  ms timestamp of the last item cache write
 * @param {number} [minutes]
 * @param {number} [now]
 */
export function isCacheFresh(
	lastSync,
	minutes = DEFAULT_REFRESH_MINUTES,
	now = Date.now(),
) {
	const at =
		typeof lastSync === "string" ? Date.parse(lastSync) : Number(lastSync)
	if (!Number.isFinite(at) || at <= 0) return false
	const age = now - at
	return age >= 0 && age < Math.max(0, Number(minutes) || 0) * 60_000
}

/**
 * @param {{getItem(k: string): string|null}|null|undefined} storage
 */
export function readRefreshMinutes(storage) {
	try {
		const value = Number.parseInt(
			storage?.getItem(REFRESH_MINUTES_KEY) ?? "",
			10,
		)
		return Number.isFinite(value) && value >= 0
			? value
			: DEFAULT_REFRESH_MINUTES
	} catch {
		return DEFAULT_REFRESH_MINUTES
	}
}
