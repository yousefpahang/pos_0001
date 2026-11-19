# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""F1 tests: idempotency, failed-sync storage, Retry, access checks, device registration.

Needs the demo data from pos_next/pos_0001/demo/seed.py (company Demo Trading LLC,
POS Profile "Main Till", items ITM-xxxxx with stock in "Stores - DTL", user cashier@pos.test).
"""

from __future__ import annotations

import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt

from pos_next.pos_0001.api import sync

PROFILE = "Main Till"
ITEM = "ITM-00001"
CASHIER = "cashier@pos.test"
OUTSIDER = "pos0001-outsider@pos.test"
TEST_CUSTOMER = "POS0001 Sync Test Customer"


def _offline_id() -> str:
	return f"pos_offline_{uuid.uuid4()}"


def _device_id() -> str:
	return f"test-{uuid.uuid4().hex[:16]}"


def _ensure_customer(disabled: int) -> str:
	if not frappe.db.exists("Customer", TEST_CUSTOMER):
		frappe.get_doc(
			{
				"doctype": "Customer",
				"customer_name": TEST_CUSTOMER,
				"customer_group": "Individual",
				"territory": "All Territories",
				"customer_type": "Individual",
			}
		).insert(ignore_permissions=True)
	frappe.db.set_value("Customer", TEST_CUSTOMER, "disabled", disabled)
	return TEST_CUSTOMER


def _ensure_outsider() -> str:
	if not frappe.db.exists("User", OUTSIDER):
		user = frappe.get_doc(
			{
				"doctype": "User",
				"email": OUTSIDER,
				"first_name": "Outsider",
				"send_welcome_email": 0,
				"roles": [{"role": "POSNext Cashier"}, {"role": "Sales User"}],
			}
		)
		user.insert(ignore_permissions=True)
	return OUTSIDER


def _payload(customer: str = "Walk-in Customer", offline_id: str | None = None) -> dict:
	"""Invoice dict shaped like the one the POS stores in its offline queue."""
	profile = frappe.get_cached_doc("POS Profile", PROFILE)
	invoice = {
		"doctype": "Sales Invoice",
		"is_pos": 1,
		"update_stock": 1,
		"company": profile.company,
		"pos_profile": PROFILE,
		"customer": customer,
		"currency": profile.currency,
		"selling_price_list": profile.selling_price_list,
		"set_warehouse": profile.warehouse,
		"taxes_and_charges": profile.taxes_and_charges,
		"items": [{"item_code": ITEM, "qty": 1, "rate": 10, "warehouse": profile.warehouse, "uom": "Nos"}],
		"offline_id": offline_id or _offline_id(),
	}
	# Pay the exact total so the test does not depend on the VAT template or rounding settings.
	draft = frappe.get_doc(json.loads(json.dumps({**invoice, "customer": "Walk-in Customer"})))
	draft.set_missing_values()
	draft.calculate_taxes_and_totals()
	total = flt(draft.rounded_total or draft.grand_total)
	invoice["payments"] = [{"mode_of_payment": "Cash", "amount": total}]
	invoice["grand_total"] = total
	return invoice


def _invoices_for(offline_id: str) -> list[str]:
	name = frappe.db.get_value("Offline Invoice Sync", {"offline_id": offline_id}, "sales_invoice")
	return [name] if name and frappe.db.exists("Sales Invoice", {"name": name, "docstatus": 1}) else []


class TestOfflineSync(FrappeTestCase):
	def setUp(self) -> None:
		frappe.set_user("Administrator")

	def tearDown(self) -> None:
		frappe.set_user("Administrator")

	def test_same_offline_id_twice_creates_one_invoice(self) -> None:
		payload = _payload()
		first = sync.submit_offline_invoice(json.dumps(payload), _device_id())
		second = sync.submit_offline_invoice(json.dumps(payload), _device_id())

		self.assertEqual(first["status"], "Synced", first)
		self.assertEqual(second["status"], "Synced", second)
		self.assertEqual(first["invoice_name"], second["invoice_name"])
		self.assertTrue(second["duplicate_prevented"])
		self.assertEqual(frappe.db.count("Offline Invoice Sync", {"offline_id": payload["offline_id"]}), 1)
		# The submitted invoice carries no other copy of this sale.
		self.assertEqual(_invoices_for(payload["offline_id"]), [first["invoice_name"]])

	def test_rejected_invoice_is_stored_as_failed_with_payload_and_error(self) -> None:
		customer = _ensure_customer(disabled=1)
		device = _device_id()
		payload = _payload(customer=customer)
		drafts_before = frappe.db.count("Sales Invoice", {"customer": customer})

		result = sync.submit_offline_invoice(json.dumps(payload), device)

		self.assertEqual(result["status"], "Failed", result)
		self.assertTrue(result["stored"])
		self.assertTrue(result["error"])
		row = frappe.get_doc("Offline Invoice Sync", {"offline_id": payload["offline_id"]})
		self.assertEqual(row.status, "Failed")
		self.assertEqual(row.pos_device, device)
		self.assertEqual(row.retry_count, 1)
		self.assertIn("disabled", row.error.lower())
		self.assertEqual(json.loads(row.payload)["offline_id"], payload["offline_id"])
		self.assertEqual(json.loads(row.payload)["items"][0]["item_code"], ITEM)
		# No Draft invoice is left behind (DECISIONS.md item 2).
		self.assertEqual(frappe.db.count("Sales Invoice", {"customer": customer}), drafts_before)

		status = sync.get_sync_status(device)
		self.assertEqual(status["failed_count"], 1)
		self.assertEqual(status["rows"][0]["offline_id"], payload["offline_id"])

	def test_second_failure_increments_retry_count(self) -> None:
		customer = _ensure_customer(disabled=1)
		payload = _payload(customer=customer)
		sync.submit_offline_invoice(json.dumps(payload), None)
		result = sync.retry_failed(json.dumps([payload["offline_id"]]))
		self.assertEqual(result[0]["status"], "Failed")
		row = frappe.db.get_value(
			"Offline Invoice Sync", {"offline_id": payload["offline_id"]}, ["status", "retry_count"], as_dict=True
		)
		self.assertEqual((row.status, row.retry_count), ("Failed", 2))

	def test_retry_succeeds_after_fixing_the_cause(self) -> None:
		customer = _ensure_customer(disabled=1)
		payload = _payload(customer=customer)
		self.assertEqual(sync.submit_offline_invoice(json.dumps(payload), None)["status"], "Failed")

		_ensure_customer(disabled=0)
		result = sync.retry_failed(json.dumps([payload["offline_id"]]))

		self.assertEqual(result[0]["status"], "Synced", result)
		invoice = frappe.get_doc("Sales Invoice", result[0]["invoice_name"])
		self.assertEqual(invoice.docstatus, 1)
		self.assertEqual(invoice.customer, customer)
		row = frappe.db.get_value(
			"Offline Invoice Sync",
			{"offline_id": payload["offline_id"]},
			["status", "sales_invoice", "error"],
			as_dict=True,
		)
		self.assertEqual(row.status, "Synced")
		self.assertEqual(row.sales_invoice, invoice.name)
		self.assertFalse(row.error)
		# Retrying again is a no-op that returns the same invoice.
		again = sync.retry_failed([payload["offline_id"]])
		self.assertEqual(again[0], {**again[0], "status": "Synced", "invoice_name": invoice.name})

	def test_device_is_written_on_invoice_and_sync_row(self) -> None:
		device = _device_id()
		sync.register_device(device, "Till 1", PROFILE, "test")
		result = sync.submit_offline_invoice(json.dumps(_payload()), device)
		self.assertEqual(result["status"], "Synced", result)
		self.assertEqual(frappe.db.get_value("Sales Invoice", result["invoice_name"], "pos_device"), device)
		self.assertEqual(frappe.db.get_value("POS Device", device, "device_name"), "Till 1")

	def test_cashier_listed_on_profile_can_sync(self) -> None:
		frappe.set_user(CASHIER)
		result = sync.submit_offline_invoice(json.dumps(_payload()), _device_id())
		self.assertEqual(result["status"], "Synced", result)


class TestBatchSync(FrappeTestCase):
	"""submit_offline_invoices: several queued invoices in one request (SPEC section 6)."""

	def setUp(self) -> None:
		frappe.set_user("Administrator")

	def tearDown(self) -> None:
		frappe.set_user("Administrator")

	def test_batch_answers_each_invoice_in_order(self) -> None:
		good = _payload()
		rejected = _payload(customer=_ensure_customer(disabled=1))
		other = _payload()
		device = _device_id()

		results = sync.submit_offline_invoices(json.dumps([good, rejected, good, other]), device)

		self.assertEqual([r["offline_id"] for r in results], [p["offline_id"] for p in (good, rejected, good, other)])
		self.assertEqual([r["status"] for r in results], ["Synced", "Failed", "Synced", "Synced"], results)
		self.assertTrue(results[1]["stored"])
		self.assertIn("disabled", results[1]["error"].lower())
		# The same offline_id twice in one batch gives one invoice.
		self.assertEqual(results[0]["invoice_name"], results[2]["invoice_name"])
		self.assertTrue(results[2]["duplicate_prevented"])
		self.assertNotEqual(results[0]["invoice_name"], results[3]["invoice_name"])
		self.assertEqual(frappe.db.count("Offline Invoice Sync", {"offline_id": good["offline_id"]}), 1)
		self.assertEqual(frappe.db.get_value("Sales Invoice", results[3]["invoice_name"], "pos_device"), device)
		failed = frappe.db.get_value(
			"Offline Invoice Sync", {"offline_id": rejected["offline_id"]}, ["status", "payload"], as_dict=True
		)
		self.assertEqual(failed.status, "Failed")
		self.assertEqual(json.loads(failed.payload)["offline_id"], rejected["offline_id"])

	def test_invoice_that_cannot_be_processed_is_not_stored(self) -> None:
		no_id = _payload()
		no_id.pop("offline_id")
		good = _payload()

		results = sync.submit_offline_invoices([no_id, good], None)

		self.assertEqual(results[0]["status"], "Error")
		self.assertFalse(results[0]["stored"])
		self.assertTrue(results[0]["error"])
		# One bad invoice does not stop the rest of the batch.
		self.assertEqual(results[1]["status"], "Synced", results)

	def test_outsider_gets_error_and_nothing_is_created(self) -> None:
		payload = _payload()
		frappe.set_user(_ensure_outsider())
		results = sync.submit_offline_invoices([payload], None)
		frappe.set_user("Administrator")
		self.assertEqual((results[0]["status"], results[0]["stored"]), ("Error", False))
		self.assertFalse(frappe.db.exists("Offline Invoice Sync", {"offline_id": payload["offline_id"]}))

	def test_bad_input(self) -> None:
		with self.assertRaises(frappe.ValidationError):
			sync.submit_offline_invoices(json.dumps({"offline_id": "x"}), None)
		with self.assertRaises(frappe.ValidationError):
			sync.submit_offline_invoices([{}] * (sync.MAX_BATCH + 1), None)
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			sync.submit_offline_invoices([], None)


class TestAccessChecks(FrappeTestCase):
	def setUp(self) -> None:
		frappe.set_user("Administrator")
		self.outsider = _ensure_outsider()

	def tearDown(self) -> None:
		frappe.set_user("Administrator")

	def test_submit_invoice_rejects_user_not_on_pos_profile(self) -> None:
		from pos_next.api.invoices import submit_invoice

		payload = _payload()
		frappe.set_user(self.outsider)
		with self.assertRaises(frappe.PermissionError):
			submit_invoice(invoice=json.dumps(payload), data="{}")
		frappe.set_user("Administrator")
		self.assertFalse(frappe.db.exists("Offline Invoice Sync", {"offline_id": payload["offline_id"]}))

	def test_submit_invoice_rejects_missing_profile_for_cashier(self) -> None:
		from pos_next.api.invoices import _check_submit_pos_profile_access

		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			_check_submit_pos_profile_access(None)
		_check_submit_pos_profile_access(PROFILE)  # listed on the profile: no error

	def test_offline_submit_rejects_user_not_on_pos_profile(self) -> None:
		payload = _payload()
		frappe.set_user(self.outsider)
		with self.assertRaises(frappe.PermissionError):
			sync.submit_offline_invoice(json.dumps(payload), None)

	def test_retry_rejects_user_not_on_pos_profile(self) -> None:
		payload = _payload(customer=_ensure_customer(disabled=1))
		sync.submit_offline_invoice(json.dumps(payload), None)
		frappe.set_user(self.outsider)
		with self.assertRaises(frappe.PermissionError):
			sync.retry_failed([payload["offline_id"]])

	def test_register_device_rejects_user_not_on_pos_profile(self) -> None:
		frappe.set_user(self.outsider)
		with self.assertRaises(frappe.PermissionError):
			sync.register_device(_device_id(), "Till X", PROFILE)

	def test_sync_status_hides_other_profiles(self) -> None:
		payload = _payload(customer=_ensure_customer(disabled=1))
		device = _device_id()
		sync.submit_offline_invoice(json.dumps(payload), device)
		frappe.set_user(self.outsider)
		self.assertEqual(sync.get_sync_status(device), {"rows": [], "failed_count": 0})

	def test_guest_cannot_call_sync_endpoints(self) -> None:
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			sync.get_sync_status(None)
