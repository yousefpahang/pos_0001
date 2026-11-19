<!--
  Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
  Header sync badge (SPEC F12): Online / Offline / n pending / n failed. Opens SyncLogPanel.
-->
<template>
	<button
		type="button"
		class="flex items-center gap-1 px-2 min-h-[44px] rounded-full text-[11px] sm:text-xs font-semibold whitespace-nowrap touch-manipulation transition-colors"
		:class="toneClass"
		:title="label"
		:aria-label="label"
		data-testid="sync-badge"
		:data-tone="store.badge.tone"
		@click="open = true"
	>
		<span class="w-2 h-2 rounded-full flex-shrink-0" :class="dotClass"></span>
		<span class="hidden 2xl:inline">{{ label }}</span>
		<span class="2xl:hidden" dir="ltr">{{ shortLabel }}</span>
	</button>
	<SyncLogPanel v-model="open" />
</template>

<script setup>
import SyncLogPanel from "@/plus/components/SyncLogPanel.vue"
import { usePlusSyncLogStore } from "@/plus/sync/syncLog"
import { computed, onMounted, ref } from "vue"

const store = usePlusSyncLogStore()
const open = ref(false)

onMounted(() => store.start())

const label = computed(() => {
	const { tone, pending, failed } = store.badge
	if (tone === "failed") return __("{0} failed", [failed])
	if (tone === "pending") return __("{0} pending", [pending])
	if (tone === "offline")
		return pending > 0 ? __("Offline, {0} pending", [pending]) : __("Offline")
	return __("Online")
})

const shortLabel = computed(() => {
	const { tone, pending, failed } = store.badge
	if (tone === "failed") return `! ${failed}`
	if (pending > 0) return String(pending)
	return tone === "offline" ? "×" : "✓"
})

const toneClass = computed(() => {
	switch (store.badge.tone) {
		case "failed":
			return "bg-red-100 text-red-800 hover:bg-red-200"
		case "offline":
			return "bg-gray-200 text-gray-800 hover:bg-gray-300"
		case "pending":
			return "bg-orange-100 text-orange-800 hover:bg-orange-200"
		default:
			return "bg-green-100 text-green-800 hover:bg-green-200"
	}
})

const dotClass = computed(() => {
	switch (store.badge.tone) {
		case "failed":
			return "bg-red-600"
		case "offline":
			return "bg-gray-500"
		case "pending":
			return "bg-orange-500 animate-pulse"
		default:
			return "bg-green-600"
	}
})
</script>
