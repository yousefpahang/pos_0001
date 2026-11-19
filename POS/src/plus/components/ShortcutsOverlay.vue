<!--
  Copyright (c) 2026, pos_0001 contributors
  License: AGPL-3.0. See license.txt

  "?" overlay: the till's keyboard shortcuts (SPEC section 6). Keys stay LTR in RTL layouts.
-->
<template>
	<Dialog v-model="show" :options="{ title: __('Keyboard Shortcuts'), size: 'md' }">
		<template #body-content>
			<ul class="flex flex-col divide-y divide-gray-100" data-testid="shortcuts-overlay">
				<li
					v-for="shortcut in SHORTCUTS"
					:key="shortcut.action"
					class="flex min-h-[44px] items-center justify-between gap-3 py-2"
					data-testid="shortcut-row"
				>
					<span class="text-sm text-gray-800">{{ __(shortcut.label) }}</span>
					<span class="flex shrink-0 items-center gap-1" dir="ltr">
						<template v-for="(key, index) in shortcut.keys" :key="key">
							<span v-if="index > 0" class="text-xs text-gray-400">+</span>
							<kbd class="min-w-[2rem] rounded border border-gray-300 bg-gray-50 px-2 py-1 text-center font-mono text-xs text-gray-700">
								{{ key }}
							</kbd>
						</template>
					</span>
				</li>
			</ul>
			<p class="mt-3 text-xs text-gray-500">
				{{ __("Scan a barcode at any time: no need to click the search box first.") }}
			</p>
		</template>
	</Dialog>
</template>

<script setup>
import { SHORTCUTS } from "@/plus/core/shortcuts"
import { Dialog } from "frappe-ui"
import { computed } from "vue"

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(["update:modelValue"])
const show = computed({
	get: () => props.modelValue,
	set: (value) => emit("update:modelValue", value),
})
</script>
