// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"

const stored = new Map()
const putValues = []

vi.mock("@/utils/offline/db", () => ({
	db: {
		settings: {
			get: vi.fn(async (key) => stored.get(key)),
			// IndexedDB clones every value it stores; a Vue reactive proxy fails here.
			put: vi.fn(async (row) => {
				const copy = structuredClone(row)
				putValues.push(copy)
				stored.set(row.key, copy)
			}),
		},
		items: {
			bulkGet: vi.fn(async (codes) =>
				codes.map((code) => ({ item_code: code, disabled: 0 })),
			),
		},
	},
}))
vi.mock("@/utils/apiWrapper", () => ({
	call: vi.fn(async () => ({
		items: [{ item_code: "ITM-1", item_name: "Cola", qty: 5 }],
	})),
}))
vi.mock("@/stores/posShift", () => ({
	usePOSShiftStore: () => ({ profileName: "Main Till" }),
}))
vi.mock("@/stores/posSync", () => ({
	usePOSSyncStore: () => ({ isOffline: false }),
}))

const { usePlusFavouritesStore } = await import("./favouritesStore.js")

describe("favourites store", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
		stored.clear()
		putValues.length = 0
	})

	it("stores the fetched list in IndexedDB so the grid works offline", async () => {
		const store = usePlusFavouritesStore()
		await store.refresh("Main Till")
		expect(putValues).toHaveLength(1)
		expect(putValues[0].key).toBe("pos0001_favourites::Main Till")
		expect(putValues[0].value.items).toEqual([
			{ item_code: "ITM-1", item_name: "Cola", qty: 5 },
		])
		expect(store.items.map((i) => i.item_code)).toEqual(["ITM-1"])
	})

	it("loads the stored list again", async () => {
		await usePlusFavouritesStore().refresh("Main Till")
		setActivePinia(createPinia())
		const again = usePlusFavouritesStore()
		const { call } = await import("@/utils/apiWrapper")
		call.mockRejectedValueOnce(new Error("offline"))
		await again.refresh("Main Till")
		expect(again.rows.map((r) => r.item_code)).toEqual(["ITM-1"])
	})
})
