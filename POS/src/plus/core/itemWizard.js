// Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
/**
 * Item Wizard logic (SPEC F13): unit conversions, prices per selling unit, cost, margin,
 * warnings and the checks that need no server. Browser copy of pos_0001/item_wizard.py; both
 * are checked against pos_0001/tests/item_wizard_vectors.json. Keep them in step.
 *
 * Core rule: the stock unit is the weighing unit (Kg or Litre) and prices are per Kg / Litre.
 * Gram and Millilitre are entry units only (no price, no conversion row): the cart turns
 * 250 g into 0.250 Kg at the per-Kg price.
 *
 * Plain JavaScript, no Vue imports.
 */
import { hasValidCheckDigit, isDigits } from "./ean.js"
import { roundTo } from "./scaleBarcode.js"

/**
 * @typedef {{uom: string, factor: number, symbol: string}} EntryUnit
 * @typedef {{uom: string, size: number|null, parent_uom: string}} BuyingUnit
 * @typedef {{uom: string, size: number|null, size_uom: string, priced: 0|1, price: number|null,
 *   barcode: string, margin: number|null, remove: 0|1}} SellingUnit
 * @typedef {{step: string, code: string, uom?: string, field?: string, barcode?: string,
 *   parent_uom?: string, shelf_price?: number}} WizardIssue
 */

/** @type {Readonly<Record<string, EntryUnit>>} */
export const ENTRY_UNITS = Object.freeze({
	Kg: { uom: "Gram", factor: 0.001, symbol: "g" },
	Litre: { uom: "Millilitre", factor: 0.001, symbol: "ml" },
})

/** Units an item may be sized in without listing them. */
const BASE_FACTORS = Object.freeze({
	Kg: { Gram: 0.001 },
	Litre: { Millilitre: 0.001 },
})

export const STEPS = Object.freeze([
	"start",
	"basics",
	"buying",
	"selling",
	"prices",
	"barcodes",
	"stock",
	"review",
])
export const MAX_UNITS = 8

/** @param {unknown} value @returns {number|null} */
function num(value) {
	if (value === null || value === undefined) return null
	if (typeof value === "string" && !value.trim()) return null
	if (typeof value === "boolean") return value ? 1 : 0
	const n = Number(value)
	return Number.isFinite(n) ? n : null
}

/** @param {unknown} value @returns {string} */
function text(value) {
	return value === null || value === undefined ? "" : String(value).trim()
}

/** Frappe's cint for flags. @param {unknown} value */
function flag(value) {
	if (typeof value === "boolean") return value ? 1 : 0
	const n = Math.trunc(Number(value ?? 0))
	return Number.isFinite(n) && n !== 0 ? 1 : 0
}

/**
 * Wizard payload with every key present and numbers as numbers.
 * @param {Object} raw
 */
export function normalize(raw) {
	const r = { ...(raw || {}) }
	const stockUom = text(r.stock_uom) || "Nos"
	/** @type {BuyingUnit[]} */
	const buying = []
	for (const row of r.buying_units || []) {
		const uom = text(row?.uom)
		if (!uom) continue
		buying.push({
			uom,
			size: num(row.size),
			parent_uom: text(row.parent_uom) || stockUom,
		})
	}
	/** @type {SellingUnit[]} */
	const selling = []
	for (const row of r.selling_units || []) {
		const uom = text(row?.uom)
		if (!uom) continue
		const size = num(row.size)
		selling.push({
			uom,
			size: size !== null ? size : 1,
			size_uom: text(row.size_uom) || (uom === stockUom ? uom : stockUom),
			priced:
				row.priced === null || row.priced === undefined || flag(row.priced)
					? 1
					: 0,
			price: num(row.price),
			barcode: text(row.barcode),
			margin: num(row.margin),
			remove: flag(row.remove) ? 1 : 0,
		})
	}
	const opening = { ...(r.opening_stock || {}) }
	return {
		pos_profile: text(r.pos_profile),
		preset: text(r.preset),
		item_code: text(r.item_code),
		item_name: text(r.item_name),
		item_name_ar: text(r.item_name_ar),
		item_group: text(r.item_group),
		brand: text(r.brand),
		image: text(r.image),
		stock_uom: stockUom,
		buying_units: buying,
		supplier: text(r.supplier),
		buying_price: num(r.buying_price),
		selling_units: selling,
		sold_on_scale: flag(r.sold_on_scale),
		scale_rule: text(r.scale_rule),
		scale_plu: text(r.scale_plu),
		price_mode: r.price_mode === "margin" ? "margin" : "price",
		base_price: num(r.base_price),
		margin_pct: num(r.margin_pct),
		prices_include_vat:
			r.prices_include_vat !== null &&
			r.prices_include_vat !== undefined &&
			!flag(r.prices_include_vat)
				? 0
				: 1,
		item_tax_template: text(r.item_tax_template),
		opening_stock: {
			qty: num(opening.qty),
			uom: text(opening.uom),
			warehouse: text(opening.warehouse),
			cost: num(opening.cost),
		},
	}
}

