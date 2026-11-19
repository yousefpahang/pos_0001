# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Phase 7 (SPEC section 7): UAE tax invoice receipt, AED formatting, Arabic names, and the
e-invoicing hook point on the single invoice service function."""

from __future__ import annotations

import json
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase

from pos_next.pos_0001 import einvoice, uae
from pos_next.pos_0001.api import printing, sync
from pos_next.pos_0001.tests.test_sync import CASHIER, ITEM, PROFILE, _device_id, _payload

PRINT_FORMAT = "UAE Tax Invoice 80mm"
ARABIC_NAME = "مناديل فاخرة"
TEST_CUSTOMER_TRN = "100222333400003"
CALLS: list[str] = []


def record_call(doc) -> None:
	"""Test e-invoicing handler."""
	CALLS.append(doc.name)


def failing_handler(doc) -> None:
	frappe.db.set_value("Company", doc.company, "phone_no", "should-be-rolled-back")
	raise RuntimeError("e-invoicing service down")


def _hooks(*handlers: str):
	real = frappe.get_hooks

	def fake(hook=None, *args, **kwargs):
		if hook == einvoice.HOOK:
			return list(handlers)
		return real(hook, *args, **kwargs)

	return patch.object(frappe, "get_hooks", side_effect=fake)


def _render(doc) -> str:
	html = frappe.db.get_value("Print Format", PRINT_FORMAT, "html")
	return frappe.render_template(html, {"doc": doc})


def _draft(customer: str = "Walk-in Customer", **values):
	payload = _payload(customer)
	payload.pop("offline_id")
	doc = frappe.get_doc({**payload, **values})
	doc.set_missing_values()
	doc.calculate_taxes_and_totals()
	return doc


class UAETestCase(FrappeTestCase):
	def setUp(self) -> None:
		frappe.set_user("Administrator")
		self.saved = frappe.db.get_value(
			"POS Profile",
			PROFILE,
			["pos0001_invoice_title", "pos0001_receipt_footer", "pos0001_sales_person_mode"],
			as_dict=True,
		)
		self.saved_symbol = frappe.db.get_single_value("POS 0001 Settings", "currency_symbol")
		self.saved_name_ar = frappe.db.get_value("Item", ITEM, "item_name_ar")
		frappe.db.set_value("Item", ITEM, "item_name_ar", ARABIC_NAME)
		CALLS.clear()

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		frappe.db.set_value("POS Profile", PROFILE, dict(self.saved))
		frappe.db.set_single_value("POS 0001 Settings", "currency_symbol", self.saved_symbol or "By language")
		frappe.db.set_value("Item", ITEM, "item_name_ar", self.saved_name_ar)


class TestFormatting(FrappeTestCase):
	def test_aed_symbol_by_language_and_setting(self) -> None:
		self.assertEqual(uae.currency_symbol("AED", "en"), "AED")
		self.assertEqual(uae.currency_symbol("AED", "ar"), uae.AED_ARABIC)
		self.assertEqual(uae.currency_symbol("AED", "ar-AE", "By language"), uae.AED_ARABIC)
		self.assertEqual(uae.currency_symbol("AED", "ar", "AED"), "AED")
		self.assertEqual(uae.currency_symbol("AED", "en", uae.AED_ARABIC), uae.AED_ARABIC)
		self.assertEqual(uae.currency_symbol("USD", "ar"), "USD")

	def test_two_decimals_same_as_the_browser(self) -> None:
		# Same cases as POS/src/plus/core/money.test.js
		self.assertEqual(uae.amount2(12.5), "12.50")
		self.assertEqual(uae.amount2("9.999"), "10.00")
		self.assertEqual(uae.amount2(1.005), "1.01")
		self.assertEqual(uae.amount2(-2.345), "-2.35")
		self.assertEqual(uae.amount2(-0.001), "0.00")
		self.assertEqual(uae.format_money(12.5, "AED", "en"), "AED 12.50")
		self.assertEqual(uae.format_money(12.5, "AED", "ar"), f"12.50 {uae.AED_ARABIC}")

	def test_titles(self) -> None:
		self.assertEqual(uae.receipt_title(0, "", "Tax Invoice"), "Tax Invoice")
		self.assertEqual(uae.receipt_title(0, "", None), "Tax Invoice")
		self.assertEqual(uae.receipt_title(0, "", "Simplified Tax Invoice"), "Simplified Tax Invoice")
		self.assertEqual(uae.receipt_title(0, " ", "Auto"), "Simplified Tax Invoice")
		self.assertEqual(uae.receipt_title(0, TEST_CUSTOMER_TRN, "Auto"), "Tax Invoice")
		self.assertEqual(uae.receipt_title(1, TEST_CUSTOMER_TRN, "Tax Invoice"), "Tax Credit Note")

	def test_arabic_wording_from_the_csv(self) -> None:
		self.assertEqual(uae.bilingual("Tax Invoice")["ar"], "فاتورة ضريبية")
		self.assertEqual(uae.bilingual("Tax Credit Note")["ar"], "إشعار دائن ضريبي")
		self.assertEqual(uae.vat_label(5), {"en": "VAT 5%", "ar": "ضريبة القيمة المضافة 5%"})
		for text in uae.LABELS.values():
			self.assertNotEqual(uae.bilingual(text)["ar"], text, f"no Arabic for {text!r} in ar.csv")

	def test_line_vat_rates(self) -> None:
		tax = frappe._dict(charge_type="On Net Total", account_head="VAT - X", rate=5)
		doc = frappe._dict(
			taxes=[tax, frappe._dict(charge_type="Actual", account_head="Fee - X", rate=0)],
			items=[
				frappe._dict(item_tax_rate=""),
				frappe._dict(item_tax_rate=json.dumps({"VAT - X": 0})),
				frappe._dict(item_tax_rate="not json"),
			],
		)
		self.assertEqual(uae.line_vat_rates(doc), [5, 0, 5])
		self.assertEqual(uae.line_vat_rates(frappe._dict(taxes=[], items=[frappe._dict()])), [None])


class TestPrintFormat(UAETestCase):
	def test_installed_and_default(self) -> None:
		self.assertTrue(frappe.db.exists("Print Format", PRINT_FORMAT))
		pf = frappe.get_doc("Print Format", PRINT_FORMAT)
		self.assertEqual((pf.doc_type, pf.module, pf.print_format_type), ("Sales Invoice", "POS 0001", "Jinja"))
		self.assertEqual(printing.default_print_format(), PRINT_FORMAT)

	def test_tax_invoice(self) -> None:
		frappe.db.set_value("POS Profile", PROFILE, {"pos0001_invoice_title": "Tax Invoice", "pos0001_receipt_footer": ""})
		doc = _draft()
		html = _render(doc)
		company = printing.company_details(doc.company)
		for text in (
			"Tax Invoice",
			"فاتورة ضريبية",
			"TRN",
			"الرقم الضريبي",
			company["tax_id"],
			"Invoice No.",
			"Total excl. VAT",
			"VAT 5%",
			"ضريبة القيمة المضافة 5%",
			"Total incl. VAT",
			f"AED {uae.amount2(doc.rounded_total or doc.grand_total)}",
			f"AED {uae.amount2(doc.total_taxes_and_charges)}",
			ARABIC_NAME,
			"Cash",
			"شكراً لكم",
		):
			self.assertIn(text, html)
		self.assertNotIn("Simplified", html)
		self.assertNotIn("Customer TRN", html)

	def test_auto_title_customer_trn_and_arabic_symbol(self) -> None:
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_invoice_title", "Auto")
		frappe.db.set_single_value("POS 0001 Settings", "currency_symbol", uae.AED_ARABIC)
		walk_in = _render(_draft())
		self.assertIn("Simplified Tax Invoice", walk_in)
		self.assertIn("فاتورة ضريبية مبسطة", walk_in)
		doc = _draft(tax_id=TEST_CUSTOMER_TRN)
		html = _render(doc)
		self.assertNotIn("Simplified", html)
		self.assertIn("Customer TRN", html)
		self.assertIn(TEST_CUSTOMER_TRN, html)
		self.assertIn(f"{uae.amount2(doc.rounded_total or doc.grand_total)} {uae.AED_ARABIC}", html)

	def test_credit_note(self) -> None:
		doc = _draft(is_return=1, return_against="ACC-SINV-ORIGINAL-1")
		for item in doc.items:
			item.qty = -abs(item.qty)
		doc.calculate_taxes_and_totals()
		html = _render(doc)
		for text in ("Tax Credit Note", "إشعار دائن ضريبي", "Credit Note No.", "Original invoice",
			"الفاتورة الأصلية", "ACC-SINV-ORIGINAL-1"):
			self.assertIn(text, html)
		self.assertNotIn(">Tax Invoice<", html)

	def test_escapes_and_footer(self) -> None:
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_receipt_footer", "Line <b>1</b>\nشكراً")
		doc = _draft()
		doc.items[0].item_name = "Bad <script>x</script>"
		html = _render(doc)
		self.assertNotIn("<script>x", html)
		self.assertIn("Bad &lt;script&gt;", html)
		self.assertIn("Line &lt;b&gt;1&lt;/b&gt;<br>شكراً", html)

	def test_desk_print_of_a_submitted_invoice(self) -> None:
		result = sync.submit_offline_invoice(json.dumps(_payload()), _device_id())
		self.assertEqual(result["status"], "Synced", result)
		html = frappe.get_print("Sales Invoice", result["invoice_name"], print_format=PRINT_FORMAT)
		self.assertIn("فاتورة ضريبية", html)
		self.assertIn(result["invoice_name"], html)


class TestTillData(UAETestCase):
	def test_printing_cache_has_title_and_symbol(self) -> None:
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_invoice_title", "Auto")
		frappe.db.set_single_value("POS 0001 Settings", "currency_symbol", "AED")
		frappe.set_user(CASHIER)
		cache = printing.get_printing_cache(PROFILE)
		self.assertEqual(cache["invoice_title"], "Auto")
		self.assertEqual(cache["currency_symbol"], "AED")
		self.assertTrue(cache["print_format"])

	def test_receipt_data_has_line_vat_and_arabic_name(self) -> None:
		result = sync.submit_offline_invoice(json.dumps(_payload()), _device_id())
		data = printing.receipt_for(frappe.get_doc("Sales Invoice", result["invoice_name"]))
		self.assertEqual(data["items"][0]["item_name_ar"], ARABIC_NAME)
		self.assertEqual(data["items"][0]["vat_rate"], 5)
		self.assertTrue(any(t["rate"] == 5 for t in data["taxes"]))

	def test_item_cache_carries_the_arabic_name(self) -> None:
		from pos_next.api.items import get_items

		frappe.set_user(CASHIER)
		rows = get_items(PROFILE, search_term=ITEM, limit=5)
		rows = rows if isinstance(rows, list) else rows.get("items", [])
		row = next(r for r in rows if r["item_code"] == ITEM)
		self.assertEqual(row["item_name_ar"], ARABIC_NAME)


class TestEInvoicingHook(UAETestCase):
	def test_no_handler_is_a_no_op(self) -> None:
		with _hooks():
			self.assertEqual(einvoice.after_pos_invoice_submit(frappe._dict(name="X")), [])

	def test_every_submit_path_calls_the_hook_once(self) -> None:
		from pos_next.api.invoices import submit_invoice

		handler = "pos_next.pos_0001.tests.test_uae.record_call"
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_sales_person_mode", "Off")
		with _hooks(handler):
			online = _payload()
			online.pop("offline_id")
			frappe.set_user(CASHIER)
			live = submit_invoice(invoice=json.loads(json.dumps(online)), data={})
			frappe.set_user("Administrator")
			single = sync.submit_offline_invoice(json.dumps(_payload()), _device_id())
			batch = sync.submit_offline_invoices(json.dumps([_payload(), _payload()]), _device_id())
			# The same offline invoice again is a duplicate: no second invoice, no second call.
			again = sync.submit_offline_invoice(
				json.dumps({**_payload(), "offline_id": batch[0]["offline_id"]}), _device_id()
			)
		names = [live["name"], single["invoice_name"], batch[0]["invoice_name"], batch[1]["invoice_name"]]
		self.assertEqual(again["invoice_name"], batch[0]["invoice_name"])
		self.assertEqual(sorted(CALLS), sorted(names))

	def test_failing_handler_never_fails_the_sale(self) -> None:
		phone = frappe.db.get_value("Company", frappe.db.get_value("POS Profile", PROFILE, "company"), "phone_no")
		errors_before = frappe.db.count("Error Log")
		with _hooks("pos_next.pos_0001.tests.test_uae.failing_handler", "pos_next.pos_0001.tests.test_uae.record_call"):
			result = sync.submit_offline_invoice(json.dumps(_payload()), _device_id())
		self.assertEqual(result["status"], "Synced", result)
		self.assertEqual(frappe.db.get_value("Sales Invoice", result["invoice_name"], "docstatus"), 1)
		self.assertEqual(CALLS, [result["invoice_name"]])
		company = frappe.db.get_value("POS Profile", PROFILE, "company")
		self.assertEqual(frappe.db.get_value("Company", company, "phone_no"), phone)
		self.assertGreater(frappe.db.count("Error Log"), errors_before)
