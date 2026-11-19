// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Sales person rules (SPEC F6), plain JavaScript with no UI imports so they run offline.
// Mirrors pos_next/pos_0001/sales_person.py.

/**
 * @typedef {"Off"|"Optional"|"Mandatory"} SalesPersonModeName
 *
 * @typedef {Object} SalesPersonMode
 * @property {SalesPersonModeName} mode  effective mode
 * @property {boolean} multiple          several sales persons per sale
 * @property {boolean} enabled
 * @property {boolean} required
 *
 * @typedef {Object} SalesPerson
 * @property {string} name
 * @property {string} [sales_person_name]
 * @property {number} [commission_rate]
 * @property {string|null} [barcode]
 *
 * @typedef {Object} TeamMember
 * @property {string} sales_person
 * @property {string} [sales_person_name]
 * @property {number} allocated_percentage
 * @property {number} [commission_rate]
 */

export const PERCENT_DECIMALS = 2
/** A split this close to 100 % is rounding drift, not a mistake. */
export const DRIFT_TOLERANCE = 0.05

/**
 * Effective mode from POS Profile `pos0001_sales_person_mode` and POS Next's
 * POS Settings `enable_sales_persons` (Disabled / Single / Multiple).
 * Off keeps POS Next's behaviour: enabled means mandatory.
 * @param {string|null|undefined} profileMode
 * @param {string|null|undefined} posNextMode
 * @returns {SalesPersonMode}
 */
export function resolveMode(profileMode, posNextMode) {
	const next = posNextMode || "Disabled"
	const multiple = next === "Multiple"
	/** @type {SalesPersonModeName} */
	let mode = "Off"
	if (profileMode === "Optional" || profileMode === "Mandatory")
		mode = profileMode
	else if (next === "Single" || next === "Multiple") mode = "Mandatory"
	return {
		mode,
		multiple: mode === "Off" ? false : multiple,
		enabled: mode !== "Off",
		required: mode === "Mandatory",
	}
}

/**
 * Half-up rounding on a scaled integer.
 * @param {number} value
 * @param {number} [decimals]
 */
export function roundPercent(value, decimals = PERCENT_DECIMALS) {
	const factor = 10 ** decimals
	const sign = value < 0 ? -1 : 1
	return (sign * Math.floor(Math.abs(value) * factor + 0.5 + 1e-9)) / factor
}

/**
 * Split 100 % into `count` shares that add up to exactly 100; first rows take the
 * leftover hundredths (3 -> 33.34, 33.33, 33.33).
 * @param {number} count
 * @param {number} [decimals]
 * @returns {number[]}
 */
export function splitEvenly(count, decimals = PERCENT_DECIMALS) {
	if (!count || count < 0) return []
	const units = 100 * 10 ** decimals
	const base = Math.floor(units / count)
	const extra = units - base * count
	return Array.from(
		{ length: count },
		(_, i) => (base + (i < extra ? 1 : 0)) / 10 ** decimals,
	)
}

/**
 * Round shares and move rounding drift (within DRIFT_TOLERANCE) onto the last row.
 * @param {number[]} percentages
 * @returns {number[]}
 */
export function normalizeAllocation(percentages, decimals = PERCENT_DECIMALS) {
	if (!percentages?.length) return []
	const rounded = percentages.map((p) => roundPercent(Number(p) || 0, decimals))
	const drift = roundPercent(100 - rounded.reduce((a, b) => a + b, 0), decimals)
	if (drift && Math.abs(drift) <= DRIFT_TOLERANCE) {
		rounded[rounded.length - 1] = roundPercent(
			rounded[rounded.length - 1] + drift,
			decimals,
		)
	}
	return rounded
}

/** @param {TeamMember[]} selection */
export function allocationTotal(selection) {
	return roundPercent(
		(selection || []).reduce(
			(sum, m) => sum + (Number(m.allocated_percentage) || 0),
			0,
		),
	)
}

/**
 * @param {SalesPerson} person
 * @returns {TeamMember}
 */
function toMember(person, share) {
	return {
		sales_person: person.name,
		sales_person_name: person.sales_person_name || person.name,
		allocated_percentage: share,
		commission_rate: person.commission_rate,
	}
}

