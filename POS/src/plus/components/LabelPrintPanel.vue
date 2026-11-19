<!--
  Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
  Barcode label printing (SPEC F4), rebuilt in Tailwind after POS Awesome's Barcode
  Printing screen: pick a template, add items (search or scan), set UOM, label quantity,
  price override or a scale label (weight / price from a POS Scale Barcode Rule), print.
  Used by LabelPrintDialog (till) and LabelsPage (desk page pos-labels).
-->
<template>
	<div class="flex flex-col gap-3 text-sm" data-testid="label-panel">
		<p v-if="!store.canPrint && !store.loading" class="p-3 rounded-lg bg-orange-50 border border-orange-200 text-orange-800" role="alert" data-testid="label-no-permission">
			{{ __("You are not allowed to print labels for this POS Profile. Ask a manager to give you the Print Labels role.") }}
		</p>

		<template v-else>
			<div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium text-gray-700">{{ __("Label template") }}</span>
					<select
						v-model="templateName"
						class="min-h-[44px] px-3 rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
						data-testid="label-template"
					>
						<option v-for="tpl in store.templates" :key="tpl.name" :value="tpl.name">
							{{ tpl.template_name || tpl.name }} · {{ tpl.language }}
						</option>
					</select>
				</label>
				<div class="flex flex-col gap-1">
					<span class="text-xs font-medium text-gray-700">{{ __("Output") }}</span>
					<div
						class="min-h-[44px] px-3 rounded-lg border flex items-center gap-2"
						:class="outputWarning ? 'bg-orange-50 border-orange-200 text-orange-800' : 'bg-gray-50 border-gray-200 text-gray-700'"
						data-testid="label-output"
					>
						<span class="truncate">{{ outputText }}</span>
					</div>
				</div>
			</div>

			<div class="relative">
				<label class="sr-only" for="pos0001-label-search">{{ __("Add item") }}</label>
				<input
					id="pos0001-label-search"
					v-model="query"
					type="search"
					autocomplete="off"
					:placeholder="__('Scan a barcode or type an item code or name')"
					class="w-full min-h-[44px] px-3 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
					data-testid="label-search"
					@input="onSearchInput"
					@keydown.enter.prevent="addFirstResult"
				/>
				<ul
					v-if="results.length"
					class="absolute z-20 mt-1 w-full max-h-64 overflow-auto rounded-lg border border-gray-200 bg-white shadow-lg"
					data-testid="label-results"
				>
					<li v-for="r in results" :key="`${r.item_code}-${r.uom}`">
						<button
							type="button"
							class="w-full min-h-[44px] px-3 py-2 text-start hover:bg-blue-50 flex items-center justify-between gap-2"
							@click="addResolved(r)"
						>
							<span class="truncate">
								<span class="font-medium">{{ r.item_name }}</span>
								<span class="text-gray-500 ms-1" dir="ltr">{{ r.item_code }} · {{ r.uom }}</span>
							</span>
							<span class="text-gray-700 whitespace-nowrap" dir="ltr">{{ r.price_label }}</span>
						</button>
					</li>
				</ul>
			</div>

			<p v-if="source" class="text-xs text-gray-600" data-testid="label-source">{{ source }}</p>

			<div v-if="!lines.length" class="p-6 text-center text-gray-500 border border-dashed border-gray-300 rounded-lg">
				{{ __("No items yet. Scan or search to add items.") }}
			</div>

			<ul v-else class="flex flex-col gap-2 max-h-[50vh] overflow-auto" data-testid="label-lines">
				<li
					v-for="line in lines"
					:key="line.key"
					class="p-2 rounded-lg border"
					:class="line.error ? 'border-red-300 bg-red-50' : 'border-gray-200'"
					data-testid="label-line"
				>
					<div class="flex flex-wrap items-center gap-2">
						<div class="flex-1 min-w-[10rem]">
							<p class="font-medium text-gray-900 truncate">{{ line.row?.item_name || line.input.item_code }}</p>
							<p v-if="line.row?.item_name_ar" class="text-xs text-gray-600 truncate" dir="rtl" lang="ar">{{ line.row.item_name_ar }}</p>
							<p class="text-xs text-gray-500" dir="ltr">
								{{ line.input.item_code }}<template v-if="line.row"> · {{ line.row.barcode }}</template>
							</p>
						</div>
						<select
							v-if="!line.input.scale_rule && (line.row?.uoms?.length || 0) > 1"
							v-model="line.input.uom"
							class="min-h-[44px] px-2 rounded-lg border border-gray-300 bg-white"
							:aria-label="__('UOM')"
							data-testid="label-uom"
							@change="refresh(line)"
						>
							<option v-for="u in line.row.uoms" :key="u" :value="u">{{ u }}</option>
						</select>
						<span v-else class="text-xs text-gray-600 px-1">{{ line.row?.uom }}</span>
						<label class="flex items-center gap-1">
							<span class="text-xs text-gray-600">{{ __("Labels") }}</span>
							<input
								v-model.number="line.input.qty"
								type="number"
								min="1"
								max="999"
								inputmode="numeric"
								class="w-20 min-h-[44px] px-2 rounded-lg border border-gray-300 text-end"
								dir="ltr"
								data-testid="label-qty"
								@change="refresh(line)"
							/>
						</label>
						<label class="flex items-center gap-1">
							<span class="text-xs text-gray-600">{{ __("Price") }}</span>
							<input
								v-model="line.input.price"
								type="number"
								min="0"
								step="0.01"
								inputmode="decimal"
								:placeholder="line.row?.price_text || ''"
								class="w-24 min-h-[44px] px-2 rounded-lg border border-gray-300 text-end"
								dir="ltr"
								data-testid="label-price"
								@change="refresh(line)"
							/>
						</label>
						<button
							type="button"
							class="min-h-[44px] min-w-[44px] rounded-lg text-red-700 hover:bg-red-50"
							:aria-label="__('Remove')"
							:title="__('Remove')"
							data-testid="label-remove"
							@click="remove(line)"
						>
							<svg class="w-5 h-5 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
							</svg>
						</button>
					</div>

					<div v-if="scaleRulesFor(line).length" class="mt-2 flex flex-wrap items-center gap-2">
						<label class="flex items-center gap-1">
							<span class="text-xs text-gray-600">{{ __("Scale label") }}</span>
							<select
								v-model="line.input.scale_rule"
								class="min-h-[44px] px-2 rounded-lg border border-gray-300 bg-white"
								data-testid="label-scale-rule"
								@change="refresh(line)"
							>
								<option value="">{{ __("None") }}</option>
								<option v-for="rule in scaleRulesFor(line)" :key="rule.name" :value="rule.name">
									{{ rule.name }} ({{ rule.value_type === "Price" ? __("Price") : __("Weight") }})
								</option>
							</select>
						</label>
						<label v-if="line.input.scale_rule" class="flex items-center gap-1">
							<span class="text-xs text-gray-600">{{ scaleValueLabel(line) }}</span>
							<input
								v-model.number="line.input.scale_value"
								type="number"
								min="0"
								step="0.001"
								inputmode="decimal"
								class="w-28 min-h-[44px] px-2 rounded-lg border border-gray-300 text-end"
								dir="ltr"
								data-testid="label-scale-value"
								@change="refresh(line)"
							/>
						</label>
						<span v-if="line.row?.weight_label" class="text-xs text-gray-700" dir="ltr">{{ line.row.weight_label }}</span>
					</div>

					<p v-if="line.row && !line.error" class="mt-1 text-xs text-gray-700" dir="ltr" data-testid="label-line-price">
						{{ line.row.price_label }}
					</p>
					<p v-if="line.error" class="mt-1 text-xs text-red-700" role="alert">{{ line.error }}</p>
				</li>
			</ul>

			<p v-if="message" class="text-xs" :class="messageError ? 'text-red-700' : 'text-green-700'" role="status" data-testid="label-message">
				{{ message }}
			</p>

			<div class="flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-3">
				<span class="text-xs text-gray-600" data-testid="label-total">{{ __("{0} labels", [totalLabels]) }}</span>
				<div class="flex flex-wrap gap-2">
					<Button v-if="lines.length" class="min-h-[44px]" @click="clear">{{ __("Clear") }}</Button>
					<Button
						v-if="isPdf && online"
						class="min-h-[44px]"
						:loading="store.busy"
						:disabled="!printable.length"
						data-testid="label-pdf"
						@click="downloadPdf"
					>
						{{ __("Download PDF") }}
					</Button>
					<Button
						variant="solid"
						class="min-h-[44px]"
						:loading="store.busy"
						:disabled="!printable.length || !templateName"
						data-testid="label-print"
						@click="print"
					>
						{{ isPdf ? __("Print A4 sheet") : __("Print labels") }}
					</Button>
				</div>
			</div>
		</template>
	</div>
