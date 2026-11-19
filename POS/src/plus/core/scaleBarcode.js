// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Scale barcodes (SPEC F5): parse labels printed by shop scales, with the weight or the
// price embedded, and turn them into a cart line. Pure JavaScript, no imports besides
// ean.js, so it runs offline in the browser and in Vitest.
// Mirrored on the server by pos_next/pos_0001/scale_barcode.py (re-validation on sync).

import { gs1CheckDigit, hasValidCheckDigit, isDigits } from "./ean.js"

/**
 * @typedef {Object} ScaleRule  One POS Scale Barcode Rule, as sent by get_scale_rules.
 * @property {string} name
 * @property {string} prefix              1-3 digits
 * @property {number} total_length        full barcode length, check digit included
 * @property {number} item_code_start     1-based position of the item code (PLU)
 * @property {number} item_code_length
 * @property {"Item Barcode"|"Scale PLU"} item_match
 * @property {"Weight"|"Price"} value_type
 * @property {number} value_start         1-based
 * @property {number} value_length
 * @property {number} decimals
 * @property {string} [uom]               e.g. "Kg"; empty means no UOM check
 * @property {"Validate"|"Ignore"} check_digit_mode
 * @property {number} priority            lower runs first
 */

/**
 * @typedef {Object} ParsedScaleBarcode
 * @property {true} ok
 * @property {string} barcode
 * @property {ScaleRule} rule
 * @property {string} plu                 item code digits as printed
 * @property {"Weight"|"Price"} valueType
 * @property {number} value               weight (rule UOM) or price
 */

/**
 * @typedef {Object} ScaleParseError
 * @property {false} ok
 * @property {"check_digit"} error
 * @property {string} barcode
 * @property {ScaleRule} rule
 */

/** Lowest and highest barcode length a rule may use. */
export const MIN_LENGTH = 8
export const MAX_LENGTH = 20

/**
 * Round half away from zero to `decimals` places without binary float surprises
 * (0.8325 -> 0.833).
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
export function roundTo(value, decimals) {
	const sign = value < 0 ? -1 : 1
	const shifted = Math.round(Number(`${Math.abs(value)}e${decimals}`))
	return sign * Number(`${shifted}e-${decimals}`)
}

/**
 * True when `value` sits exactly half-way at `decimals` places (6.005 at 2). Half-up and
 * banker's rounding (ERPNext's default) disagree there, so such amounts are avoided.
 * @param {number} value
 * @param {number} decimals
 * @returns {boolean}
 */
export function isHalfTie(value, decimals) {
	const shifted = Math.abs(Number(`${value}e${decimals}`))
	return Math.abs(shifted - Math.floor(shifted) - 0.5) < 1e-6
}

/**
 * Coerce a rule from the server (numbers may arrive as strings) and check it.
 * @param {Object} raw
 * @returns {ScaleRule|null} null when the rule cannot be used
 */
export function normalizeRule(raw) {
	if (!raw) return null
	const rule = {
		...raw,
		prefix: String(raw.prefix ?? "").trim(),
		total_length: Number(raw.total_length),
		item_code_start: Number(raw.item_code_start),
		item_code_length: Number(raw.item_code_length),
		value_start: Number(raw.value_start),
		value_length: Number(raw.value_length),
		decimals: Number(raw.decimals ?? 0),
		priority: Number(raw.priority ?? 10),
		value_type: raw.value_type === "Price" ? "Price" : "Weight",
		item_match:
			raw.item_match === "Item Barcode" ? "Item Barcode" : "Scale PLU",
		check_digit_mode: raw.check_digit_mode === "Ignore" ? "Ignore" : "Validate",
		uom: raw.uom || "",
	}
	return ruleErrors(rule).length === 0 ? rule : null
}

/**
 * Problems with a rule's layout, as short codes. Empty array means the rule is usable.
 * The last digit is always the check digit, so segments must end before it.
 * @param {ScaleRule} rule
 * @returns {string[]}
 */
export function ruleErrors(rule) {
	const errors = []
	const n = rule.total_length
	if (!Number.isInteger(n) || n < MIN_LENGTH || n > MAX_LENGTH)
		errors.push("total_length")
	if (!/^[0-9]{1,3}$/.test(rule.prefix)) errors.push("prefix")
	const segments = [
		["prefix", 1, rule.prefix.length],
		["item_code", rule.item_code_start, rule.item_code_length],
		["value", rule.value_start, rule.value_length],
	]
	for (const [name, start, length] of segments) {
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(length) ||
			start < 1 ||
			length < 1
		) {
			errors.push(name)
		} else if (Number.isInteger(n) && start + length - 1 > n - 1) {
			errors.push(`${name}_past_check_digit`)
		}
	}
	const ranges = segments
		.filter(
			([, s, l]) =>
				Number.isInteger(s) && Number.isInteger(l) && s >= 1 && l >= 1,
		)
		.map(([name, s, l]) => [name, s, s + l - 1])
	for (let i = 0; i < ranges.length; i++) {
		for (let j = i + 1; j < ranges.length; j++) {
			if (ranges[i][1] <= ranges[j][2] && ranges[j][1] <= ranges[i][2]) {
				errors.push(`overlap_${ranges[i][0]}_${ranges[j][0]}`)
			}
		}
	}
	if (
		!Number.isInteger(rule.decimals) ||
		rule.decimals < 0 ||
		rule.decimals > 6
	) {
		errors.push("decimals")
	}
	return errors
}

