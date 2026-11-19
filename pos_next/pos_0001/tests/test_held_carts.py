# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""F7 tests: held carts as server drafts, resumable on any till of the same POS Profile.

Needs the demo data from pos_next/pos_0001/demo/seed.py (POS Profiles "Main Till" and
"Express Till", user cashier@pos.test, items ITM-xxxxx).
"""

from __future__ import annotations

import uuid

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, now_datetime

from pos_next.pos_0001.api import held_carts
from pos_next.pos_0001.tests.test_sync import (
	CASHIER,
	ITEM,
	PROFILE,
	_device_id,
	_ensure_customer,
	_ensure_outsider,
)

OTHER_PROFILE = "Express Till"


def _hold_id() -> str:
	return f"HOLD-{uuid.uuid4()}"


def _ensure_price(item_code: str = ITEM, rate: float = 12.5) -> None:
	# ERPNext's before_tests deletes Item Prices; the draft needs one to compute totals.
	price_list = frappe.db.get_value("POS Profile", PROFILE, "selling_price_list")
	if not frappe.db.exists("Item Price", {"item_code": item_code, "price_list": price_list}):
		frappe.get_doc(
			{"doctype": "Item Price", "item_code": item_code, "price_list": price_list, "price_list_rate": rate}
		).insert(ignore_permissions=True)


def _cart(qty: float = 2, customer: str = "Walk-in Customer") -> tuple[dict, dict]:
	"""(cart, invoice) as the till sends them: POS Next cart lines plus its draft payload."""
	profile = frappe.get_cached_doc("POS Profile", PROFILE)
	lines = [{"item_code": ITEM, "item_name": "Demo item", "quantity": qty, "rate": 10, "uom": "Nos"}]
	cart = {
		"items": lines,
		"customer": {"name": customer, "customer_name": customer},
		"applied_offers": [],
		"sales_team": [{"sales_person": "Ahmed Ali", "allocated_percentage": 100}],
	}
	invoice = {
		"doctype": "Sales Invoice",
		"pos_profile": PROFILE,
		"posa_pos_opening_shift": "SHOULD-NOT-BE-STORED",
		"customer": customer,
		"is_pos": 1,
		"update_stock": 1,
		"items": [{"item_code": ITEM, "qty": qty, "rate": 10, "uom": "Nos", "warehouse": profile.warehouse}],
		"payments": [{"mode_of_payment": "Cash", "amount": 1}],
		"offline_id": "should-not-be-stored",
	}
	return cart, invoice


def _hold(hold_id: str | None = None, **kwargs) -> dict:
	cart, invoice = _cart()
	return held_carts.hold_cart(
		pos_profile=kwargs.pop("pos_profile", PROFILE),
		hold_id=hold_id or _hold_id(),
		cart=kwargs.pop("cart", cart),
		invoice=kwargs.pop("invoice", invoice),
		**kwargs,
	)


class TestHeldCarts(FrappeTestCase):
	def setUp(self) -> None:
		frappe.set_user("Administrator")
		_ensure_price()

	def tearDown(self) -> None:
		frappe.set_user("Administrator")

	def test_hold_creates_held_draft_without_shift_or_payments(self) -> None:
		frappe.set_user(CASHIER)
		hold_id = _hold_id()
		result = _hold(hold_id, note="  Customer gone to the car  ", device_id=_device_id())
		self.assertEqual(result["status"], "Held")
		held = result["held"]
		frappe.set_user("Administrator")
		doc = frappe.get_doc("Sales Invoice", held["name"])
		self.assertEqual(doc.docstatus, 0)
		self.assertEqual(doc.name, hold_id, "held drafts must not use the invoice naming series")
		self.assertEqual(doc.pos0001_held, 1)
		self.assertEqual(doc.pos0001_hold_id, hold_id)
		self.assertEqual(doc.pos0001_held_by, CASHIER)
		self.assertEqual(doc.pos0001_hold_note, "Customer gone to the car")
		self.assertFalse(doc.posa_pos_opening_shift, "held drafts must survive POS Next's shift close")
		self.assertFalse(doc.payments)
		self.assertFalse(doc.get("offline_id"))
		self.assertEqual(doc.items[0].qty, 2)
		self.assertGreater(doc.grand_total, 0)
		self.assertEqual(held["hold_id"], hold_id)
		self.assertEqual(held["held_by"], CASHIER)
		self.assertEqual(held["grand_total"], doc.grand_total)

	def test_same_hold_id_twice_gives_one_draft(self) -> None:
		hold_id = _hold_id()
		first = _hold(hold_id)
		second = _hold(hold_id)
		self.assertEqual(first["held"]["name"], second["held"]["name"])
		self.assertEqual(frappe.db.count("Sales Invoice", {"pos0001_hold_id": hold_id}), 1)

	def test_resume_on_another_till_returns_cart_and_claims_it(self) -> None:
		frappe.set_user(CASHIER)
		hold_id = _hold_id()
		cart, invoice = _cart(qty=3)
		name = held_carts.hold_cart(PROFILE, hold_id, cart, invoice, device_id=_device_id())["held"]["name"]

		# Till 2 (another device, same profile) sees it and resumes it.
		listed = held_carts.list_held_carts(PROFILE)
		self.assertIn(hold_id, [row["hold_id"] for row in listed["held"]])
		self.assertEqual(listed["retention_days"], held_carts.retention_days())
		resumed = held_carts.resume_held_cart(PROFILE, name=name)
		self.assertEqual(resumed["cart"], cart)
		self.assertEqual(resumed["held"]["hold_id"], hold_id)
		self.assertFalse(frappe.db.exists("Sales Invoice", name))

		# A second resume (till 1 still showing the old list) is refused with a plain message.
		with self.assertRaises(frappe.DoesNotExistError):
			held_carts.resume_held_cart(PROFILE, name=name)
		# A late re-upload of the same hold id does not bring the resumed cart back.
		again = held_carts.hold_cart(PROFILE, hold_id, cart, invoice)
		self.assertEqual(again["status"], "Resumed")
		self.assertFalse(frappe.db.exists("Sales Invoice", {"pos0001_hold_id": hold_id}))

	def test_resume_by_hold_id(self) -> None:
		hold_id = _hold_id()
		_hold(hold_id)
		resumed = held_carts.resume_held_cart(PROFILE, hold_id=hold_id)
		self.assertEqual(resumed["held"]["hold_id"], hold_id)

	def test_other_profile_cannot_resume_or_list(self) -> None:
		hold_id = _hold_id()
		name = _hold(hold_id)["held"]["name"]
		self.assertNotIn(hold_id, [r["hold_id"] for r in held_carts.list_held_carts(OTHER_PROFILE)["held"]])
		with self.assertRaises(frappe.PermissionError):
			held_carts.resume_held_cart(OTHER_PROFILE, name=name)
		self.assertTrue(frappe.db.exists("Sales Invoice", name))

	def test_outsider_and_guest_refused(self) -> None:
		outsider = _ensure_outsider()
		hold_id = _hold_id()
		name = _hold(hold_id)["held"]["name"]
		for user in (outsider, "Guest"):
			frappe.set_user(user)
			with self.assertRaises(frappe.PermissionError):
				held_carts.list_held_carts(PROFILE)
			with self.assertRaises(frappe.PermissionError):
				_hold()
			with self.assertRaises(frappe.PermissionError):
				held_carts.resume_held_cart(PROFILE, name=name)
			with self.assertRaises(frappe.PermissionError):
				held_carts.delete_held_cart(PROFILE, name=name)
		frappe.set_user("Administrator")
		self.assertTrue(frappe.db.exists("Sales Invoice", name))

	def test_rejected_draft_is_reported_not_raised(self) -> None:
		customer = _ensure_customer(disabled=1)
		cart, invoice = _cart(customer=customer)
		result = held_carts.hold_cart(PROFILE, _hold_id(), cart, invoice)
		self.assertEqual(result["status"], "Failed")
		self.assertTrue(result["error"])
		self.assertFalse(frappe.db.exists("Sales Invoice", {"customer": customer, "pos0001_held": 1}))

	def test_bad_input_refused(self) -> None:
		with self.assertRaises(frappe.ValidationError):
			_hold("bad id")
		cart, invoice = _cart()
		invoice["items"] = []
		with self.assertRaises(frappe.ValidationError):
			held_carts.hold_cart(PROFILE, _hold_id(), cart, invoice)

	def test_delete(self) -> None:
		name = _hold()["held"]["name"]
		self.assertEqual(held_carts.delete_held_cart(PROFILE, name=name)["status"], "Deleted")
		self.assertFalse(frappe.db.exists("Sales Invoice", name))

	def test_offline_hold_keeps_its_time_and_cleanup_uses_it(self) -> None:
		old_id, new_id = _hold_id(), _hold_id()
		old_time = add_days(now_datetime(), -5).isoformat()
		old = _hold(old_id, held_at=old_time)["held"]
		new = _hold(new_id)["held"]
		future = _hold(held_at=add_days(now_datetime(), 2).isoformat())["held"]
		self.assertLess(frappe.utils.get_datetime(old["held_at"]), add_days(now_datetime(), -4))
		self.assertLessEqual(frappe.utils.get_datetime(future["held_at"]), now_datetime())

		self.assertEqual(held_carts.cleanup_held_carts(days=0), 0)
		self.assertTrue(frappe.db.exists("Sales Invoice", old["name"]))
		held_carts.cleanup_held_carts(days=3)
		self.assertFalse(frappe.db.exists("Sales Invoice", old["name"]))
		self.assertTrue(frappe.db.exists("Sales Invoice", new["name"]))

	def test_shift_close_draft_cleanup_skips_held_carts(self) -> None:
		# POS Next deletes unprinted drafts of the closing shift; held carts carry no shift.
		name = _hold()["held"]["name"]
		self.assertFalse(frappe.db.get_value("Sales Invoice", name, "posa_pos_opening_shift"))
