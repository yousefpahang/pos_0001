// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Keeps the search index in step with POS Next's item cache: loads it when the till opens and
// rebuilds it (in the worker) when the cache grows or a background sync finishes.

import { initSearchIndex, scheduleRebuild } from "@/plus/search/searchClient"
import { useItemSearchStore } from "@/stores/itemSearch"
import { watch } from "vue"

let started = false

/** @param {() => string|null} getProfile */
export function startSearchIndex(getProfile) {
	if (started) return
	started = true
	const items = useItemSearchStore()
	watch(
		getProfile,
		(profile) => {
			if (profile) initSearchIndex(profile)
		},
		{ immediate: true },
	)
	watch(
		() => [items.cacheReady, items.cacheSyncing, items.cacheStats?.items],
		([ready, syncing, count], previous) => {
			const profile = getProfile()
			if (!profile || syncing) return
			const [wasReady, wasSyncing, oldCount] = previous || []
			if (
				(ready && (!wasReady || wasSyncing)) ||
				(count && count !== oldCount)
			) {
				scheduleRebuild(profile)
			}
		},
	)
}
