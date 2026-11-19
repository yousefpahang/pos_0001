<!--
  Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
  Cashier sync log (SPEC F12): queued, synced and failed invoices with Retry.
-->
<template>
	<Dialog v-model="show" :options="{ title: __('Sync Log'), size: 'xl' }">
		<template #body-content>
			<div class="flex flex-col gap-3" data-testid="sync-log-panel">
				<div
					class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 rounded-lg border"
					:class="summaryClass"
				>
					<div class="min-w-0">
						<p class="font-semibold text-sm text-gray-900">{{ summaryTitle }}</p>
						<p class="text-xs text-gray-600">{{ summaryHint }}</p>
					</div>
					<div class="flex gap-2 flex-shrink-0">
						<Button
							v-if="failedRows.length > 1"
							:disabled="isOffline || store.retrying.size > 0"
							:loading="store.retrying.size > 0"
							class="min-h-[44px]"
							@click="retryAll"
						>
							{{ __("Retry all failed") }}
						</Button>
						<Button
							variant="solid"
							class="min-h-[44px]"
							:disabled="isOffline"
							:loading="isSyncing"
							data-testid="sync-now"
							@click="store.syncNow()"
						>
							{{ __("Sync now") }}
						</Button>
					</div>
				</div>

				<p v-if="store.lastError" class="text-xs text-red-700" role="alert">
					{{ store.lastError }}
				</p>

				<div v-if="store.loading && rows.length === 0" class="flex justify-center py-10">
					<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
				</div>

				<p v-else-if="rows.length === 0" class="text-center text-sm text-gray-500 py-10">
					{{ __("No invoices waiting or failed. Everything is synced.") }}
				</p>

				<ul v-else class="flex flex-col gap-2 max-h-[60vh] overflow-y-auto">
					<li
						v-for="row in rows"
						:key="row.offlineId"
						class="border border-gray-200 rounded-lg p-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3"
						:data-status="row.status"
						data-testid="sync-log-row"
					>
						<div class="flex-1 min-w-0">
							<div class="flex flex-wrap items-center gap-2">
								<span
									class="text-[11px] font-semibold px-2 py-0.5 rounded-full"
									:class="statusClass(row.status)"
								>
									{{ statusLabel(row.status) }}
								</span>
								<span class="font-semibold text-sm text-gray-900" dir="ltr">
									{{ formatMoney(row.total) }}
								</span>
								<span class="text-xs text-gray-500" dir="ltr">{{ formatTime(row.time) }}</span>
								<span v-if="row.customer" class="text-xs text-gray-600 truncate">
									{{ row.customer }}
								</span>
								<span v-if="row.invoiceName" class="text-xs text-gray-500" dir="ltr">
									{{ row.invoiceName }}
								</span>
							</div>
							<p v-if="row.error" class="mt-1 text-xs text-red-700 break-words">
								{{ row.error }}
							</p>
						</div>
						<Button
							v-if="row.canRetry"
							class="min-h-[44px] flex-shrink-0"
							:disabled="isOffline || store.retrying.has(row.offlineId)"
							:loading="store.retrying.has(row.offlineId)"
							data-testid="sync-retry"
							@click="store.retry([row.offlineId])"
						>
							{{ __("Retry") }}
						</Button>
					</li>
				</ul>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
import { usePlusSyncLogStore } from "@/plus/sync/syncLog"
import { usePOSShiftStore } from "@/stores/posShift"
import { usePOSSyncStore } from "@/stores/posSync"
import { formatCurrency } from "@/utils/currency"
import { Button, Dialog } from "frappe-ui"
import { computed, watch } from "vue"

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(["update:modelValue"])

const store = usePlusSyncLogStore()
const posSync = usePOSSyncStore()
const posShift = usePOSShiftStore()

const show = computed({
	get: () => props.modelValue,
	set: (v) => emit("update:modelValue", v),
})

const rows = computed(() => store.rows)
const failedRows = computed(() => rows.value.filter((r) => r.canRetry))
const isOffline = computed(() => posSync.isOffline)
const isSyncing = computed(() => posSync.isSyncing)

watch(show, (open) => {
	if (open) store.refresh()
})

const summaryTitle = computed(() => {
	const { tone, pending, failed } = store.badge
	if (tone === "failed") return __("{0} invoice(s) failed to sync", [failed])
	if (tone === "offline")
		return __("Offline: {0} invoice(s) waiting", [pending])
	if (tone === "pending") return __("{0} invoice(s) waiting to sync", [pending])
	return __("Online: all invoices synced")
})

const summaryHint = computed(() => {
	const { tone } = store.badge
	if (tone === "failed")
		return __(
			"The server kept these invoices. Fix the cause (for example stock or customer), then press Retry.",
		)
	if (tone === "offline")
		return __(
			"Keep selling. Invoices are sent automatically when the connection returns.",
		)
	if (tone === "pending")
		return __(
			"Invoices are sent every 30 seconds. Press Sync now to send them at once.",
		)
	return __("Sales made offline appear here until the server confirms them.")
})

const summaryClass = computed(() => {
	switch (store.badge.tone) {
		case "failed":
			return "bg-red-50 border-red-200"
		case "offline":
		case "pending":
			return "bg-orange-50 border-orange-200"
		default:
			return "bg-green-50 border-green-200"
	}
})

function statusLabel(status) {
	if (status === "Failed") return __("Failed")
	if (status === "Synced") return __("Synced")
	return __("Pending")
}

function statusClass(status) {
	if (status === "Failed") return "bg-red-100 text-red-700"
	if (status === "Synced") return "bg-green-100 text-green-700"
	return "bg-orange-100 text-orange-700"
}

function formatMoney(amount) {
	return formatCurrency(amount || 0, posShift.profileCurrency)
}

function formatTime(ms) {
	if (!ms) return ""
	return new Date(ms).toLocaleString([], {
		dateStyle: "short",
		timeStyle: "short",
	})
}

function retryAll() {
	store.retry(failedRows.value.map((r) => r.offlineId))
}
</script>
