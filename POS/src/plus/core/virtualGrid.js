// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
/**
 * Virtual scrolling maths for the item grid and list (SPEC section 6; idea from POS Awesome's
 * RecycleScroller grid mode, rebuilt without a dependency). Only the rows in view plus a few
 * extra are rendered; padding above and below keeps the scrollbar honest. Pure, no DOM.
 *
 * @typedef {Object} RangeInput
 * @property {number} count          number of items
 * @property {number} columns        items per row (1 for a list)
 * @property {number} rowHeight      height of one row incl. the gap, px
 * @property {number} scrollTop      scroll offset of the container, px
 * @property {number} viewportHeight visible height of the container, px
 * @property {number} [overscan]     extra rows rendered above and below (default 3)
 * @property {number} [offsetTop]    space above the first row inside the scroller, px
 *
 * @typedef {Object} Range
 * @property {number} start      first item index rendered
 * @property {number} end        one past the last item index rendered
 * @property {number} padTop     px of empty space before the first rendered row
 * @property {number} padBottom  px of empty space after the last rendered row
 */

/**
 * @param {RangeInput} input
 * @returns {Range}
 */
export function visibleRange(input) {
	const count = Math.max(0, Math.floor(input.count || 0))
	const columns = Math.max(1, Math.floor(input.columns || 1))
	const rowHeight = Number(input.rowHeight) > 0 ? Number(input.rowHeight) : 0
	const overscan = Math.max(0, Math.floor(input.overscan ?? 3))
	if (!count) return { start: 0, end: 0, padTop: 0, padBottom: 0 }
	if (!rowHeight) return { start: 0, end: count, padTop: 0, padBottom: 0 }

	const totalRows = Math.ceil(count / columns)
	const top = Math.max(
		0,
		(Number(input.scrollTop) || 0) - (Number(input.offsetTop) || 0),
	)
	const viewport = Math.max(rowHeight, Number(input.viewportHeight) || 0)
	const firstRow = Math.min(
		totalRows - 1,
		Math.max(0, Math.floor(top / rowHeight) - overscan),
	)
	const lastRow = Math.min(
		totalRows,
		Math.ceil((top + viewport) / rowHeight) + overscan,
	)
	const start = firstRow * columns
	const end = Math.min(count, lastRow * columns)
	return {
		start,
		end,
		padTop: firstRow * rowHeight,
		padBottom: Math.max(0, (totalRows - lastRow) * rowHeight),
	}
}

/**
 * Column count from a computed `grid-template-columns` value ("120px 120px 120px" -> 3).
 * @param {string|null|undefined} template
 */
export function columnsFromTemplate(template) {
	if (!template || template === "none") return 1
	return Math.max(1, String(template).trim().split(/\s+/).length)
}

/**
 * Virtualise only big lists: small ones render as POS Next always did.
 * @param {number} count
 * @param {number} [threshold]
 */
export function shouldVirtualize(count, threshold = 60) {
	return count > threshold
}