/**
 * Conversion of every unit to the stock unit, and the problems found. Buying units may be
 * listed in any order.
 * @param {ReturnType<typeof normalize>} p
 * @returns {{factors: Record<string, number>, errors: WizardIssue[]}}
 */
export function unitFactors(p) {
	const stock = p.stock_uom
	/** @type {Record<string, number>} */
	const factors = { [stock]: 1, ...(BASE_FACTORS[stock] || {}) }
	/** @type {WizardIssue[]} */
	const errors = []
	for (const u of p.buying_units) {
		if (u.uom === stock || u.uom in (BASE_FACTORS[stock] || {}))
			errors.push({ step: "buying", code: "buying_is_stock_unit", uom: u.uom })
		if (u.size === null || u.size <= 0)
			errors.push({ step: "buying", code: "size_not_positive", uom: u.uom })
	}
	let pending = p.buying_units.filter(
		(u) => u.size && u.size > 0 && !(u.uom in factors),
	)
	while (pending.length) {
		let progress = false
		for (const u of [...pending]) {
			if (u.parent_uom in factors) {
				factors[u.uom] = roundTo(u.size * factors[u.parent_uom], 9)
				pending = pending.filter((x) => x !== u)
				progress = true
			}
		}
		if (!progress) {
			for (const u of pending)
				errors.push({
					step: "buying",
					code: "unknown_unit",
					uom: u.uom,
					parent_uom: u.parent_uom,
				})
			break
		}
	}
	const seen = new Set()
	const entry = ENTRY_UNITS[stock]
	for (const u of p.selling_units) {
		const uom = u.uom
		if (seen.has(uom)) {
			errors.push({ step: "selling", code: "duplicate_unit", uom })
			continue
		}
		seen.add(uom)
		if (entry && uom === entry.uom) {
			errors.push({ step: "selling", code: "entry_unit_not_sold", uom })
			continue
		}
		if (u.size === null || u.size <= 0) {
			errors.push({ step: "selling", code: "size_not_positive", uom })
			continue
		}
		if (!(u.size_uom in factors)) {
			errors.push({
				step: "selling",
				code: "unknown_unit",
				uom,
				parent_uom: u.size_uom,
			})
			continue
		}
		if (u.size_uom === uom) {
			if (!(uom in factors) || Math.abs(u.size - 1) > 1e-9)
				errors.push({
					step: "selling",
					code: "unknown_unit",
					uom,
					parent_uom: uom,
				})
			continue
		}
		const factor = roundTo(u.size * factors[u.size_uom], 9)
		if (uom in factors && Math.abs(factors[uom] - factor) > 1e-9) {
			errors.push({ step: "selling", code: "conflicting_size", uom })
			continue
		}
		factors[uom] = factor
	}
	return { factors, errors }
}

/**
 * The biggest buying unit, else the stock unit.
 * @param {ReturnType<typeof normalize>} p
 * @param {Record<string, number>} [factors]
 */
export function purchaseUom(p, factors) {
	const f = factors || unitFactors(p).factors
	let best = p.stock_uom
	let bestFactor = 1
	for (const u of p.buying_units) {
		const x = f[u.uom]
		if (x && x > bestFactor) {
			best = u.uom
			bestFactor = x
		}
	}
	return best
}

