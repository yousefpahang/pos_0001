<!--
  Copyright (c) 2026, pos_0001 contributors
  License: AGPL-3.0. See license.txt

  Hold (F8): park the cart with an optional note (SPEC F7). Enter holds, Esc closes.
-->
<template>
	<Dialog v-model="show" :options="{ title: __('Hold Cart'), size: 'sm' }">
		<template #body-content>
			<form class="flex flex-col gap-2" data-testid="hold-cart-dialog" @submit.prevent="confirm">
				<label for="pos0001-hold-note" class="text-sm text-gray-700">
					{{ __("Note (optional)") }}
				</label>
				<input
					id="pos0001-hold-note"
					ref="input"
					v-model="note"
					type="text"
					:maxlength="NOTE_MAX_LENGTH"
					class="min-h-[44px] w-full rounded-lg border border-gray-300 px-3 text-sm focus:border-blue-500 focus:outline-none"
					:placeholder="__('e.g. customer gone to fetch wallet')"
					data-testid="hold-cart-note"
				/>
				<p class="text-xs text-gray-500">
					{{
						isOffline
							? __("Offline: the cart is kept on this till and uploaded when the network is back.")
							: __("Any till of this POS Profile can resume it.")
					}}
				</p>
			</form>
		</template>
		<template #actions>
			<div class="flex w-full gap-2">
				<Button class="min-h-[44px] flex-1" variant="subtle" @click="show = false">{{ __("Cancel") }}</Button>
				<Button
					class="min-h-[44px] flex-1"
					variant="solid"
					:loading="busy"
					data-testid="hold-cart-confirm"
					@click="confirm"
				>
					{{ __("Hold") }}
				</Button>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
import { NOTE_MAX_LENGTH } from "@/plus/core/heldCarts"
import { usePOSSyncStore } from "@/stores/posSync"
import { Button, Dialog } from "frappe-ui"
import { computed, nextTick, ref, watch } from "vue"

const props = defineProps({
	modelValue: Boolean,
	busy: { type: Boolean, default: false },
})
const emit = defineEmits(["update:modelValue", "confirm"])

const posSync = usePOSSyncStore()
const show = ref(props.modelValue)
const note = ref("")
const input = ref(null)
const isOffline = computed(() => posSync.isOffline)

watch(
	() => props.modelValue,
	async (value) => {
		show.value = value
		if (value) {
			note.value = ""
			await nextTick()
			input.value?.focus()
		}
	},
)
watch(show, (value) => emit("update:modelValue", value))

function confirm() {
	if (props.busy) return
	emit("confirm", note.value)
}
</script>
