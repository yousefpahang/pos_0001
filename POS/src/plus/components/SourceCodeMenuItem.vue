<!--
  Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
  "About / Source code" in the till's menu (SPEC section 2, license obligations). AGPL-3.0 asks that
  users of a hosted install can get the source of the version they use. The link and version come
  from pos_0001.api.about.get_about and are kept in localStorage, so the entry also works offline.
-->
<template>
	<a
		:href="about.source_url"
		target="_blank"
		rel="noopener noreferrer"
		class="w-full text-start px-4 py-2.5 text-sm text-gray-700 hover:bg-gray-50 flex items-center gap-3 transition-colors min-h-[44px]"
		data-testid="about-source-menu"
		:title="__('Source code (AGPL-3.0) of the version you use')"
	>
		<svg class="w-5 h-5 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
		</svg>
		<span class="flex-1 min-w-0 truncate">{{ __("About / Source code") }}</span>
		<span class="text-xs text-gray-400" dir="ltr">{{ about.version }}</span>
	</a>
</template>

<script setup>
import { call } from "@/utils/apiWrapper"
import { isOffline } from "@/utils/offline"
import { onMounted, ref } from "vue"
import { parseAbout } from "../core/about.js"

const KEY = "pos0001_about"

const about = ref(parseAbout(localStorage.getItem(KEY)))

onMounted(async () => {
	if (isOffline()) return
	try {
		const out = await call("pos_next.pos_0001.api.about.get_about")
		about.value = parseAbout(JSON.stringify(out || {}))
		localStorage.setItem(KEY, JSON.stringify(about.value))
	} catch {
		// Keep the cached or default link.
	}
})
</script>
