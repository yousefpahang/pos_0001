import { describe, expect, it } from "vitest"
import {
	DEVICE_ID_KEY,
	getOrCreateDeviceId,
	isValidDeviceId,
} from "./deviceId.js"

function memoryStorage(initial = {}) {
	const data = { ...initial }
	return {
		data,
		getItem: (k) => (k in data ? data[k] : null),
		setItem: (k, v) => {
			data[k] = v
		},
	}
}

describe("deviceId", () => {
	it("creates and stores an id on first use, then reuses it", () => {
		const storage = memoryStorage()
		let calls = 0
		const uuid = () => {
			calls++
			return "0b9d6c1e-1111-4222-8333-444455556666"
		}
		const first = getOrCreateDeviceId(storage, uuid)
		const second = getOrCreateDeviceId(storage, uuid)
		expect(first).toBe("0b9d6c1e-1111-4222-8333-444455556666")
		expect(second).toBe(first)
		expect(storage.data[DEVICE_ID_KEY]).toBe(first)
		expect(calls).toBe(1)
	})

	it("replaces an invalid stored value", () => {
		const storage = memoryStorage({ [DEVICE_ID_KEY]: "bad id!" })
		expect(getOrCreateDeviceId(storage, () => "abcdefgh-1234")).toBe(
			"abcdefgh-1234",
		)
	})

	it("still returns an id when storage throws", () => {
		const storage = {
			getItem() {
				throw new Error("denied")
			},
			setItem() {
				throw new Error("denied")
			},
		}
		expect(getOrCreateDeviceId(storage, () => "abcdefgh-1234")).toBe(
			"abcdefgh-1234",
		)
	})

	it("validates ids like the server does", () => {
		expect(isValidDeviceId("abcd1234")).toBe(true)
		expect(isValidDeviceId("short")).toBe(false)
		expect(isValidDeviceId("a".repeat(65))).toBe(false)
		expect(isValidDeviceId(null)).toBe(false)
	})
})