</template>

<script setup>
import { RAW_LANGUAGES } from "@/plus/core/labels"
import { usePlusLabelStore } from "@/plus/labels/labelStore"
import { ensureQz, qzConnected } from "@/plus/printing/qz"
import { usePOSSyncStore } from "@/stores/posSync"
import { Button } from "frappe-ui"
import { computed, onMounted, ref, watch } from "vue"

const props = defineProps({
	/** Rows to start with: [{item_code, uom, qty}] */
	initialRows: { type: Array, default: () => [] },
	/** Already resolved rows (from a document) */
	resolvedRows: { type: Array, default: () => [] },
	source: { type: String, default: "" },
})
const emit = defineEmits(["printed"])

const store = usePlusLabelStore()
const posSync = usePOSSyncStore()
const templateName = ref("")
const query = ref("")
const results = ref([])
const lines = ref([])
const rules = ref([])
const message = ref("")
const messageError = ref(false)
let keySeq = 0
let searchTimer = null
let searchSeq = 0

const online = computed(() => !posSync.isOffline)
const current = computed(() => store.template(templateName.value))
const isPdf = computed(() => current.value?.language === "PDF")
const printable = computed(() =>
	lines.value.filter((l) => l.row && !l.error).map((l) => l.row),
)
const totalLabels = computed(() =>
	printable.value.reduce((n, r) => n + (Number(r.qty) || 1), 0),
)

