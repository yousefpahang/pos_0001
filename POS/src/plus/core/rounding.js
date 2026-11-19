// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// ERPNext's rounded total, computed in the browser so a receipt printed before the server
// answers (offline, or DECISIONS item 13) shows the same total, rounding adjustment and
// change as the submitted Sales Invoice. Mirrors Frappe's
// round_based_on_smallest_currency_fraction() and rounded() (frappe/utils/data.py); the
// shared vectors in pos_0001/tests/rounding_vectors.json are checked on both sides.
// Display only: the invoice itself is rounded by ERPNext (rounding adjustment), never by
// changing line amounts.

/**
 * @typedef {Object} RoundingRule
 * @property {boolean} [disabled]   POS Profile "Disable Rounded Total"
 * @property {number} [fraction]    Currency smallest_currency_fraction_value (0 = whole units)
 * @property {string} [method]      System Settings rounding_method
 */

/** Python's float modulo (result has the sign of the divisor). */
function pyMod(a, b) {
	return ((a % b) + b) % b
}

/** IEEE unit in the last place of x (Python math.ulp). */
function ulp(x) {
	const v = Math.abs(x)
	if (v === 0) return Number.MIN_VALUE
	return 2 ** (Math.floor(Math.log2(v)) - 52)
}

/** Python round(x, n) for values that are not exact ties. */
function pyRound(x, n = 0) {
	const m = 10 ** n
	return Math.round(x * m) / m
}

/** Round half to even on exact .5 (Python round() of a float). */
function roundHalfEven(x) {
	const f = Math.floor(x)
	const d = x - f
	if (d === 0.5) return f % 2 === 0 ? f : f + 1
	return Math.round(x)
}

/**
 * frappe.utils.rounded(num, 0, method).
 * @param {number} num
 * @param {string} [method]
 */
export function roundedWhole(num, method = "Banker's Rounding (legacy)") {
	if (method === "Commercial Rounding") {
		if (num === 0) return 0
		return pyRound(num + Math.sign(num) * ulp(num), 0)
	}
	if (method === "Banker's Rounding") {
		if (num === 0) return 0
		const sign = num < 0 ? -1 : 1
		const v = pyRound(Math.abs(num), 12)
		if (v === 0) return 0
		const floor = Math.floor(v)
		const decimal = v - floor
		const epsilon = 2 ** (Math.log2(v) - 52)
		const out =
			epsilon < 0.5 && Math.abs(decimal - 0.5) < epsilon
				? floor % 2 === 0
					? floor
					: floor + 1
				: roundHalfEven(v)
		return sign * out
	}
	// Banker's Rounding (legacy), Frappe's default
	const v = pyRound(num, 8)
	const floor = Math.floor(v)
	if (v - floor === 0.5) return floor % 2 === 0 ? floor : floor + 1
	return roundHalfEven(v)
}

/** flt(value, 2) as used for totals (plain half-away rounding is enough at 2 decimals). */
function flt2(value) {
	const v = Math.sign(value) * Math.round(Math.abs(value) * 100 + 1e-7)
	return (v === 0 ? 0 : v) / 100
}

/**
 * Rounded total of an invoice as ERPNext computes it, or the grand total when rounding
 * is disabled.
 * @param {number} grandTotal
 * @param {RoundingRule} [rule]
 * @returns {{ roundedTotal: number, adjustment: number, applied: boolean }}
 */
export function roundedTotal(grandTotal, rule = {}) {
	const value = Number(grandTotal) || 0
	if (rule.disabled)
		return { roundedTotal: value, adjustment: 0, applied: false }
	const fraction = Number(rule.fraction) || 0
	let out = value
	if (fraction) {
		const rem = flt2(pyMod(value * 100, fraction * 100) / 100)
		if (rem > fraction / 2) out += fraction - rem
		else out -= rem
	} else {
		out = roundedWhole(value, rule.method || undefined)
	}
	const total = flt2(out)
	return {
		roundedTotal: total,
		adjustment: flt2(total - value),
		applied: true,
	}
}
