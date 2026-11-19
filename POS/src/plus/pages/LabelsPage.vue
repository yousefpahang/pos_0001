<!--
  Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
  Label printing page /pos/labels (SPEC F4). Shown inside the desk page pos-labels
  (?embedded=1) and opened by the Print Labels button of Purchase Receipt and Stock Entry
  (?doctype=...&name=...). No shift needed.
-->
<template>
	<div class="min-h-screen bg-gray-50" :class="embedded ? 'p-2' : 'p-4'" data-testid="labels-page">
		<div class="max-w-5xl mx-auto bg-white rounded-xl border border-gray-200 p-4 flex flex-col gap-3">
			<div class="flex flex-wrap items-end justify-between gap-2">
				<h1 v-if="!embedded" class="text-lg font-semibold text-gray-900">{{ __("Print Labels") }}</h1>
				<label class="flex flex-col gap-1">
					<span class="text-xs font-medium text-gray-700">{{ __("POS Profile") }}</span>
					<select
						v-model="profile"
						class="min-h-[44px] min-w-[14rem] px-3 rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
						data-testid="labels-profile"
					>
						<option v-for="p in profiles" :key="p.name" :value="p.name">{{ p.name }}</option>
					</select>
				</label>
			</div>

			<p v-if="error" class="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-800" role="alert" data-testid="labels-error">
				{{ error }}
			</p>
			<p v-else-if="!profiles.length && !loading" class="p-3 rounded-lg bg-orange-50 border border-orange-200 text-sm text-orange-800" role="alert">
				{{ __("You may not print labels for any POS Profile.") }}
			</p>

			<LabelPrintPanel
				v-if="profile && store.profile === profile && !store.loading"
				:key="`${profile}-${docKey}`"
				:resolved-rows="docRows"
				:source="source"
			/>
		</div>
	</div>
</template>

<script setup>
import LabelPrintPanel from "@/plus/components/LabelPrintPanel.vue"
import { usePlusLabelStore } from "@/plus/labels/labelStore"
import { call } from "@/utils/apiWrapper"
import { isOffline } from "@/utils/offline"
import { computed, onMounted, ref, watch } from "vue"
import { useRoute } from "vue-router"

const LAST_KEY = "pos0001_label_profile"
const route = useRoute()
const store = usePlusLabelStore()
const profiles = ref([])
const profile = ref("")
const docRows = ref([])
const source = ref("")
const error = ref("")
const loading = ref(true)

const embedded = computed(() => route.query.embedded === "1")
const docKey = computed(
	() => `${route.query.doctype || ""}-${route.query.name || ""}`,
)

async function loadDocument() {
	const { doctype, name } = route.query
	docRows.value = []
	source.value = ""
	if (!doctype || !name) return
	try {
		const out = await call("pos_next.pos_0001.api.labels.items_from_document", {
			doctype,
			name,
			pos_profile: profile.value || undefined,
		})
		if (out?.pos_profile && out.pos_profile !== profile.value) {
			profile.value = out.pos_profile
			await store.load(out.pos_profile)
		}
		docRows.value = out?.rows || []
		source.value = __("{0} {1}: {2} items with the received quantities.", [
			__(doctype),
			name,
			docRows.value.length,
		])
	} catch (e) {
		error.value = String(e?.messages?.[0] || e?.message || e)
	}
}

watch(profile, async (name) => {
	if (!name) return
	localStorage.setItem(LAST_KEY, name)
	await store.load(name)
})

onMounted(async () => {
	try {
		if (!isOffline()) {
			profiles.value =
				(await call("pos_next.pos_0001.api.labels.get_label_profiles")) || []
		}
	} catch (e) {
		error.value = String(e?.messages?.[0] || e?.message || e)
	}
	const last = localStorage.getItem(LAST_KEY)
	if (!profiles.value.length && last) profiles.value = [{ name: last }]
	profile.value =
		profiles.value.find((p) => p.name === last)?.name ||
		profiles.value[0]?.name ||
		""
	if (profile.value) await store.load(profile.value)
	loading.value = false
	await loadDocument()
})
</script>
