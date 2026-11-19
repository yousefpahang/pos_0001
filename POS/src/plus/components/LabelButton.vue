<!--
  Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
  Header "Labels" button (SPEC F4): opens the label dialog, pre-filled with the items in
  the cart. Shown only when the cashier may print labels for this POS Profile.
-->
<template>
	<template v-if="store.canPrint">
		<button
			type="button"
			class="flex items-center gap-1 px-2 min-h-[44px] min-w-[44px] justify-center rounded-full text-[11px] sm:text-xs font-semibold whitespace-nowrap touch-manipulation bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors"
			:title="__('Print barcode labels')"
			:aria-label="__('Print barcode labels')"
			data-testid="label-button"
			@click="openDialog"
		>
			<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M7 7h.01M7 3h5a1.99 1.99 0 011.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
				/>
			</svg>
		</button>
		<Dialog v-model="open" :options="{ title: __('Print Labels'), size: '3xl' }">
			<template #body-content>
				<LabelPrintPanel v-if="open" :initial-rows="cartRows" />
			</template>
		</Dialog>
	</template>
</template>

<script setup>
import LabelPrintPanel from "@/plus/components/LabelPrintPanel.vue"
import { usePlusLabelStore } from "@/plus/labels/labelStore"
import { usePOSCartStore } from "@/stores/posCart"
import { usePOSShiftStore } from "@/stores/posShift"
import { Dialog } from "frappe-ui"
import { ref, watch } from "vue"

const store = usePlusLabelStore()
const cart = usePOSCartStore()
const shift = usePOSShiftStore()
const open = ref(false)
const cartRows = ref([])

watch(
	() => shift.profileName,
	(name) => {
		if (name) store.load(name)
	},
	{ immediate: true },
)

function openDialog() {
	// One row per cart line (scale lines are left out: print those as scale labels).
	cartRows.value = (cart.invoiceItems || [])
		.filter((line) => line.item_code && !line.pos0001_scale_barcode)
		.map((line) => {
			const qty = Number(line.quantity) || 1
			return {
				item_code: line.item_code,
				uom: line.uom,
				qty: Number.isInteger(qty) ? Math.min(Math.max(qty, 1), 999) : 1,
			}
		})
	open.value = true
}
</script>
