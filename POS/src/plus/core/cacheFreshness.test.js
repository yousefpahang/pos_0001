import { describe, expect, it } from "vitest"
import {
	DEFAULT_REFRESH_MINUTES,
	REFRESH_MINUTES_KEY,
	isCacheFresh,
	readRefreshMinutes,
} from "./cacheFreshness"

const NOW = 1_800_000_000_000

describe("item cache freshness on reopen", () => {
	it("is fresh within the refresh minutes only", () => {
		expect(isCacheFresh(NOW - 60_000, 5, NOW)).toBe(true)
		expect(isCacheFresh(NOW - 5 * 60_000, 5, NOW)).toBe(false)
		expect(isCacheFresh(NOW - 10 * 60_000, 15, NOW)).toBe(true)
		expect(isCacheFresh(new Date(NOW - 1000).toISOString(), 5, NOW)).toBe(true)
	})

	it("never treats a missing, cleared or future sync time as fresh", () => {
		expect(isCacheFresh(null, 5, NOW)).toBe(false)
		expect(isCacheFresh(undefined, 5, NOW)).toBe(false)
		expect(isCacheFresh(0, 5, NOW)).toBe(false)
		expect(isCacheFresh(NOW + 60_000, 5, NOW)).toBe(false)
		expect(isCacheFresh(NOW - 1000, 0, NOW)).toBe(false)
	})

	it("reads the remembered setting with a safe default", () => {
		expect(
			readRefreshMinutes({
				getItem: (k) => (k === REFRESH_MINUTES_KEY ? "15" : null),
			}),
		).toBe(15)
		expect(readRefreshMinutes({ getItem: () => null })).toBe(
			DEFAULT_REFRESH_MINUTES,
		)
		expect(readRefreshMinutes({ getItem: () => "x" })).toBe(
			DEFAULT_REFRESH_MINUTES,
		)
		expect(
			readRefreshMinutes({
				getItem: () => {
					throw new Error("blocked")
				},
			}),
		).toBe(DEFAULT_REFRESH_MINUTES)
		expect(readRefreshMinutes(null)).toBe(DEFAULT_REFRESH_MINUTES)
	})
})