const outputWarning = computed(() => {
	if (!current.value || isPdf.value) return false
	return !store.printer || !qzConnected.value
})
const outputText = computed(() => {
	if (!current.value) return __("Choose a label template.")
	if (isPdf.value)
		return __("A4 sheet, {0} x {1} labels", [
			current.value.a4_columns,
			current.value.a4_rows,
		])
	const p = store.printer
	if (!p) return __("No label printer is set for this till.")
	const name = `${p.printer_name}${p.label_language ? ` (${p.label_language})` : ""}`
	return qzConnected.value ? name : __("{0}: QZ Tray is not connected", [name])
})

function say(text, isError = false) {
	message.value = text
	messageError.value = isError
}

function pickTemplate() {
	const names = store.templates.map((t) => t.name)
	if (names.includes(templateName.value)) return
	templateName.value = store.cache?.default_template || names[0] || ""
}

watch(() => store.templates, pickTemplate, { immediate: true })

function newLine(input, row = null, error = "") {
	keySeq += 1
	return {
		key: `l${keySeq}`,
		input: {
			item_code: input.item_code,
			uom: row?.uom || input.uom || "",
			qty: Number(input.qty) || 1,
			price: input.price ?? "",
			scale_rule: input.scale_rule || "",
			scale_value: input.scale_value || null,
		},
		row,
		error,
	}
}

