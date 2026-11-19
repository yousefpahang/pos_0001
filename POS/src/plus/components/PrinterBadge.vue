<!--
  Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
  Header printer badge (SPEC F9): red when the receipt printer needs QZ Tray and QZ is not
  connected (receipts then print through the browser). Opens a panel with Reprint last
  receipt (F9), Test print, Reconnect and No Sale (permission-controlled, logged).
-->
<template>
	<template v-if="store.status !== 'none'">
		<button
			type="button"
			class="flex items-center gap-1 px-2 min-h-[44px] min-w-[44px] justify-center rounded-full text-[11px] sm:text-xs font-semibold whitespace-nowrap touch-manipulation transition-colors"
			:class="store.status === 'down' ? 'bg-red-100 text-red-800 hover:bg-red-200' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'"
			:title="badgeLabel"
			:aria-label="badgeLabel"
			data-testid="printer-badge"
			:data-status="store.status"
			@click="open = true"
		>
			<svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					stroke-width="2"
					d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
				/>
			</svg>
			<span v-if="store.status === 'down'" class="w-2 h-2 rounded-full bg-red-600" aria-hidden="true"></span>
		</button>

		<Dialog v-model="open" :options="{ title: __('Receipt Printer'), size: 'md' }">
			<template #body-content>
				<div class="flex flex-col gap-3" data-testid="printer-panel">
					<div
						class="p-3 rounded-lg border text-sm"
						:class="store.status === 'down' ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'"
					>
						<p class="font-semibold text-gray-900">{{ store.printer?.printer_name }}</p>
						<p class="text-xs text-gray-600 mt-1">
							<span dir="ltr">{{ store.printer?.print_mode }} · {{ store.printer?.paper_width_mm }} mm</span>
						</p>
						<p class="text-xs mt-1" :class="store.status === 'down' ? 'text-red-700' : 'text-green-700'" role="status">
							{{ statusText }}
						</p>
					</div>

					<p v-if="message" class="text-xs" :class="messageError ? 'text-red-700' : 'text-gray-700'" role="alert" data-testid="printer-message">
						{{ message }}
					</p>

					<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
						<Button class="min-h-[44px]" :loading="store.busy" data-testid="printer-reprint" @click="run(store.reprintLast)">
							{{ __("Reprint last receipt") }} <span class="text-gray-500 ms-1" dir="ltr">(F9)</span>
						</Button>
						<Button class="min-h-[44px]" :loading="store.busy" data-testid="printer-test" @click="run(store.testPrint)">
							{{ __("Test print") }}
						</Button>
						<Button
							v-if="store.needsQz && store.status === 'down'"
							class="min-h-[44px] sm:col-span-2"
							data-testid="printer-reconnect"
							@click="reconnect"
						>
							{{ __("Connect QZ Tray") }}
						</Button>
					</div>

					<div v-if="store.canNoSale" class="border-t border-gray-200 pt-3 flex flex-col gap-2" data-testid="no-sale">
						<label class="text-xs font-medium text-gray-700" for="pos0001-no-sale-reason">
							{{ __("No Sale: reason (optional)") }}
						</label>
						<input
							id="pos0001-no-sale-reason"
							v-model="reason"
							type="text"
							maxlength="200"
							class="w-full min-h-[44px] px-3 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
							data-testid="no-sale-reason"
						/>
						<Button variant="solid" theme="red" class="min-h-[44px]" data-testid="no-sale-open" @click="openDrawer">
							{{ __("Open cash drawer (No Sale)") }}
						</Button>
						<p v-if="store.pendingEvents > 0" class="text-xs text-orange-700">
							{{ __("{0} drawer opening(s) waiting to upload", [store.pendingEvents]) }}
						</p>
					</div>
				</div>
			</template>
		</Dialog>
	</template>
</template>

<script setup>
import { usePlusPrintingStore } from "@/plus/printing/printingStore"
import { Button, Dialog } from "frappe-ui"
import { computed, ref } from "vue"

const store = usePlusPrintingStore()
const open = ref(false)
const reason = ref("")
const message = ref("")
const messageError = ref(false)

const badgeLabel = computed(() =>
	store.status === "down"
		? __(
				"Printer offline: QZ Tray is not connected. Receipts print through the browser.",
			)
		: __("Receipt printer ready"),
)

const statusText = computed(() =>
	store.status === "down"
		? __(
				"QZ Tray is not connected. Receipts print through the browser and the drawer cannot open. Start QZ Tray on this computer, then press Connect.",
			)
		: __("Ready. Receipts print automatically after payment."),
)

function say(text, isError = false) {
	message.value = text
	messageError.value = isError
}

async function run(action) {
	try {
		const result = await action()
		say(
			result?.fallback
				? __("Printed through the browser because QZ Tray is not available.")
				: __("Sent to the printer."),
		)
	} catch (error) {
		say(String(error?.message || error), true)
	}
}

async function reconnect() {
	const ok = await store.reconnect()
	say(
		ok
			? __("QZ Tray connected.")
			: __("Could not connect to QZ Tray. Is it running?"),
		!ok,
	)
}

async function openDrawer() {
	try {
		await store.noSale(reason.value)
		reason.value = ""
		say(__("Cash drawer opened. This was logged."))
	} catch (error) {
		say(String(error?.message || error), true)
	}
}
</script>
