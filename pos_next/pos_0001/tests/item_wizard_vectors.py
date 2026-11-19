# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Writes item_wizard_vectors.json, the shared test vectors of the Item Wizard price logic
(pos_0001/item_wizard.py and POS/src/plus/core/itemWizard.js). Re-run after a deliberate change:

    bench --site pos.test execute pos_next.pos_0001.tests.item_wizard_vectors.run

then review the diff. test_item_wizard and itemWizard.test.js check both copies against it.
"""

import json
import os

from pos_next.pos_0001 import item_wizard as w

CASES = [
	{
		"name": "rice: SPEC F13 worked example",
		"vat_rate": 5,
		"profile_inclusive": 0,
		"payload": {
			"stock_uom": "Kg",
			"buying_units": [{"uom": "Bag", "size": 25}],
			"buying_price": 75,
			"selling_units": [
				{"uom": "Kg", "size": 1},
				{"uom": "Pack", "size": 500, "size_uom": "Gram", "price": 2.5},
				{"uom": "Bag", "size": 1, "size_uom": "Bag", "price": 99},
			],
			"base_price": 4.5,
			"prices_include_vat": 1,
			"opening_stock": {"qty": 4, "uom": "Bag", "warehouse": "Stores"},
		},
	},
	{
		"name": "rice by margin, profile prices include VAT",
		"vat_rate": 5,
		"profile_inclusive": 1,
		"payload": {
			"stock_uom": "Kg",
			"buying_units": [{"uom": "Bag", "size": 25, "parent_uom": "Kg"}],
			"buying_price": 75,
			"selling_units": [{"uom": "Kg"}, {"uom": "Bag", "size": 25, "margin": 30}],
			"price_mode": "margin",
			"margin_pct": 50,
			"prices_include_vat": 1,
		},
	},
	{
		"name": "pre-packed: two buying levels listed bottom first, prices excl. VAT",
		"vat_rate": 5,
		"profile_inclusive": 0,
		"payload": {
			"stock_uom": "Kg",
			"buying_units": [
				{"uom": "Pack", "size": 500, "parent_uom": "Gram"},
				{"uom": "Carton", "size": 12, "parent_uom": "Pack"},
			],
			"buying_price": 30,
			"selling_units": [
				{"uom": "Pack", "size": 1, "size_uom": "Pack"},
				{"uom": "Carton", "size": 1, "size_uom": "Carton", "price": 32},
			],
			"base_price": 5.99,
			"prices_include_vat": 0,
			"opening_stock": {"qty": 2, "uom": "Carton", "warehouse": "Stores", "cost": 30},
		},
	},
	{
		"name": "liquid with below-cost can and VAT rounding",
		"vat_rate": 5,
		"profile_inclusive": 0,
		"payload": {
			"stock_uom": "Litre",
			"buying_units": [{"uom": "Drum", "size": 200}],
			"buying_price": 1000,
			"selling_units": [
				{"uom": "Litre", "size": 1},
				{"uom": "Can", "size": 5, "price": 25.1},
				{"uom": "Millilitre", "size": 1, "size_uom": "Millilitre"},
			],
			"base_price": 0.1,
			"prices_include_vat": 1,
		},
	},
	{
		"name": "pieces, zero rated, no cost",
		"vat_rate": 0,
		"profile_inclusive": 0,
		"payload": {
			"stock_uom": "Nos",
			"buying_units": [{"uom": "Carton", "size": 24}],
			"selling_units": [{"uom": "Nos"}, {"uom": "Carton", "size": 1, "size_uom": "Carton"}],
			"base_price": 1.25,
			"prices_include_vat": 1,
		},
	},
	{
		"name": "errors: unknown unit, conflicting size, bad barcodes, missing price",
		"vat_rate": 5,
		"profile_inclusive": 0,
		"payload": {
			"item_name": "Broken",
			"item_group": "Groceries",
			"stock_uom": "Kg",
			"buying_units": [{"uom": "Sack", "size": 2, "parent_uom": "Crate"}, {"uom": "Bag", "size": 0}],
			"selling_units": [
				{"uom": "Kg", "barcode": "2900000000018"},
				{"uom": "Pack", "size": 0.5, "barcode": "2900000000018"},
				{"uom": "Pack", "size": 0.25},
				{"uom": "Box", "size": 2, "size_uom": "Box", "barcode": "1234567890123"},
			],
			"sold_on_scale": 1,
			"opening_stock": {"qty": 3, "uom": "Crate"},
		},
	},
]


def run():
	out = []
	for case in CASES:
		p = w.normalize(case["payload"])
		calc = w.unit_prices(p, case["vat_rate"], case["profile_inclusive"])
		out.append(
			{
				**case,
				"expected": {
					"factors": calc["factors"],
					"purchase_uom": calc["purchase_uom"],
					"cost_per_stock_uom": calc["cost_per_stock_uom"],
					"base_price": calc["base_price"],
					"units": calc["units"],
					"opening_stock_qty": calc["opening_stock_qty"],
					"warnings": calc["warnings"],
					"errors": calc["errors"],
					"payload_errors": w.payload_errors(p),
				},
			}
		)
	path = os.path.join(os.path.dirname(__file__), "item_wizard_vectors.json")
	with open(path, "w", encoding="utf-8") as handle:
		handle.write(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
	print(json.dumps([c["expected"] for c in out[1:]], indent=1))
