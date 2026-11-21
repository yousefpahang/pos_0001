// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Favourites quick grid (SPEC section 6): top 30 sellers of the POS Profile. The list of item
// codes comes from pos_0001.api.favourites and is kept in IndexedDB; the item details (price,
// stock, image) come from POS Next's item cache, so the grid works offline.

import { usePOSShiftStore } from "@/stores/posShift"
import { usePOSSyncStore } from "@/stores/posSync"
import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"
import { db } from "@/utils/offline/db"
import { defineStore } from "pinia"
import { computed, ref, watch } from "vue"

const API = "pos_next.pos_0001.api.favourites.get_favourites"
const REFRESH_MS = 30 * 60_000
const log = logger.create("PlusFavourites")

const cacheKey = (profile) => `pos0001_favourites::${profile}`

export const usePlusFavouritesStore = defineStore("plusFavourites", () => {
	const posShift = usePOSShiftStore()
	const posSync = usePOSSyncStore()
	/** @type {import("vue").Ref<Array<{item_code: string, item_name: string, qty: number}>>} */
	const rows = ref([])
	/** @type {import("vue").Ref<Array<Object>>} */
	const items = ref([])
	const fetchedAt = ref(null)
	let started = false
	let timer = null

	const profile = computed(() => posShift.profileName || null)

	async function resolveItems() {
		const codes = rows.value.map((r) => r.item_code)
		if (!codes.length) {
			items.value = []
			return
		}
		try {
			const found = await db.items.bulkGet(codes)
			items.value = found.filter((item) => item && !item.disabled)
		} catch (error) {
			log.warn("Favourite items not in the cache yet", error)
			items.value = []
		}
	}

	async function loadStored(name) {
		try {
			const stored = (await db.settings.get(cacheKey(name)))?.value
			rows.value = stored?.items || []
			fetchedAt.value = stored?.fetched_at || null
		} catch {
			rows.value = []
		}
	}

	async function refresh(name = profile.value) {
		if (!name) return
		await loadStored(name)
		if (!posSync.isOffline) {
			try {
				const result = await call(API, { pos_profile: name })
				// Store the plain API list, not rows.value: that is a reactive proxy, which
				// IndexedDB cannot clone (DataCloneError), so the list was never kept offline.
				const list = result?.items || []
				rows.value = list
				fetchedAt.value = new Date().toISOString()
				await db.settings.put({
					key: cacheKey(name),
					value: { items: list, fetched_at: fetchedAt.value },
				})
			} catch (error) {
				log.warn("Favourites refresh failed; using the stored list", error)
			}
		}
		await resolveItems()
	}

	function start() {
		if (started) return
		started = true
		watch(profile, (name) => name && refresh(name), { immediate: true })
		timer = setInterval(() => refresh(), REFRESH_MS)
	}

	function stop() {
		if (timer) clearInterval(timer)
		timer = null
	}

	return { rows, items, fetchedAt, refresh, resolveItems, start, stop }
})