/**
 * Prices per selling unit, cost, margin and warnings (SPEC F13 step 5). `price` is in the
 * basis the user typed; `list_rate` goes into the Item Price in the POS Profile's basis;
 * `shelf_price` is what a customer pays for one unit.
 * @param {ReturnType<typeof normalize>} p
 * @param {number} vatRate VAT % of the item's tax template
 * @param {0|1|boolean} profileInclusive the profile's sales taxes are included in the price
 */
export function unitPrices(p, vatRate, profileInclusive) {
	const { factors, errors } = unitFactors(p)
	const vat = (Number(vatRate) || 0) / 100
	const inclusive = profileInclusive ? 1 : 0
	const buyUom = purchaseUom(p, factors)
	let costPerStock = null
	if (p.buying_price !== null && p.buying_price >= 0 && factors[buyUom])
		costPerStock = p.buying_price / factors[buyUom]
	let base = p.base_price
	if (p.price_mode === "margin")
		base =
			costPerStock !== null && p.margin_pct !== null
				? roundTo(costPerStock * (1 + p.margin_pct / 100), 2)
				: null
	const units = []
	/** @type {WizardIssue[]} */
	const warnings = []
	const entry = ENTRY_UNITS[p.stock_uom] || null
	const done = new Set()
	for (const u of p.selling_units) {
		const factor = factors[u.uom]
		if (
			factor === undefined ||
			u.remove ||
			done.has(u.uom) ||
			(entry && u.uom === entry.uom)
		)
			continue
		done.add(u.uom)
		let calculated = null
		if (p.price_mode === "margin" && u.margin !== null && costPerStock !== null)
			calculated = roundTo(costPerStock * factor * (1 + u.margin / 100), 2)
		else if (base !== null) calculated = roundTo(base * factor, 2)
		const row = {
			uom: u.uom,
			factor,
			priced: u.priced,
			calculated,
			price: null,
			overridden: 0,
			cost: costPerStock !== null ? roundTo(costPerStock * factor, 2) : null,
			margin_pct: null,
			list_rate: null,
			shelf_price: null,
		}
		if (u.priced) {
			if (u.price !== null) {
				row.price = roundTo(u.price, 2)
				row.overridden =
					row.calculated === null || row.price !== row.calculated ? 1 : 0
			} else row.price = row.calculated
		}
		const price = row.price
		if (price !== null) {
			const net = p.prices_include_vat ? price / (1 + vat) : price
			const gross = p.prices_include_vat ? price : price * (1 + vat)
			row.list_rate = roundTo(inclusive ? gross : net, 2)
			row.shelf_price = inclusive
				? row.list_rate
				: roundTo(row.list_rate * (1 + vat), 2)
			if (costPerStock !== null && costPerStock > 0) {
				const exactCost = costPerStock * factor
				row.margin_pct = roundTo(((price - exactCost) / exactCost) * 100, 1)
				if (net < exactCost - 0.005)
					warnings.push({ step: "prices", code: "below_cost", uom: u.uom })
			}
			if (price <= 0)
				warnings.push({ step: "prices", code: "zero_price", uom: u.uom })
			if (p.prices_include_vat && Math.abs(row.shelf_price - price) > 0.001)
				warnings.push({
					step: "prices",
					code: "vat_rounding",
					uom: u.uom,
					shelf_price: row.shelf_price,
				})
		}
		units.push(row)
	}
	let stockQty = null
	const o = p.opening_stock
	if (o.qty) {
		const f = factors[o.uom || buyUom]
		stockQty = f ? roundTo(o.qty * f, 6) : null
	}
	return {
		factors,
		purchase_uom: buyUom,
		cost_per_stock_uom: costPerStock !== null ? roundTo(costPerStock, 4) : null,
		base_price: base,
		units,
		entry_unit: entry,
		opening_stock_qty: stockQty,
		warnings,
		errors,
	}
}

/**
 * null when the barcode may be used. GTINs (8, 12, 13, 14 digits) need a valid check digit.
 * @param {string} code
 */
