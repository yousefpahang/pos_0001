// Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
// Plain-words messages for Item Wizard issue codes (plus/core/itemWizard.js). Same English as
// error_message() in pos_0001/item_wizard.py, so one ar.csv row translates both.

const FIELD_LABELS = {
	item_name: "Item name",
	item_group: "Item group",
	stock_uom: "Stock unit",
	base_price: "Price per stock unit",
	margin_pct: "Margin %",
	warehouse: "Warehouse",
	buying_price: "Buying price",
	cost: "Cost",
	item_code: "Item code",
}

/**
 * @param {{code: string, uom?: string, field?: string, barcode?: string, parent_uom?: string,
 *   item_code?: string, value?: string, shelf_price?: number, message?: string}} e
 * @returns {string}
 */
export function issueMessage(e) {
	if (e.message) return e.message
	const uom = e.uom || ""
	switch (e.code) {
		case "required":
			return __("{0} is required. Fill it in to continue.", [
				__(FIELD_LABELS[e.field] || e.field),
			])
		case "size_not_positive":
			return __("Size of {0} must be more than 0.", [uom])
		case "buying_is_stock_unit":
			return __(
				"{0} is the stock unit; a buying unit must be a bigger unit such as Bag.",
				[uom],
			)
		case "unknown_unit":
			return __(
				"{0} is measured in {1}, which is not one of this item's units. Add {1} first or pick another unit.",
				[uom, e.parent_uom || ""],
			)
		case "duplicate_unit":
			return __("{0} is listed twice. Keep one row per unit.", [uom])
		case "entry_unit_not_sold":
			return __(
				"{0} is an entry unit: the cashier types grams and the cart sells Kg. Remove the {0} row.",
				[uom],
			)
		case "conflicting_size":
			return __(
				"{0} has two different sizes. Use the same size in buying and selling.",
				[uom],
			)
		case "no_selling_unit":
			return __("Tick at least one selling unit.")
		case "too_many_units":
			return __(
				"Too many units. Keep at most {0} buying and {0} selling units.",
				[8],
			)
		case "scale_needs_weight_unit":
			return __("Items sold on the scale need Kg or Litre as stock unit.")
		case "margin_needs_cost":
			return __(
				"A margin needs the buying price. Enter it on the buying step or type the price.",
			)
		case "negative_price":
			return __("Prices cannot be negative.")
		case "barcode_format":
			return __(
				"Barcode {0} has characters a scanner cannot read. Use digits or letters only.",
				[e.barcode],
			)
		case "barcode_check_digit":
			return __(
				"Barcode {0} has a wrong check digit. Scan it again or press Generate.",
				[e.barcode],
			)
		case "barcode_repeated":
			return __(
				"Barcode {0} is used for two units. Each unit needs its own barcode.",
				[e.barcode],
			)
		case "negative_qty":
			return __("Opening stock cannot be negative.")
		case "below_cost":
			return __("{0} sells below cost.", [uom])
		case "zero_price":
			return __("{0} has price 0.", [uom])
		case "vat_rounding":
			return __("{0}: after VAT rounding the shelf price is {1}.", [
				uom,
				e.shelf_price,
			])
		default:
			return e.code || __("Unknown problem")
	}
}

/** Step titles (STEPS order). */
export function stepTitle(step) {
	return (
		{
			start: __("Start"),
			basics: __("Basics"),
			buying: __("How you buy it"),
			selling: __("How you sell it"),
			prices: __("Prices"),
			barcodes: __("Barcodes"),
			stock: __("Opening stock"),
			review: __("Review and create"),
		}[step] || step
	)
}
