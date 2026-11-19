<!--
  Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
  Cart header sales person picker (SPEC F6). Search by name or scan the employee's badge;
  several sales persons with a split in % when POS Settings allow Multiple. Works offline
  from the cached list. Shares state with POS Next's payment dialog through the store.
-->
<template>
	<div
		v-if="store.mode.enabled"
		ref="root"
		class="relative mt-2"
		data-testid="sales-person-picker"
		:data-mode="store.mode.mode"
		@keydown.esc.stop="close"
	>
		<button
			type="button"
			class="w-full flex items-center gap-2 min-h-[44px] px-2.5 rounded-xl border bg-white text-start touch-manipulation transition-colors"
			:class="
				missing
					? 'border-red-400 ring-1 ring-red-200'
					: 'border-gray-200 hover:border-blue-300'
			"
			:aria-expanded="open"
			:aria-label="__('Sales person')"
			data-testid="sales-person-toggle"
			@click="toggle"
		>
			<svg
				class="w-4 h-4 flex-shrink-0"
				:class="missing ? 'text-red-500' : 'text-gray-500'"
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
				stroke-width="2"
				aria-hidden="true"
			>
				<path
					stroke-linecap="round"
					stroke-linejoin="round"
					d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
				/>
			</svg>
			<span class="flex-1 min-w-0 truncate text-xs" data-testid="sales-person-summary">
				<template v-if="store.selection.length">
					<span class="font-semibold text-gray-900">{{ summary }}</span>
				</template>
				<span v-else :class="missing ? 'text-red-600 font-semibold' : 'text-gray-500'">
					{{
						store.mode.required
							? __("Sales person required")
							: __("Sales person (optional)")
					}}
				</span>
			</span>
			<span
				v-if="store.validity.reason === 'total'"
				class="text-[10px] font-semibold text-red-600 whitespace-nowrap"
				dir="ltr"
			>
				{{ total }}%
			</span>
			<svg
				class="w-4 h-4 text-gray-400 flex-shrink-0 transition-transform"
				:class="{ 'rotate-180': open }"
				fill="none"
				stroke="currentColor"
				viewBox="0 0 24 24"
				aria-hidden="true"
			>
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
			</svg>
		</button>

		<div
			v-if="open"
			class="absolute z-50 inset-x-0 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg p-2 max-h-[70vh] overflow-y-auto"
			data-testid="sales-person-panel"
			role="dialog"
			:aria-label="__('Choose sales person')"
		>
			<input
				ref="searchInput"
				v-model="query"
				type="text"
				inputmode="search"
				autocomplete="off"
				class="w-full h-11 px-3 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
				:placeholder="__('Search name or scan badge')"
				:aria-label="__('Search name or scan badge')"
				data-testid="sales-person-search"
				@keydown.enter.prevent="pickFromInput"
			/>
			<p
				v-if="message"
				class="mt-1 text-[11px] text-red-600"
				role="alert"
				data-testid="sales-person-message"
			>
				{{ message }}
			</p>

			<!-- Selected, with split in multiple mode -->
			<ul v-if="store.selection.length" class="mt-2 space-y-1" data-testid="sales-person-selected">
				<li
					v-for="member in store.selection"
					:key="member.sales_person"
					class="flex items-center gap-2 min-h-[44px] px-2 rounded-lg bg-blue-50"
				>
					<span class="flex-1 min-w-0 truncate text-xs font-semibold text-blue-900">
						{{ member.sales_person_name || member.sales_person }}
					</span>
					<label
						v-if="store.mode.multiple && store.selection.length > 1"
						class="flex items-center gap-1"
						dir="ltr"
					>
						<input
							type="number"
							min="0"
							max="100"
							step="0.01"
							inputmode="decimal"
							class="w-20 h-9 px-2 text-xs text-end border border-blue-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
							:value="member.allocated_percentage"
							:aria-label="__('Share of {0} in %', [member.sales_person_name || member.sales_person])"
							data-testid="sales-person-share"
							@change="store.updateShare(member.sales_person, $event.target.value)"
						/>
						<span class="text-xs text-blue-900">%</span>
					</label>
					<button
						type="button"
						class="w-11 h-11 -me-2 flex items-center justify-center rounded-lg text-blue-700 hover:bg-blue-100 touch-manipulation"
						:aria-label="__('Remove {0}', [member.sales_person_name || member.sales_person])"
						data-testid="sales-person-remove"
						@click="store.remove(member.sales_person)"
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</li>
			</ul>
			<div
				v-if="store.mode.multiple && store.selection.length > 1"
				class="mt-1 flex items-center justify-between gap-2 text-[11px]"
			>
				<span :class="store.validity.reason === 'total' ? 'text-red-600 font-semibold' : 'text-gray-500'">
					{{ __("Total") }} <span dir="ltr">{{ total }}%</span>
					<template v-if="store.validity.reason === 'total'"> · {{ __("must be 100%") }}</template>
				</span>
				<button
					type="button"
					class="min-h-[44px] px-3 rounded-lg font-semibold text-blue-700 hover:bg-blue-50 touch-manipulation"
					data-testid="sales-person-split"
					@click="store.splitEvenly()"
				>
					{{ __("Split evenly") }}
				</button>
			</div>

			<!-- Matches -->
			<ul class="mt-2 divide-y divide-gray-100" data-testid="sales-person-options">
				<li v-for="person in matches" :key="person.name">
					<button
						type="button"
						class="w-full flex items-center gap-2 min-h-[44px] px-2 text-start rounded-lg hover:bg-gray-50 touch-manipulation"
						data-testid="sales-person-option"
						@click="pick(person)"
					>
						<span class="flex-1 min-w-0 truncate text-sm text-gray-900">
							{{ person.sales_person_name || person.name }}
						</span>
						<span v-if="person.barcode" class="text-[10px] text-gray-400" dir="ltr">
							{{ person.barcode }}
						</span>
					</button>
				</li>
				<li v-if="!matches.length" class="px-2 py-3 text-xs text-gray-500">
					{{
						store.salesPersons.length
							? __("No sales person matches \"{0}\"", [query])
							: __("No sales persons available. Ask a manager to add them.")
					}}
				</li>
			</ul>
			<div class="mt-1 flex justify-end">
				<button
					type="button"
					class="min-h-[44px] px-4 rounded-lg text-xs font-semibold text-gray-700 hover:bg-gray-100 touch-manipulation"
					data-testid="sales-person-done"
					@click="close"
				>
					{{ __("Done") }}
				</button>
			</div>
		</div>
	</div>
