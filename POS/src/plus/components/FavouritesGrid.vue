<!--
  Copyright (c) 2026, pos_0001 contributors
  License: AGPL-3.0. See license.txt

  Favourites quick grid (SPEC section 6): the profile's top sellers as one-tap buttons above the
  item grid while the search box is empty. Collapsible; works offline from the item cache.
-->
<template>
	<section
		v-if="store.items.length"
		class="border-b border-gray-200 bg-white px-1.5 py-1.5 sm:px-3"
		data-testid="favourites-grid"
		:aria-label="__('Favourites')"
	>
		<div class="mb-1 flex items-center justify-between">
			<h3 class="text-xs font-semibold text-gray-700">
				{{ __("Favourites") }}
			</h3>
			<button
				type="button"
				class="min-h-[44px] min-w-[44px] px-2 text-xs text-blue-600 hover:underline"
				:aria-expanded="!collapsed"
				data-testid="favourites-toggle"
				@click="toggle"
			>
				{{ collapsed ? __("Show") : __("Hide") }}
			</button>
		</div>
		<div
			v-if="!collapsed"
			class="grid max-h-[30vh] grid-cols-3 gap-1.5 overflow-y-auto sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6"
		>
			<button
				v-for="item in store.items"
				:key="item.item_code"
				type="button"
				class="flex min-h-[44px] flex-col items-start justify-center rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-start hover:border-blue-400 hover:bg-blue-50 active:bg-blue-100"
				data-testid="favourite-item"
				:data-item-code="item.item_code"
				@click="$emit('select', item)"
			>
				<span class="w-full truncate text-[11px] font-semibold text-gray-900 sm:text-xs rtl:text-right" :title="item.item_name" dir="auto">{{ itemDisplayName(item, uiLang) }}</span>
				<span class="text-[10px] font-semibold text-blue-600" dir="ltr">
					{{ formatCurrency(item.rate || item.price_list_rate || 0) }}
				</span>
			</button>
		</div>
	</section>
</template>

<script setup>
import { itemDisplayName, pageLang } from "@/plus/core/itemName"
import { usePlusFavouritesStore } from "@/plus/favourites/favouritesStore"
import { useItemSearchStore } from "@/stores/itemSearch"
import {
	DEFAULT_CURRENCY,
	formatCurrency as formatCurrencyUtil,
} from "@/utils/currency"
import { onMounted, ref, watch } from "vue"

const props = defineProps({
	currency: { type: String, default: DEFAULT_CURRENCY },
})
defineEmits(["select"])

const COLLAPSE_KEY = "pos0001_favourites_collapsed"
const store = usePlusFavouritesStore()
const itemStore = useItemSearchStore()
const collapsed = ref(false)
const uiLang = pageLang()

onMounted(() => {
	try {
		collapsed.value = localStorage.getItem(COLLAPSE_KEY) === "1"
	} catch {
		collapsed.value = false
	}
	store.start()
})

// The item cache fills after the list on a new till: look the items up again then.
watch(
	() => itemStore.cacheReady,
	(ready) => ready && store.resolveItems(),
)

function toggle() {
	collapsed.value = !collapsed.value
	try {
		localStorage.setItem(COLLAPSE_KEY, collapsed.value ? "1" : "0")
	} catch {
		// private mode
	}
}

function formatCurrency(amount) {
	return formatCurrencyUtil(Number.parseFloat(amount || 0), props.currency)
}
</script>
