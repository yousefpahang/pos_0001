# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""F9 tests: POS Printer Profile, printing cache, receipt data for reprints, No Sale log.

Needs the demo data from pos_next/pos_0001/demo/seed.py (POS Profile "Main Till", user
cashier@pos.test, items ITM-xxxxx, mode of payment Cash of type Cash).
"""

from __future__ import annotations

import json
import time
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase

from pos_next.pos_0001.api import printing, sync
from pos_next.pos_0001.tests.test_sync import CASHIER, PROFILE, _device_id, _ensure_outsider, _payload

PRINTER_A = "POS0001 Test Receipt A"
PRINTER_B = "POS0001 Test Receipt B"
NO_SALE_ROLE = "POS0001 Test No Sale"


def _printer(name: str, **values) -> str:
	if frappe.db.exists("POS Printer Profile", name):
		frappe.delete_doc("POS Printer Profile", name, force=True, ignore_permissions=True)
	doc = frappe.get_doc(
		{
			"doctype": "POS Printer Profile",
			"printer_name": name,
			"purpose": "Receipt",
			"connection": "QZ Local Printer",
			"print_mode": "raster",
			"paper_width_mm": "80",
			"copies": 1,
			"drawer_kick": 1,
			"auto_cut": 1,
			**values,
		}
	)
	doc.insert(ignore_permissions=True)
	return doc.name


def _ensure_role() -> None:
	if not frappe.db.exists("Role", NO_SALE_ROLE):
		frappe.get_doc({"doctype": "Role", "role_name": NO_SALE_ROLE, "desk_access": 0}).insert(
			ignore_permissions=True
		)


def _set_cashier_role(present: bool) -> None:
	user = frappe.get_doc("User", CASHIER)
	has = any(r.role == NO_SALE_ROLE for r in user.roles)
	if present and not has:
		user.append("roles", {"role": NO_SALE_ROLE})
		user.save(ignore_permissions=True)
	elif not present and has:
		user.set("roles", [r for r in user.roles if r.role != NO_SALE_ROLE])
		user.save(ignore_permissions=True)
	frappe.clear_cache(user=CASHIER)


class PrintingTestCase(FrappeTestCase):
	def setUp(self) -> None:
		frappe.set_user("Administrator")
		self.saved = frappe.db.get_value(
			"POS Profile", PROFILE, ["pos0001_receipt_printer", "pos0001_no_sale_role", "pos0001_receipt_footer"],
			as_dict=True,
		)

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		frappe.db.set_value(
			"POS Profile",
			PROFILE,
			{
				"pos0001_receipt_printer": self.saved.pos0001_receipt_printer,
				"pos0001_no_sale_role": self.saved.pos0001_no_sale_role,
				"pos0001_receipt_footer": self.saved.pos0001_receipt_footer,
			},
		)
		_set_cashier_role(False)


class TestPrinterProfile(PrintingTestCase):
	def test_copies_must_be_1_to_3(self) -> None:
		with self.assertRaises(frappe.ValidationError):
			_printer(PRINTER_A, copies=4)
		name = _printer(PRINTER_A, copies=3)
		self.assertEqual(printing.printer_dict(name)["copies"], 3)

	def test_network_printer_needs_an_address(self) -> None:
		with self.assertRaises(frappe.ValidationError):
			_printer(PRINTER_A, connection="Network", network_host="not a host!")
		name = _printer(PRINTER_A, connection="Network", network_host=" 192.168.1.50 ", network_port=0)
		row = printing.printer_dict(name)
		self.assertEqual((row["network_host"], row["network_port"]), ("192.168.1.50", 9100))

	def test_characters_per_line_range(self) -> None:
		with self.assertRaises(frappe.ValidationError):
			_printer(PRINTER_A, print_mode="escpos_text", characters_per_line=10)
		name = _printer(PRINTER_A, print_mode="escpos_text", characters_per_line=42)
		self.assertEqual(printing.printer_dict(name)["characters_per_line"], 42)

	def test_disabled_printer_is_not_used(self) -> None:
		name = _printer(PRINTER_A, enabled=0)
		self.assertIsNone(printing.printer_dict(name))
		self.assertIsNone(printing.printer_dict(None))


class TestPrintingCache(PrintingTestCase):
	def test_profile_printer_and_device_override(self) -> None:
		a = _printer(PRINTER_A, print_mode="escpos_text", paper_width_mm="58")
		b = _printer(PRINTER_B, print_mode="raster")
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_receipt_printer", a)
		device = _device_id()

		frappe.set_user(CASHIER)
		registered = sync.register_device(device, None, PROFILE, "test")
		# Receipt printer, then the profile's label printer when one is set (Phase 5).
		label = frappe.db.get_value("POS Profile", PROFILE, "pos0001_label_printer")
		expected = [a] + ([label] if label and printing.printer_dict(label) else [])
		self.assertEqual([p["name"] for p in registered["printer_profiles"]], expected)
		cache = printing.get_printing_cache(PROFILE, device)
		self.assertEqual(cache["printer"]["name"], a)
		self.assertEqual(cache["printer"]["paper_width_mm"], 58)
		self.assertEqual(cache["printer"]["print_mode"], "escpos_text")

		frappe.set_user("Administrator")
		frappe.db.set_value("POS Device", device, "receipt_printer", b)
		frappe.set_user(CASHIER)
		self.assertEqual(printing.get_printing_cache(PROFILE, device)["printer"]["name"], b)

	def test_no_printer_means_pos_next_printing(self) -> None:
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_receipt_printer", None)
		frappe.set_user(CASHIER)
		cache = printing.get_printing_cache(PROFILE, _device_id())
		self.assertIsNone(cache["printer"])

	def test_cache_contents(self) -> None:
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_receipt_footer", "Thanks / شكرا")
		frappe.set_user(CASHIER)
		cache = printing.get_printing_cache(PROFILE)
		self.assertIn("Cash", cache["cash_modes"])
		self.assertNotIn("Card", cache["cash_modes"])
		company = frappe.db.get_value("POS Profile", PROFILE, "company")
		self.assertEqual(cache["company"]["name"], frappe.db.get_value("Company", company, "company_name"))
		self.assertEqual(cache["footer"], "Thanks / شكرا")
		self.assertTrue(cache["print_format"])
		self.assertTrue(cache["cashier"])

	def test_no_sale_permission(self) -> None:
		_ensure_role()
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_no_sale_role", None)
		frappe.set_user(CASHIER)
		self.assertFalse(printing.get_printing_cache(PROFILE)["can_no_sale"])  # empty role: managers only

		frappe.set_user("Administrator")
		self.assertTrue(printing.can_open_drawer(PROFILE))
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_no_sale_role", NO_SALE_ROLE)
		frappe.set_user(CASHIER)
		self.assertFalse(printing.get_printing_cache(PROFILE)["can_no_sale"])

		frappe.set_user("Administrator")
		_set_cashier_role(True)
		frappe.set_user(CASHIER)
		self.assertTrue(printing.get_printing_cache(PROFILE)["can_no_sale"])

	def test_access(self) -> None:
		frappe.set_user(_ensure_outsider())
		with self.assertRaises(frappe.PermissionError):
			printing.get_printing_cache(PROFILE)
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			printing.get_printing_cache(PROFILE)


class TestReceiptData(PrintingTestCase):
	def test_receipt_data_for_reprint(self) -> None:
		payload = _payload()
		payload["sales_team"] = []
		result = sync.submit_offline_invoice(json.dumps(payload), _device_id())
		self.assertEqual(result["status"], "Synced", result)
		name = result["invoice_name"]
		invoice = frappe.get_doc("Sales Invoice", name)

		frappe.set_user(CASHIER)
		data = printing.get_receipt_data(name)
		self.assertEqual(data["name"], name)
		self.assertEqual(data["offline_id"], payload["offline_id"])
		self.assertEqual(data["pos_profile"], PROFILE)
		self.assertEqual(len(data["items"]), len(invoice.items))
		self.assertIn("item_name_ar", data["items"][0])
		self.assertAlmostEqual(data["grand_total"], invoice.grand_total)
		self.assertAlmostEqual(sum(p["amount"] for p in data["payments"]), invoice.paid_amount)
		self.assertEqual(data["payments"][0]["type"], "Cash")
		self.assertAlmostEqual(
			sum(t["tax_amount"] for t in data["taxes"]), invoice.total_taxes_and_charges, places=2
		)

		frappe.set_user(_ensure_outsider())
		with self.assertRaises(frappe.PermissionError):
			printing.get_receipt_data(name)

	def test_missing_invoice(self) -> None:
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.DoesNotExistError):
			printing.get_receipt_data("NO-SUCH-INVOICE")


class TestDrawerEvents(PrintingTestCase):
	def _event(self, **values) -> dict:
		return {
			"event_id": f"ns-{uuid.uuid4().hex[:20]}",
			"pos_profile": PROFILE,
			"opened_at": int(time.time() * 1000),
			"reason": "Change for customer",
			"was_offline": 0,
			**values,
		}

	def test_logged_once_with_permission(self) -> None:
		_ensure_role()
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_no_sale_role", NO_SALE_ROLE)
		_set_cashier_role(True)
		device = _device_id()
		frappe.set_user(CASHIER)
		sync.register_device(device, None, PROFILE, "test")
		event = self._event(device_id=device, was_offline=1)
		first = printing.log_drawer_events(json.dumps([event]))
		second = printing.log_drawer_events(json.dumps([event]))
		self.assertEqual(first[0]["status"], "Stored")
		self.assertEqual(second[0]["status"], "Stored")
		frappe.set_user("Administrator")
		self.assertEqual(frappe.db.count("POS Drawer Event", {"event_id": event["event_id"]}), 1)
		row = frappe.db.get_value(
			"POS Drawer Event",
			event["event_id"],
			["user", "permitted", "pos_device", "was_offline", "reason", "opened_at"],
			as_dict=True,
		)
		self.assertEqual((row.user, row.permitted, row.pos_device, row.was_offline), (CASHIER, 1, device, 1))
		self.assertEqual(row.reason, "Change for customer")
		self.assertIsNotNone(row.opened_at)

	def test_stored_as_not_permitted_without_role(self) -> None:
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_no_sale_role", None)
		frappe.set_user(CASHIER)
		event = self._event()
		result = printing.log_drawer_events([event])
		self.assertEqual(result[0]["permitted"], 0)
		frappe.set_user("Administrator")
		self.assertEqual(frappe.db.get_value("POS Drawer Event", event["event_id"], "permitted"), 0)

	def test_rejects_bad_input_and_other_profiles(self) -> None:
		frappe.set_user(CASHIER)
		self.assertEqual(printing.log_drawer_events([{"pos_profile": PROFILE}])[0]["status"], "Rejected")
		with self.assertRaises(frappe.ValidationError):
			printing.log_drawer_events({"event_id": "x"})
		frappe.set_user(_ensure_outsider())
		with self.assertRaises(frappe.PermissionError):
			printing.log_drawer_events([self._event()])