/**
 * Rules in the order they are tried: priority, then name.
 * @param {ScaleRule[]} rules
 * @returns {ScaleRule[]}
 */
export function sortRules(rules) {
	return [...rules].sort(
		(a, b) =>
			a.priority - b.priority || String(a.name).localeCompare(String(b.name)),
	)
}

/**
 * Parse a scanned barcode with the first rule whose prefix and length match.
 * @param {string} barcode
 * @param {Array<Object>} rules  raw or normalized rules
 * @returns {ParsedScaleBarcode|ScaleParseError|null} null when no rule matches
 */
export function parseScaleBarcode(barcode, rules) {
	const code = String(barcode ?? "").trim()
	if (!isDigits(code)) return null
	const usable = sortRules((rules || []).map(normalizeRule).filter(Boolean))
	for (const rule of usable) {
		if (code.length !== rule.total_length || !code.startsWith(rule.prefix))
			continue
		if (rule.check_digit_mode === "Validate" && !hasValidCheckDigit(code)) {
			return { ok: false, error: "check_digit", barcode: code, rule }
		}
		const plu = code.substr(rule.item_code_start - 1, rule.item_code_length)
		const digits = code.substr(rule.value_start - 1, rule.value_length)
		const value = Number(`${Number(digits)}e-${rule.decimals}`)
		return {
			ok: true,
			barcode: code,
			rule,
			plu,
			valueType: rule.value_type,
			value,
		}
	}
	return null
}

/**
 * Ways a PLU may be stored on the item: as printed, then without leading zeros.
 * @param {string} plu
 * @returns {string[]}
 */
export function pluCandidates(plu) {
	const stripped = String(plu).replace(/^0+(?=\d)/, "")
	return stripped === plu ? [plu] : [plu, stripped]
}

/**
 * Line for a price-embedded label: qty to 3 decimals, and a rate chosen so that
 * round(qty x rate) is exactly the printed price (rounding goes into the rate, never
 * into the amount; SPEC F5 rule 4).
 * @param {number} price        printed price
 * @param {number} unitRate     price list rate per rule UOM
 * @param {{qtyDecimals?: number, rateDecimals?: number, amountDecimals?: number}} [opts]
 * @returns {{qty: number, rate: number, amount: number, exact: boolean}|null}
 *   null when the unit rate is not positive
 */
export function priceLine(price, unitRate, opts = {}) {
	const qd = opts.qtyDecimals ?? 3
	const rd = opts.rateDecimals ?? 2
	const ad = opts.amountDecimals ?? 2
	if (!(unitRate > 0) || !(price > 0)) return null
	const target = roundTo(price, ad)
	const step = Number(`1e-${qd}`)
	const rateStep = Number(`1e-${rd}`)
	const half = Number(`5e-${ad + 1}`)
	const ru = roundTo(unitRate, rd)
	const q0 = Math.max(roundTo(target / unitRate, qd), step)
	// For each qty near price / rate, the rates that give exactly the printed amount form
	// an interval; take the one closest to the list rate. Best pair: smallest rate change,
	// then the qty closest to price / rate.
	let best = null
	for (let k = 0; k <= 500; k++) {
		for (const sign of k === 0 ? [1] : [-1, 1]) {
			const qty = roundTo(q0 + sign * k * step, qd)
			if (qty <= 0) continue
			const lo = roundTo((target - half) / qty, rd)
			const hi = roundTo((target + half) / qty, rd)
			const candidates = [
				ru,
				lo - rateStep,
				lo,
				lo + rateStep,
				hi - rateStep,
				hi,
				hi + rateStep,
			]
			for (const raw of candidates) {
				const rate = roundTo(raw, rd)
				if (
					rate <= 0 ||
					isHalfTie(qty * rate, ad) ||
					roundTo(qty * rate, ad) !== target
				)
					continue
				const dev = Math.abs(rate - unitRate)
				if (!best || dev < best.dev - 1e-9) best = { qty, rate, dev }
			}
		}
		// A pair with the list rate itself can only sit within one qty step of q0, and a
		// pair one rate step away is already found by then; nothing further is better.
		if (best && k >= 1 && best.dev <= rateStep + 1e-9) break
	}
	if (best)
		return { qty: best.qty, rate: best.rate, amount: target, exact: true }
	const rate = roundTo(target / q0, rd)
	return { qty: q0, rate, amount: roundTo(q0 * rate, ad), exact: false }
}

