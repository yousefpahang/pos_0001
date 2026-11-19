// Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
/**
 * Entry units in the cart (SPEC F13 "POS support"): a cashier types a weight in grams for a Kg
 * item (or millilitres for a Litre item) and the cart line stays in Kg at the per-Kg price:
 * 250 g -> 0.250 Kg. Gram is never a cart unit, so no per-gram price is ever used.
 *
 * Plain JavaScript, no Vue imports.
 */
import { ENTRY_UNITS } from "./itemWizard.js"
import { roundTo } from "./scaleBarcode.js"

/** Stock quantity decimals of a weighed line (3 = grams). */
export const STOCK_QTY_DECIMALS = 3

/**
 * Entry unit of a stock unit, or null.
 * @param {string|null|undefined} stockUom
 * @returns {{uom: string, factor: number, symbol: string}|null}
 */
export function entryUnitFor(stockUom) {
	return (stockUom && ENTRY_UNITS[stockUom]) || null
}

/**
 * True when the cart line can take a gram (or ml) entry: it is sold in its stock unit, the stock
 * unit has an entry unit, and its quantity is not fixed by a scanned scale label.
 * @param {{uom?: string, stock_uom?: string, is_resolved_barcode?: boolean,
 *   pos0001_scale_barcode?: string|null}} line
 */
export function canEnterSmallUnit(line) {
	if (!line || line.is_resolved_barcode || line.pos0001_scale_barcode) return false
	const stock = line.stock_uom || line.uom
	if (!entryUnitFor(stock)) return false
	return (line.uom || stock) === stock
}

/**
 * Stock quantity for an amount typed in the entry unit: 250 g -> 0.25 Kg. null when the input
 * is not a positive number or rounds to 0.
 * @param {string|number} value
 * @param {string} stockUom
 */
export function entryToStockQty(value, stockUom) {
	const entry = entryUnitFor(stockUom)
	if (!entry) return null
	const cleaned = typeof value === "string" ? value.replace(",", ".").trim() : value
	if (cleaned === "" || cleaned === null || cleaned === undefined) return null
	const n = Number(cleaned)
	if (!Number.isFinite(n) || n <= 0) return null
	const qty = roundTo(n * entry.factor, STOCK_QTY_DECIMALS)
	return qty > 0 ? qty : null
}

/**
 * The entry-unit amount of a stock quantity (0.25 Kg -> 250), for pre-filling the input.
 * @param {number} qty
 * @param {string} stockUom
 */
export function stockQtyToEntry(qty, stockUom) {
	const entry = entryUnitFor(stockUom)
	if (!entry || !Number.isFinite(Number(qty))) return null
	return roundTo(Number(qty) / entry.factor, 0)
}
