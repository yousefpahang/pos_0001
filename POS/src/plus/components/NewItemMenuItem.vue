<!--
  Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
  "New item" in the till's menu (SPEC F13): opens the Item Wizard in a new tab so the sale in
  progress stays as it is. Shown only to users with the role POS Item Wizard, and only online.
-->
<template>
	<button
		v-if="allowed && online"
		type="button"
		class="w-full text-start px-4 py-2.5 text-sm text-gray-700 hover:bg-green-50 flex items-center gap-3 transition-colors"
		data-testid="new-item-menu"
		@click="openWizard"
	>
		<svg class="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
		</svg>
		<span>{{ __("New item") }}</span>
	</button>
</template>

<script setup>
import { call } from "@/utils/apiWrapper"
import { isOffline } from "@/utils/offline"
import { onBeforeUnmount, onMounted, ref } from "vue"

const KEY = "pos0001_item_wizard_allowed"
const allowed = ref(localStorage.getItem(KEY) === "1")
const online = ref(!isOffline())

function refreshOnline() {
	online.value = !isOffline()
}

function openWizard() {
	window.open("/pos/items/new", "_blank", "noopener")
}

onMounted(async () => {
	window.addEventListener("online", refreshOnline)
	window.addEventListener("offline", refreshOnline)
	if (isOffline()) return
	try {
		const out = await call("pos_next.pos_0001.api.items.can_use_item_wizard")
		allowed.value = Boolean(out?.allowed)
		localStorage.setItem(KEY, allowed.value ? "1" : "0")
	} catch {
		// Keep the last answer.
	}
})

onBeforeUnmount(() => {
	window.removeEventListener("online", refreshOnline)
	window.removeEventListener("offline", refreshOnline)
})
</script>