export function barcodeFormatError(code) {
	if (!code) return null
	if (code.length > 40 || !/^[A-Za-z0-9\-.]+$/.test(code))
		return "barcode_format"
	if (
		isDigits(code) &&
		[8, 12, 13, 14].includes(code.length) &&
		!hasValidCheckDigit(code)
	)
		return "barcode_check_digit"
	return null
}

/**
 * Problems that need no server, per step.
 * @param {ReturnType<typeof normalize>} p
 * @param {string[]} [steps]
 * @returns {WizardIssue[]}
 */
export function payloadErrors(p, steps) {
	/** @type {WizardIssue[]} */
	let errors = []
	if (!p.item_name)
		errors.push({ step: "basics", code: "required", field: "item_name" })
	if (!p.item_group)
		errors.push({ step: "basics", code: "required", field: "item_group" })
	if (!p.stock_uom)
		errors.push({ step: "basics", code: "required", field: "stock_uom" })
	const { factors, errors: unitErrs } = unitFactors(p)
	errors.push(...unitErrs)
	const live = p.selling_units.filter((u) => !u.remove)
	if (!live.length) errors.push({ step: "selling", code: "no_selling_unit" })
	if (p.selling_units.length + p.buying_units.length > MAX_UNITS * 2)
		errors.push({ step: "selling", code: "too_many_units" })
	if (p.sold_on_scale && !ENTRY_UNITS[p.stock_uom])
		errors.push({ step: "selling", code: "scale_needs_weight_unit" })
	if (
		p.price_mode === "price" &&
		p.base_price === null &&
		live.some((u) => u.priced && u.price === null)
	)
		errors.push({ step: "prices", code: "required", field: "base_price" })
	if (p.price_mode === "margin") {
		if (p.buying_price === null)
			errors.push({ step: "prices", code: "margin_needs_cost" })
		if (p.margin_pct === null)
			errors.push({ step: "prices", code: "required", field: "margin_pct" })
	}
	for (const u of live)
		if (u.price !== null && u.price < 0)
			errors.push({ step: "prices", code: "negative_price", uom: u.uom })
	if (p.buying_price !== null && p.buying_price < 0)
		errors.push({
			step: "buying",
			code: "negative_price",
			field: "buying_price",
		})
	const seen = new Map()
	for (const u of live) {
		const code = u.barcode
		if (!code) continue
		const problem = barcodeFormatError(code)
		if (problem)
			errors.push({
				step: "barcodes",
				code: problem,
				uom: u.uom,
				barcode: code,
			})
		if (seen.has(code))
			errors.push({
				step: "barcodes",
				code: "barcode_repeated",
				uom: u.uom,
				barcode: code,
			})
		seen.set(code, u.uom)
	}
	const o = p.opening_stock
	if (o.qty !== null) {
		if (o.qty < 0) errors.push({ step: "stock", code: "negative_qty" })
		else if (o.qty > 0) {
			if (!o.warehouse)
				errors.push({ step: "stock", code: "required", field: "warehouse" })
			if (!((o.uom || purchaseUom(p)) in factors))
				errors.push({ step: "stock", code: "unknown_unit", uom: o.uom })
			if (o.cost !== null && o.cost < 0)
				errors.push({ step: "stock", code: "negative_price", field: "cost" })
		}
	}
	if (steps?.length) errors = errors.filter((e) => steps.includes(e.step))
	return errors
}

/**
 * Progress through the 8 steps, 0..100.
 * @param {string} step
 * @param {string[]} [steps] steps in use (edit mode uses buying..barcodes)
 */
export function progressPercent(step, steps = [...STEPS]) {
	const i = steps.indexOf(step)
	if (i < 0) return 0
	return Math.round(((i + 1) / steps.length) * 100)
}

/**
 * Selling-unit rows a fresh payload gets for a stock unit (stock unit only).
 * @param {string} stockUom
 */
export function defaultSellingUnits(stockUom) {
	return [
		{
			uom: stockUom,
			size: 1,
			size_uom: stockUom,
			priced: 1,
			price: null,
			barcode: "",
		},
	]
}
