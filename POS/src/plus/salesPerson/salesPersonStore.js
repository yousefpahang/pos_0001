// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Sales person for the current cart (SPEC F6). Holds the effective mode, the list of
// sales persons (with badge barcodes) and the cashier's default, cached in IndexedDB so
// the picker works offline. The cart header picker and POS Next's payment dialog both
// read and write `selection` here.

import {
	addSalesPerson,
	defaultSelection,
	findByBarcode,
	removeSalesPerson,
	resolveMode,
	resplit,
	setShare,
	toSalesTeam,
	validateSelection,
} from "@/plus/core/salesPerson"
import { usePOSCartStore } from "@/stores/posCart"
import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"
import { isOffline } from "@/utils/offline"
import { db } from "@/utils/offline/db"
import { defineStore } from "pinia"
import { computed, ref, watch } from "vue"

const log = logger.create("SalesPerson")
const API = "pos_next.pos_0001.api.sales_person"
const KEY_PREFIX = "pos0001_sales_person_cache::"
const REFRESH_MS = 5 * 60_000

/**
 * @typedef {Object} SalesPersonCache
 * @property {string} mode
 * @property {boolean} multiple
 * @property {string|null} default_sales_person
 * @property {import("@/plus/core/salesPerson").SalesPerson[]} sales_persons
 */

export const usePlusSalesPersonStore = defineStore("plusSalesPerson", () => {
	const cartStore = usePOSCartStore()

	const profile = ref(null)
	/** @type {import("vue").Ref<SalesPersonCache|null>} */
	const cache = ref(null)
	/** @type {import("vue").Ref<import("@/plus/core/salesPerson").TeamMember[]>} */
	const selection = ref([])
	const loading = ref(false)
	let timer = null

	const mode = computed(() => {
		const c = cache.value
		if (!c) return resolveMode(null, null)
		// The server already resolved it; keep the shape of resolveMode().
		return {
			mode: c.mode,
			multiple: !!c.multiple,
			enabled: c.mode !== "Off",
			required: c.mode === "Mandatory",
		}
	})
	const loaded = computed(() => !!cache.value)
	const salesPersons = computed(() => cache.value?.sales_persons || [])
	const validity = computed(() =>
		validateSelection({
			mode: mode.value,
			selection: selection.value,
			available: salesPersons.value.length,
		}),
	)
	const salesTeam = computed(() => toSalesTeam(selection.value))

	async function readStored(name) {
		try {
			const row = await db.settings.get(KEY_PREFIX + name)
			return row?.value || null
		} catch (error) {
			log.warn("Could not read the sales person cache", error)
			return null
		}
	}

	async function fetchFromServer(name) {
		if (isOffline()) return null
		try {
			const data = await call(`${API}.get_sales_person_cache`, {
				pos_profile: name,
			})
			if (!data) return null
			const value = {
				mode: data.mode || "Off",
				multiple: !!data.multiple,
				default_sales_person: data.default_sales_person || null,
				sales_persons: data.sales_persons || [],
				loaded_at: Date.now(),
			}
			await db.settings.put({ key: KEY_PREFIX + name, value })
			return value
		} catch (error) {
			log.warn("Could not refresh the sales person cache", error)
			return null
		}
	}

	function apply(value) {
		const firstLoad = !cache.value
		cache.value = value
		// Drop people who are no longer in the list.
		const names = new Set(value.sales_persons.map((p) => p.name))
		if (selection.value.some((m) => !names.has(m.sales_person))) {
			selection.value = resplit(
				selection.value.filter((m) => names.has(m.sales_person)),
			)
		}
		if (
			firstLoad &&
			!selection.value.length &&
			!cartStore.invoiceItems?.length
		) {
			resetForNewCart()
		}
	}

	/**
	 * Load for a POS Profile: stored copy first (works offline), then the server.
	 * @param {string} name
	 */
	async function load(name) {
		if (!name) return
		if (profile.value !== name) {
			profile.value = name
			cache.value = null
			selection.value = []
		}
		loading.value = true
		try {
			const stored = await readStored(name)
			if (stored && profile.value === name) apply(stored)
			const fresh = await fetchFromServer(name)
			if (fresh && profile.value === name) apply(fresh)
		} finally {
			loading.value = false
		}
		if (!timer) {
			timer = setInterval(async () => {
				if (!profile.value) return
				const fresh = await fetchFromServer(profile.value)
				if (fresh) apply(fresh)
			}, REFRESH_MS)
		}
	}

	/** New cart: the cashier's default sales person, or nobody. */
	function resetForNewCart() {
		selection.value = mode.value.enabled ? defaultSelection(cache.value) : []
	}

	function add(person) {
		selection.value = addSalesPerson(
			selection.value,
			person,
			mode.value.multiple,
		)
	}

	function remove(name) {
		selection.value = removeSalesPerson(selection.value, name)
	}

	function clear() {
		selection.value = []
	}

	function updateShare(name, percent) {
		selection.value = setShare(selection.value, name, percent)
	}

	function splitEvenly() {
		selection.value = resplit(selection.value)
	}

	/** @param {import("@/plus/core/salesPerson").TeamMember[]} members */
	function setSelection(members) {
		selection.value = (members || []).map((m) => ({ ...m }))
	}

	/**
	 * Select the sales person whose badge was scanned.
	 * @param {string} code
	 * @returns {import("@/plus/core/salesPerson").SalesPerson|null}
	 */
	function selectByBarcode(code) {
		const person = findByBarcode(salesPersons.value, code)
		if (person) add(person)
		return person
	}

	// A finished or cleared sale starts the next cart with the default sales person.
	watch(
		() => cartStore.invoiceItems?.length || 0,
		(count, previous) => {
			if (previous > 0 && count === 0) resetForNewCart()
		},
	)

	return {
		profile,
		cache,
		loaded,
		loading,
		mode,
		salesPersons,
		selection,
		validity,
		salesTeam,
		load,
		resetForNewCart,
		add,
		remove,
		clear,
		updateShare,
		splitEvenly,
		setSelection,
		selectByBarcode,
	}
})
