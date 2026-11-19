<!--
  Copyright (c) 2026, pos_0001 contributors
  License: AGPL-3.0. See license.txt

  Held carts list (SPEC F7): time, customer, total, cashier, till, note. Carts held on the server
  can be resumed on any till of the POS Profile; carts held offline show "On this till" until
  they are uploaded. Replaces POS Next's DraftInvoicesDialog (same props and events).
-->
<template>
	<Dialog v-model="show" :options="{ title: __('Held Carts'), size: 'xl' }">
		<template #body-content>
			<div class="flex flex-col gap-3" data-testid="held-carts-dialog">
				<div class="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
					<span v-if="isOffline" class="rounded bg-amber-50 px-2 py-1 text-amber-700">
						{{ __("Offline: only carts held on this till are shown.") }}
					</span>
					<span v-else>
						{{ __("Carts held on any till of this POS Profile.") }}
						<template v-if="store.retentionDays > 0">
							{{ __("Deleted after {0} days.", [store.retentionDays]) }}
						</template>
					</span>
					<button
						type="button"
						class="min-h-[44px] rounded-lg border border-gray-200 px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
						:disabled="store.loading"
						data-testid="held-carts-refresh"
						@click="store.refresh()"
					>
						{{ store.loading ? __("Loading...") : __("Refresh") }}
					</button>
				</div>

				<div v-if="store.lastError" class="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
					{{ __("Could not load held carts from the server: {0}", [store.lastError]) }}
				</div>

				<div v-if="store.entries.length === 0" class="py-8 text-center">
					<p class="text-sm font-medium text-gray-900">{{ __("No held carts") }}</p>
					<p class="mt-1 text-xs text-gray-500">
						{{ __("Press Hold (F8) to park a cart and serve the next customer.") }}
					</p>
				</div>

				<ul v-else class="flex max-h-[60vh] flex-col gap-2 overflow-y-auto" data-testid="held-carts-list">
					<li
						v-for="entry in store.entries"
						:key="entry.hold_id"
						class="flex items-stretch gap-2 rounded-lg border border-gray-200 bg-white hover:border-blue-400"
						data-testid="held-cart"
						:data-hold-id="entry.hold_id"
						:data-source="entry.source"
					>
						<button
							type="button"
							class="flex min-h-[44px] flex-1 flex-col gap-1 p-3 text-start disabled:cursor-not-allowed disabled:opacity-60"
							:disabled="busy || (entry.source === 'server' && isOffline)"
							data-testid="held-cart-resume"
							@click="resume(entry)"
						>
							<div class="flex w-full items-start justify-between gap-2">
								<span class="text-sm font-semibold text-gray-900">
									{{ entry.customer_name || __("Walk-in Customer") }}
								</span>
								<span class="text-sm font-bold text-blue-600" dir="ltr">
									{{ formatCurrency(entry.total) }}
								</span>
							</div>
							<div class="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
								<span dir="ltr">{{ formatDateTime(entry.held_at) }}</span>
								<span v-if="entry.held_by">{{ __("Cashier: {0}", [entry.held_by]) }}</span>
								<span v-if="entry.till">{{ __("Till: {0}", [entry.till]) }}</span>
								<span v-if="entry.item_count">{{ __("{0} item(s)", [entry.item_count]) }}</span>
								<span
									v-if="entry.source !== 'server'"
									class="rounded px-1.5 py-0.5"
									:class="entry.source === 'error' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'"
									data-testid="held-cart-local"
								>
									{{ entry.source === "error" ? __("Not uploaded") : __("On this till") }}
								</span>
							</div>
							<p v-if="entry.note" class="text-xs italic text-gray-700">{{ entry.note }}</p>
							<p v-if="entry.error" class="text-xs text-red-700">
								{{ __("Server refused it: {0}. It stays on this till; fix the cause and press Refresh.", [entry.error]) }}
							</p>
						</button>
						<button
							type="button"
							class="flex min-h-[44px] min-w-[44px] items-center justify-center border-s border-gray-100 px-3 text-gray-400 hover:text-red-600 disabled:opacity-40"
							:disabled="busy || (entry.source === 'server' && isOffline)"
							:title="__('Delete held cart')"
							:aria-label="__('Delete held cart')"
							data-testid="held-cart-delete"
							@click="askDelete(entry)"
						>
							<svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
								/>
							</svg>
						</button>
					</li>
				</ul>
			</div>
		</template>
		<template #actions>
			<div class="flex w-full justify-end">
				<Button variant="subtle" @click="show = false">{{ __("Close") }}</Button>
			</div>
		</template>
	</Dialog>

	<Dialog v-model="showDelete" :options="{ title: __('Delete held cart?'), size: 'xs' }">
		<template #body-content>
			<p class="py-3 text-sm text-gray-600">
				{{ __("The cart is removed on every till. This cannot be undone.") }}
			</p>
		</template>
		<template #actions>
			<div class="flex w-full gap-2">
				<Button class="flex-1" variant="subtle" @click="showDelete = false">{{ __("Cancel") }}</Button>
				<Button class="flex-1" variant="solid" theme="red" data-testid="held-cart-delete-confirm" @click="confirmDelete">
					{{ __("Delete") }}
				</Button>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
import { usePlusHeldCartStore } from "@/plus/heldCarts/heldCartStore"
import { useToast } from "@/composables/useToast"
import { usePOSSyncStore } from "@/stores/posSync"
import {
	DEFAULT_CURRENCY,
	formatCurrency as formatCurrencyUtil,
} from "@/utils/currency"
import { Button, Dialog } from "frappe-ui"
import { computed, ref, watch } from "vue"

const props = defineProps({
	modelValue: Boolean,
	currency: { type: String, default: DEFAULT_CURRENCY },
	allowPrintDraftInvoices: { type: Boolean, default: false },
})
const emit = defineEmits(["update:modelValue", "load-draft", "drafts-updated"])

const store = usePlusHeldCartStore()
const posSync = usePOSSyncStore()
const { showSuccess, showError } = useToast()

const show = ref(props.modelValue)
const busy = ref(false)
const showDelete = ref(false)
const toDelete = ref(null)
const isOffline = computed(() => posSync.isOffline)

watch(
	() => props.modelValue,
	(value) => {
		show.value = value
		if (value) store.refresh()
	},
)
watch(show, (value) => emit("update:modelValue", value))

function resume(entry) {
	if (busy.value) return
	// POSSale claims the cart through posDrafts.loadDraft(), which calls the held-cart store.
	emit("load-draft", entry)
}

function askDelete(entry) {
	toDelete.value = entry
	showDelete.value = true
}

async function confirmDelete() {
	if (!toDelete.value) return
	busy.value = true
	try {
		await store.remove(toDelete.value)
		showSuccess(__("Held cart deleted"))
		emit("drafts-updated")
	} catch (error) {
		showError(error?.message || __("Failed to delete held cart"))
		store.refresh()
	} finally {
		busy.value = false
		showDelete.value = false
		toDelete.value = null
	}
}

function formatDateTime(value) {
	if (!value) return ""
	const date = new Date(
		String(value).includes("T") ? value : String(value).replace(" ", "T"),
	)
	if (Number.isNaN(date.getTime())) return String(value)
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	})
}

function formatCurrency(amount) {
	return formatCurrencyUtil(Number.parseFloat(amount || 0), props.currency)
}
</script>