</template>

<script setup>
import { allocationTotal, matchesSalesPerson } from "@/plus/core/salesPerson"
import { usePlusSalesPersonStore } from "@/plus/salesPerson/salesPersonStore"
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue"

const MAX_OPTIONS = 8

const store = usePlusSalesPersonStore()
const root = ref(null)
const searchInput = ref(null)
const open = ref(false)
const query = ref("")
const message = ref("")

const missing = computed(() => store.validity.reason === "required")
const total = computed(() => allocationTotal(store.selection))

const summary = computed(() =>
	store.selection
		.map((m) => {
			const name = m.sales_person_name || m.sales_person
			return store.mode.multiple && store.selection.length > 1
				? `${name} ${m.allocated_percentage}%`
				: name
		})
		.join(", "),
)

const matches = computed(() => {
	const chosen = new Set(store.selection.map((m) => m.sales_person))
	return store.salesPersons
		.filter((p) => !chosen.has(p.name) && matchesSalesPerson(p, query.value))
		.slice(0, MAX_OPTIONS)
})

function pick(person) {
	store.add(person)
	query.value = ""
	message.value = ""
	if (!store.mode.multiple) close()
	else nextTick(() => searchInput.value?.focus())
}

/** Enter in the search box: a scanned badge, or the only / first name match. */
function pickFromInput() {
	const code = query.value.trim()
	if (!code) return
	const badge = store.selectByBarcode(code)
	if (badge) {
		query.value = ""
		message.value = ""
		if (!store.mode.multiple) close()
		return
	}
	if (matches.value.length) {
		pick(matches.value[0])
		return
	}
	message.value = __('No sales person has badge or name "{0}".', [code])
}

function toggle() {
	if (open.value) close()
	else {
		open.value = true
		message.value = ""
		nextTick(() => searchInput.value?.focus())
	}
}

function close() {
	open.value = false
	query.value = ""
	message.value = ""
}

function onDocumentClick(event) {
	if (open.value && root.value && !root.value.contains(event.target)) close()
}

onMounted(() => document.addEventListener("pointerdown", onDocumentClick))
onBeforeUnmount(() =>
	document.removeEventListener("pointerdown", onDocumentClick),
)
</script>
