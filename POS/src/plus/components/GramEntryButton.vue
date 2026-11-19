<!--
  Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
  Gram entry on a Kg cart line (SPEC F13 "POS support"): the cashier types 250 and the line
  becomes 0.250 Kg at the price per Kg. Millilitres for Litre lines. Works offline.
-->
<template>
	<div v-if="entry" class="relative" @click.stop>
		<button
			type="button"
			class="h-6 sm:h-7 min-w-[32px] px-1.5 rounded border border-gray-300 bg-white text-[10px] sm:text-xs font-bold text-gray-700 hover:bg-gray-100 touch-manipulation"
			:title="__('Enter weight in {0}', [__(entry.uom)])"
			:aria-label="__('Enter weight in {0}', [__(entry.uom)])"
			:aria-expanded="open ? 'true' : 'false'"
			data-testid="gram-entry-button"
			@click="toggle"
		>
			{{ entry.symbol }}
		</button>
		<form
			v-if="open"
			class="absolute top-full end-0 mt-1 z-50 bg-white border border-blue-300 rounded-lg shadow-xl p-2 flex items-center gap-1"
			data-testid="gram-entry-panel"
			@submit.prevent="apply"
		>
			<input
				ref="input"
				v-model="value"
				type="text"
				inputmode="decimal"
				dir="ltr"
				class="w-20 h-9 px-2 rounded border border-gray-300 text-sm text-end focus:outline-none focus:ring-2 focus:ring-blue-500"
				:aria-label="__('Weight in {0}', [__(entry.uom)])"
				data-testid="gram-entry-input"
				@keydown.esc.stop="open = false"
			/>
			<span class="text-xs text-gray-600" dir="ltr">{{ entry.symbol }}</span>
			<button
				type="submit"
				class="h-9 min-w-[44px] px-2 rounded bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50"
				:disabled="qty === null"
				data-testid="gram-entry-apply"
			>
				{{ __("OK") }}
			</button>
			<span v-if="qty !== null" class="text-[10px] text-gray-500 whitespace-nowrap" dir="ltr">= {{ qty.toFixed(3) }} {{ __(stockUom) }}</span>
		</form>
	</div>
</template>

<script setup>
import {
	canEnterSmallUnit,
	entryToStockQty,
	entryUnitFor,
	stockQtyToEntry,
} from "@/plus/core/units"
import { computed, nextTick, ref } from "vue"

const props = defineProps({
	/** Cart line ({uom, stock_uom, quantity, ...}) */
	line: { type: Object, required: true },
})
const emit = defineEmits(["apply"])

const open = ref(false)
const value = ref("")
const input = ref(null)

const stockUom = computed(() => props.line.stock_uom || props.line.uom)
const entry = computed(() =>
	canEnterSmallUnit(props.line) ? entryUnitFor(stockUom.value) : null,
)
const qty = computed(() => entryToStockQty(value.value, stockUom.value))

async function toggle() {
	open.value = !open.value
	if (!open.value) return
	value.value = String(
		stockQtyToEntry(props.line.quantity, stockUom.value) ?? "",
	)
	await nextTick()
	input.value?.focus()
	input.value?.select()
}

function apply() {
	if (qty.value === null) return
	emit("apply", qty.value)
	open.value = false
}
</script>