/**
 * Add a sales person. Single mode replaces the selection; multiple mode adds and
 * splits evenly. Adding someone already selected changes nothing.
 * @param {TeamMember[]} selection
 * @param {SalesPerson} person
 * @param {boolean} multiple
 * @returns {TeamMember[]}
 */
export function addSalesPerson(selection, person, multiple) {
	if (!person?.name) return selection || []
	if (!multiple) return [toMember(person, 100)]
	if ((selection || []).some((m) => m.sales_person === person.name))
		return selection
	return resplit([...(selection || []), toMember(person, 0)])
}

/**
 * @param {TeamMember[]} selection
 * @param {string} name
 * @returns {TeamMember[]}
 */
export function removeSalesPerson(selection, name) {
	const rest = (selection || []).filter((m) => m.sales_person !== name)
	return resplit(rest)
}

/**
 * Even split over the current selection.
 * @param {TeamMember[]} selection
 * @returns {TeamMember[]}
 */
export function resplit(selection) {
	const shares = splitEvenly(selection.length)
	return selection.map((m, i) => ({ ...m, allocated_percentage: shares[i] }))
}

/**
 * Set one person's share. With two people the other one gets the rest, so the
 * common case never needs a second edit.
 * @param {TeamMember[]} selection
 * @param {string} name
 * @param {number} percent
 * @returns {TeamMember[]}
 */
export function setShare(selection, name, percent) {
	const value = Math.min(100, Math.max(0, roundPercent(Number(percent) || 0)))
	const next = selection.map((m) =>
		m.sales_person === name ? { ...m, allocated_percentage: value } : { ...m },
	)
	if (next.length === 2) {
		const other = next.find((m) => m.sales_person !== name)
		if (other) other.allocated_percentage = roundPercent(100 - value)
	}
	return next
}

/**
 * Does the person match what was typed or scanned? Barcode must match exactly;
 * names match on any part, case-insensitive.
 * @param {SalesPerson} person
 * @param {string} query
 */
export function matchesSalesPerson(person, query) {
	const q = (query || "").trim().toLowerCase()
	if (!q) return true
	if (person.barcode && person.barcode.toLowerCase() === q) return true
	return [person.sales_person_name, person.name].some((v) =>
		(v || "").toLowerCase().includes(q),
	)
}

/**
 * @param {SalesPerson[]} persons
 * @param {string} code
 * @returns {SalesPerson|null}
 */
export function findByBarcode(persons, code) {
	const c = (code || "").trim()
	if (!c) return null
	return (persons || []).find((p) => p.barcode && p.barcode === c) || null
}

/**
 * Selection for a new cart: the cashier's default sales person when there is one.
 * @param {{default_sales_person?: string|null, sales_persons?: SalesPerson[]}} cache
 * @returns {TeamMember[]}
 */
export function defaultSelection(cache) {
	const name = cache?.default_sales_person
	if (!name) return []
	const person = (cache.sales_persons || []).find((p) => p.name === name)
	return person ? [toMember(person, 100)] : []
}

/**
 * Can the sale go to payment / be completed?
 * Mandatory with an empty list cannot be met, so it does not block the till.
 * @param {{mode: SalesPersonMode, selection: TeamMember[], available: number}} input
 * @returns {{valid: boolean, reason: null|"required"|"total"}}
 */
export function validateSelection({ mode, selection, available }) {
	if (!mode?.enabled) return { valid: true, reason: null }
	const list = selection || []
	if (!list.length) {
		if (mode.required && available > 0)
			return { valid: false, reason: "required" }
		return { valid: true, reason: null }
	}
	if (Math.abs(allocationTotal(list) - 100) > DRIFT_TOLERANCE)
		return { valid: false, reason: "total" }
	return { valid: true, reason: null }
}

/**
 * Sales Team rows for the invoice (shares normalised to total exactly 100).
 * @param {TeamMember[]} selection
 * @returns {{sales_person: string, allocated_percentage: number}[]}
 */
export function toSalesTeam(selection) {
	const list = (selection || []).filter((m) => m.sales_person)
	const shares = normalizeAllocation(list.map((m) => m.allocated_percentage))
	return list.map((m, i) => ({
		sales_person: m.sales_person,
		sales_person_name: m.sales_person_name,
		allocated_percentage: shares[i],
	}))
}
