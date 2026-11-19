// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Vue side of plus/core/virtualGrid.js: watches a scroll container and returns the slice of
// items to render plus the padding that stands in for the rest. Columns and row height are
// measured from the rendered grid, so Tailwind breakpoints keep working.

import {
	columnsFromTemplate,
	shouldVirtualize,
	visibleRange,
} from "@/plus/core/virtualGrid"
import { computed, onBeforeUnmount, ref, unref, watch } from "vue"

/**
 * @param {import("vue").Ref<Array<Object>>|import("vue").ComputedRef<Array<Object>>} items
 * @param {Object} refs
 * @param {import("vue").Ref<HTMLElement|null>} refs.scroller  element that scrolls
 * @param {import("vue").Ref<HTMLElement|null>} refs.content   grid element or tbody holding the items
 * @param {Object} [options]
 * @param {"grid"|"list"} [options.mode]
 * @param {number} [options.threshold]   render everything up to this many items
 * @param {number} [options.overscan]
 */
export function useVirtualGrid(items, refs, options = {}) {
	const mode = options.mode || "grid"
	const threshold = options.threshold ?? 60
	const scrollTop = ref(0)
	const viewportHeight = ref(0)
	const columns = ref(1)
	const rowHeight = ref(0)
	const offsetTop = ref(0)
	let observer = null
	let frame = 0
	let attached = null

	const list = computed(() => unref(items) || [])
	const enabled = computed(() => shouldVirtualize(list.value.length, threshold))

	function measure() {
		const scroller = refs.scroller.value
		const content = refs.content.value
		if (!scroller || !content) return
		viewportHeight.value = scroller.clientHeight
		scrollTop.value = scroller.scrollTop
		const style = getComputedStyle(content)
		columns.value =
			mode === "grid" ? columnsFromTemplate(style.gridTemplateColumns) : 1
		const first = Array.from(content.children).find(
			(el) => el.dataset && el.dataset.vgridSpacer === undefined,
		)
		if (first) {
			const gap =
				mode === "grid"
					? Number.parseFloat(style.rowGap || style.gap || "0") || 0
					: 0
			const height = first.getBoundingClientRect().height
			if (height > 0) rowHeight.value = height + gap
		}
		const scrollerBox = scroller.getBoundingClientRect()
		const contentBox = content.getBoundingClientRect()
		offsetTop.value = contentBox.top - scrollerBox.top + scroller.scrollTop
	}

	function onScroll() {
		if (frame) return
		frame = requestAnimationFrame(() => {
			frame = 0
			const scroller = refs.scroller.value
			if (scroller) {
				scrollTop.value = scroller.scrollTop
				viewportHeight.value = scroller.clientHeight
			}
		})
	}

	function attach(scroller) {
		if (attached === scroller) return
		detach()
		if (!scroller) return
		attached = scroller
		scroller.addEventListener("scroll", onScroll, { passive: true })
		if (typeof ResizeObserver !== "undefined") {
			observer = new ResizeObserver(() => measure())
			observer.observe(scroller)
		}
		requestAnimationFrame(measure)
	}

	function detach() {
		if (attached) attached.removeEventListener("scroll", onScroll)
		attached = null
		observer?.disconnect()
		observer = null
	}

	watch(() => refs.scroller.value, attach, { immediate: true })
	// New results: start measuring again (row height can change with the view mode).
	watch(
		() => [list.value, refs.content.value],
		() => requestAnimationFrame(measure),
		{ flush: "post" },
	)
	onBeforeUnmount(() => {
		detach()
		if (frame) cancelAnimationFrame(frame)
	})

	const range = computed(() => {
		if (!enabled.value || !rowHeight.value) {
			// Until a row was measured, render a first screenful only.
			const end = enabled.value
				? Math.min(list.value.length, threshold)
				: list.value.length
			return { start: 0, end, padTop: 0, padBottom: 0 }
		}
		return visibleRange({
			count: list.value.length,
			columns: columns.value,
			rowHeight: rowHeight.value,
			scrollTop: scrollTop.value,
			viewportHeight: viewportHeight.value,
			offsetTop: offsetTop.value,
			overscan: options.overscan ?? 3,
		})
	})

	const visibleItems = computed(() =>
		list.value.slice(range.value.start, range.value.end),
	)
	const padTop = computed(() => range.value.padTop)
	const padBottom = computed(() => range.value.padBottom)

	return { visibleItems, padTop, padBottom, enabled, range, measure }
}