function inputFor(line) {
	const i = line.input
	return {
		item_code: i.item_code,
		uom: i.scale_rule ? undefined : i.uom || undefined,
		qty: Number(i.qty) || 1,
		price: i.price === "" || i.price === null ? null : i.price,
		scale_rule: i.scale_rule || undefined,
		scale_value: i.scale_rule ? Number(i.scale_value) || 0 : undefined,
	}
}

async function refresh(line) {
	if (line.input.scale_rule && !(Number(line.input.scale_value) > 0)) {
		line.error = __("Enter the weight or price for the scale label of {0}.", [
			line.input.item_code,
		])
		return
	}
	const [res] = await store.resolveRows([inputFor(line)])
	if (res?.error) {
		line.error = res.error
		return
	}
	line.error = ""
	line.row = res
	if (!line.input.scale_rule) line.input.uom = res.uom
}

async function addRows(inputs) {
	if (!inputs.length) return
	const resolved = await store.resolveRows(inputs)
	inputs.forEach((input, i) => {
		const res = resolved[i]
		lines.value.push(
			res?.error ? newLine(input, null, res.error) : newLine(input, res),
		)
	})
}

function addResolved(row) {
	lines.value.push(
		newLine({ item_code: row.item_code, uom: row.uom, qty: 1 }, row),
	)
	query.value = ""
	results.value = []
	say("")
}

function onSearchInput() {
	clearTimeout(searchTimer)
	const q = query.value
	searchTimer = setTimeout(async () => {
		const seq = ++searchSeq
		const found = q.trim().length >= 2 ? await store.searchItems(q) : []
		if (seq === searchSeq) results.value = found
	}, 250)
}

async function addFirstResult() {
	clearTimeout(searchTimer)
	const q = query.value.trim()
	if (!q) return
	const seq = ++searchSeq
	const found = await store.searchItems(q)
	if (seq !== searchSeq) return
	if (found.length) addResolved(found[0])
	else say(__("No item found for {0}.", [q]), true)
}

function remove(line) {
	lines.value = lines.value.filter((l) => l !== line)
}

function clear() {
	lines.value = []
	say("")
}

function scaleRulesFor(line) {
	const uoms = line.row?.uoms || []
	return rules.value.filter((r) => uoms.includes(r.uom || "Kg"))
}

function scaleValueLabel(line) {
	const rule = rules.value.find((r) => r.name === line.input.scale_rule)
	return rule?.value_type === "Price"
		? __("Amount")
		: __("Weight ({0})", [rule?.uom || "Kg"])
}

async function print() {
	try {
		const out = await store.print(templateName.value, printable.value)
		say(
			out.mode === "raw"
				? __("{0} labels sent to the label printer.", [out.labels])
				: __("A4 sheet with {0} labels opened for printing.", [out.labels]),
		)
		emit("printed", out)
	} catch (error) {
		say(String(error?.message || error), true)
	}
}

async function downloadPdf() {
	try {
		const out = await store.downloadPdf(templateName.value, printable.value)
		say(__("PDF with {0} labels is ready.", [out?.labels || totalLabels.value]))
	} catch (error) {
		say(String(error?.messages?.[0] || error?.message || error), true)
	}
}

watch(
	() => props.resolvedRows,
	(rows) => {
		if (rows?.length) {
			lines.value = rows.map((r) =>
				newLine({ item_code: r.item_code, uom: r.uom, qty: r.qty }, r),
			)
		}
	},
	{ immediate: true },
)

onMounted(async () => {
	rules.value = await store.scaleRules()
	if (props.initialRows.length && !props.resolvedRows.length)
		await addRows(props.initialRows)
	if (
		RAW_LANGUAGES.includes(current.value?.language) &&
		store.printer &&
		!qzConnected.value
	) {
		ensureQz().catch(() => {})
	}
})

defineExpose({ addRows, lines })
</script>