/**
 * Build a scale barcode (for labels of goods weighed in store): prefix, PLU, value,
 * zero padding, and a valid check digit in the last position.
 * @param {Object} rawRule
 * @param {string} plu
 * @param {number} value  weight in the rule UOM, or price
 * @returns {string}
 */
export function generateScaleBarcode(rawRule, plu, value) {
	const rule = normalizeRule(rawRule)
	if (!rule) throw new Error("Invalid scale barcode rule")
	const pluDigits = String(plu ?? "")
	if (!isDigits(pluDigits) || pluDigits.length > rule.item_code_length) {
		throw new Error(
			`PLU ${plu} does not fit in ${rule.item_code_length} digits`,
		)
	}
	if (!(Number(value) >= 0)) throw new Error(`Invalid value ${value}`)
	const scaled = String(Math.round(Number(`${Number(value)}e${rule.decimals}`)))
	if (scaled.length > rule.value_length) {
		throw new Error(
			`Value ${value} does not fit in ${rule.value_length} digits`,
		)
	}
	const digits = Array(rule.total_length - 1).fill("0")
	const put = (start, text) => {
		for (let i = 0; i < text.length; i++) digits[start - 1 + i] = text[i]
	}
	put(1, rule.prefix)
	put(rule.item_code_start, pluDigits.padStart(rule.item_code_length, "0"))
	put(rule.value_start, scaled.padStart(rule.value_length, "0"))
	const body = digits.join("")
	return body + String(gs1CheckDigit(body))
}

/**
 * Pick the UOM, conversion factor and rate per rule UOM for an item.
 * @param {Object} item   cached item (stock_uom, uom, rate, uom_prices, item_uoms)
 * @param {string} uom    rule UOM; empty means "the item's own UOM"
 * @returns {{uom: string, conversion_factor: number, unitRate: number}|null}
 *   null when the item cannot be sold in that UOM
 */
export function itemUomRate(item, uom) {
	const stockUom = item.stock_uom || item.uom
	const target = uom || item.uom || stockUom
	let factor = null
	if (target === stockUom) factor = 1
	else {
		const row = (item.item_uoms || []).find((u) => u.uom === target)
		if (row) factor = Number(row.conversion_factor) || 1
	}
	if (factor === null) return null
	const prices = item.uom_prices || {}
	const baseRate = Number(item.price_list_rate ?? item.rate) || 0
	let unitRate
	if (prices[target] != null) unitRate = Number(prices[target])
	else if ((item.uom || stockUom) === target) unitRate = baseRate
	else if ((item.uom || stockUom) === stockUom) unitRate = baseRate * factor
	else unitRate = 0
	return { uom: target, conversion_factor: factor, unitRate }
}

/**
 * @typedef {Object} ScaleLineError
 * @property {"uom"|"no_price"} code
 * @property {string} item_code
 * @property {string} item_name
 * @property {string} uom
 */

/**
 * Turn a parsed label and its item into the cart item POS Next adds as a resolved
 * (read-only) line. The line keeps the barcode so the server re-validates it and so
 * the same label scanned twice gives two lines.
 * @param {Object} item               cached item
 * @param {ParsedScaleBarcode} parsed
 * @param {{lineId?: string, rateDecimals?: number}} [opts]
 * @returns {{item: Object}|{error: ScaleLineError}}
 */
export function buildScaleItem(item, parsed, opts = {}) {
	const rule = parsed.rule
	const info = itemUomRate(item, rule.uom)
	const base = {
		item_code: item.item_code,
		item_name: item.item_name || item.item_code,
		uom: rule.uom || item.uom || item.stock_uom,
	}
	if (!info) return { error: { code: "uom", ...base } }
	let qty
	let rate = roundTo(info.unitRate, opts.rateDecimals ?? 2)
	if (parsed.valueType === "Weight") {
		qty = roundTo(parsed.value, 3)
	} else {
		const line = priceLine(parsed.value, info.unitRate, {
			rateDecimals: opts.rateDecimals,
		})
		if (!line) return { error: { code: "no_price", ...base } }
		qty = line.qty
		rate = line.rate
	}
	if (!(qty > 0)) return { error: { code: "zero_qty", ...base } }
	return {
		item: {
			...item,
			uom: info.uom,
			conversion_factor: info.conversion_factor,
			rate,
			price_list_rate: rate,
			resolved_qty: qty,
			resolved_uom: info.uom,
			resolved_barcode_type:
				parsed.valueType === "Weight" ? "Weighted" : "Priced",
			pos0001_scale_barcode: parsed.barcode,
			pos0001_scale_rate: rate,
			pos0001_line_id: opts.lineId || `${parsed.barcode}-${Date.now()}`,
		},
	}
}
