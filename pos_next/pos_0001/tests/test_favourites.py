# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Favourites quick grid: top sellers per POS Profile (SPEC section 6)."""

from __future__ import annotations

import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt

from pos_next.pos_0001.api import favourites, sync
from pos_next.pos_0001.tests.test_sync import CASHIER, PROFILE, _ensure_outsider

ITEM_A = "ITM-19990"
ITEM_B = "ITM-19991"


def _ensure_price(item_code: str) -> None:
	price_list = frappe.db.get_value("POS Profile", PROFILE, "selling_price_list")
	if not frappe.db.exists("Item Price", {"item_code": item_code, "price_list": price_list}):
		frappe.get_doc(
			{"doctype": "Item Price", "item_code": item_code, "price_list": price_list, "price_list_rate": 5}
		).insert(ignore_permissions=True)


def _sell(item_code: str, qty: float, is_return: bool = False) -> None:
	profile = frappe.get_cached_doc("POS Profile", PROFILE)
	invoice = {
		"doctype": "Sales Invoice",
		"is_pos": 1,
		"update_stock": 1,
		"company": profile.company,
		"pos_profile": PROFILE,
		"customer": "Walk-in Customer",
		"currency": profile.currency,
		"selling_price_list": profile.selling_price_list,
		"set_warehouse": profile.warehouse,
		"taxes_and_charges": profile.taxes_and_charges,
		"items": [{"item_code": item_code, "qty": qty, "rate": 5, "warehouse": profile.warehouse, "uom": "Nos"}],
		"offline_id": f"pos_offline_fav-{uuid.uuid4()}",
	}
	draft = frappe.get_doc(json.loads(json.dumps(invoice)))
	draft.set_missing_values()
	draft.calculate_taxes_and_totals()
	total = flt(draft.rounded_total or draft.grand_total)
	invoice["payments"] = [{"mode_of_payment": "Cash", "amount": total}]
	result = sync.process_offline_invoice(invoice)
	assert result.get("status") == "Synced", result


class TestFavourites(FrappeTestCase):
	def setUp(self) -> None:
		frappe.set_user("Administrator")
		for code in (ITEM_A, ITEM_B):
			_ensure_price(code)

	def tearDown(self) -> None:
		frappe.set_user("Administrator")

	def test_top_sellers_by_quantity(self) -> None:
		_sell(ITEM_A, 9)
		_sell(ITEM_B, 4)
		_sell(ITEM_B, 1)
		frappe.set_user(CASHIER)
		result = favourites.get_favourites(PROFILE)
		codes = [row.item_code for row in result["items"]]
		self.assertIn(ITEM_A, codes)
		self.assertIn(ITEM_B, codes)
		self.assertLess(codes.index(ITEM_A), codes.index(ITEM_B))
		row_b = next(r for r in result["items"] if r.item_code == ITEM_B)
		self.assertGreaterEqual(row_b.invoices, 2)
		self.assertLessEqual(len(codes), 30)
		self.assertEqual(result["limit"], 30)

	def test_limit_and_other_profile(self) -> None:
		_sell(ITEM_A, 2)
		self.assertLessEqual(len(favourites.get_favourites(PROFILE, limit=1)["items"]), 1)
		self.assertEqual(favourites.get_favourites(PROFILE, limit=999)["limit"], favourites.MAX_LIMIT)
		other = favourites.get_favourites("Express Till")["items"]
		self.assertNotIn(ITEM_A, [r.item_code for r in other])

	def test_access(self) -> None:
		for user in (_ensure_outsider(), "Guest"):
			frappe.set_user(user)
			with self.assertRaises(frappe.PermissionError):
				favourites.get_favourites(PROFILE)
