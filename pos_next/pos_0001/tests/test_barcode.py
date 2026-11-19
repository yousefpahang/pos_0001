# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""F5 tests: scale barcode vectors, rules per profile, server resolution, re-validation on sync.

Needs the demo data from pos_next/pos_0001/demo/seed.py (POS Profile "Main Till",
weighed item PLU-12345 with Scale PLU 12345, rules "Scale Weight 20" and "Scale Price 22").
"""

from __future__ import annotations

import json
import uuid

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt

from pos_next.pos_0001 import scale_barcode as sb
from pos_next.pos_0001.api import barcode, sync
from pos_next.pos_0001.demo.seed import ensure_scale_barcodes
from pos_next.pos_0001.tests.test_sync import CASHIER, PROFILE, _ensure_outsider

COMPANY = "Demo Trading LLC"
PLU_ITEM = "PLU-12345"
NOS_ITEM = "POS0001 Scale Nos Item"
BOX_ITEM = "POS0001 Box Barcode Item"

RULE_A = {
	"name": "A",
	"prefix": "20",
	"total_length": 13,
	"item_code_start": 3,
	"item_code_length": 5,
	"item_match": "Scale PLU",
	"value_type": "Weight",
	"value_start": 8,
	"value_length": 5,
	"decimals": 3,
	"uom": "Kg",
	"check_digit_mode": "Validate",
	"priority": 10,
}
RULE_B = {**RULE_A, "name": "B", "prefix": "22", "value_type": "Price", "decimals": 2}

# SPEC F5 test vectors.
VECTORS = [
	("2012345012509", "A", "Weight", 1.25),
	("2012345007505", "A", "Weight", 0.75),
	("2212345025008", "B", "Price", 25.00),
	("2212345009992", "B", "Price", 9.99),
]
BAD_CHECK_DIGIT = "2012345012508"


KG_RATE = 12.0


def _ensure_kg_price() -> None:
	"""ERPNext's before_tests hook deletes every Item Price, so tests bring their own."""
	filters = {"item_code": PLU_ITEM, "price_list": "Standard Selling", "uom": "Kg"}
	name = frappe.db.get_value("Item Price", filters)
	if name:
		frappe.db.set_value("Item Price", name, "price_list_rate", KG_RATE)
	else:
		frappe.get_doc({"doctype": "Item Price", **filters, "price_list_rate": KG_RATE}).insert(
			ignore_permissions=True
		)


def _ensure_item(code: str, stock_uom: str, **extra) -> str:
	if not frappe.db.exists("Item", code):
		frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": code,
				"item_name": code,
				"item_group": "All Item Groups",
				"stock_uom": stock_uom,
				"is_stock_item": 0,
				"is_sales_item": 1,
				**extra,
			}
		).insert(ignore_permissions=True)
	return code


class TestScaleBarcodeLogic(FrappeTestCase):
	"""Pure logic: same vectors as plus/core/scaleBarcode.test.js."""

	def test_vectors(self) -> None:
		for code, rule, value_type, value in VECTORS:
			parsed = sb.parse_scale_barcode(code, [RULE_A, RULE_B])
			self.assertTrue(parsed.ok, code)
			self.assertEqual(parsed.rule.name, rule)
			self.assertEqual(parsed.value_type, value_type)
			self.assertEqual(parsed.plu, "12345")
			self.assertAlmostEqual(parsed.value, value, places=6)

	def test_wrong_check_digit(self) -> None:
		parsed = sb.parse_scale_barcode(BAD_CHECK_DIGIT, [RULE_A, RULE_B])
		self.assertFalse(parsed.ok)
		self.assertEqual(parsed.error, "check_digit")
		ignored = sb.parse_scale_barcode(BAD_CHECK_DIGIT, [{**RULE_A, "check_digit_mode": "Ignore"}])
		self.assertTrue(ignored.ok)
		self.assertEqual(ignored.value, 1.25)

	def test_check_digits(self) -> None:
		self.assertEqual(sb.gs1_check_digit("400638133393"), 1)
		self.assertTrue(sb.has_valid_check_digit("036000291452"))
		self.assertFalse(sb.has_valid_check_digit("2012345012508"))

	def test_price_line_keeps_printed_amount(self) -> None:
		bad = []
		for price in (0.5, 1, 9.99, 25, 33.33, 99.99, 123.45, 999.99):
			for rate in (0.99, 3.5, 7.25, 12, 18.75, 39.99, 120):
				line = sb.price_line(price, rate)
				if not line["exact"] or sb.round_to(line["qty"] * line["rate"], 2) != price:
					bad.append((price, rate, line))
		self.assertEqual(bad, [])
		self.assertEqual(sb.price_line(9.99, 12), {"qty": 0.833, "rate": 11.99, "amount": 9.99, "exact": True})
		self.assertIsNone(sb.price_line(10, 0))

	def test_generate_round_trip(self) -> None:
		for code, rule, _type, value in VECTORS:
			self.assertEqual(sb.generate_scale_barcode(RULE_A if rule == "A" else RULE_B, "12345", value), code)
		self.assertRaises(ValueError, sb.generate_scale_barcode, RULE_A, "123456", 1)
		self.assertRaises(ValueError, sb.generate_scale_barcode, RULE_A, "12345", 100)

	def test_invalid_layouts(self) -> None:
		self.assertIn("overlap_prefix_item_code", sb.rule_errors(sb.ScaleRule.from_dict({**RULE_A, "item_code_start": 2})))
		self.assertIn("value_past_check_digit", sb.rule_errors(sb.ScaleRule.from_dict({**RULE_A, "value_start": 10})))
		self.assertIn("prefix", sb.rule_errors(sb.ScaleRule.from_dict({**RULE_A, "prefix": "2a"})))
		self.assertEqual(sb.rule_errors(sb.ScaleRule.from_dict(RULE_A)), [])


class TestScaleBarcodeServer(FrappeTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		frappe.set_user("Administrator")
		ensure_scale_barcodes()
		_ensure_item(NOS_ITEM, "Nos", scale_plu="99001")
		frappe.db.set_value("Item", NOS_ITEM, "scale_plu", "99001")
		if not frappe.db.exists("Item", BOX_ITEM):
			_ensure_item(
				BOX_ITEM,
				"Nos",
				uoms=[{"uom": "Nos", "conversion_factor": 1}, {"uom": "Box", "conversion_factor": 12}],
				barcodes=[{"barcode": "6299990000014"}, {"barcode": "6299990000021", "uom": "Box"}],
			)
		_ensure_kg_price()
		cls.kg_rate = KG_RATE

	def setUp(self) -> None:
		frappe.set_user("Administrator")

	def tearDown(self) -> None:
		frappe.set_user("Administrator")

	def test_vectors_resolve_on_server(self) -> None:
		frappe.set_user(CASHIER)
		for code, _rule, value_type, value in VECTORS:
			result = barcode.resolve_scale_barcode(code, PROFILE)
			self.assertEqual(result["item_code"], PLU_ITEM)
			self.assertEqual(result["uom"], "Kg")
			if value_type == "Weight":
				self.assertEqual(result["qty"], value)
				self.assertEqual(result["amount"], sb.round_to(value * self.kg_rate, 2))
			else:
				self.assertEqual(result["amount"], value)
				self.assertEqual(sb.round_to(result["qty"] * result["rate"], 2), value)

	def test_wrong_check_digit_is_rejected(self) -> None:
		with self.assertRaises(barcode.ScaleBarcodeError) as ctx:
			barcode.resolve_scale_barcode(BAD_CHECK_DIGIT, PROFILE)
		self.assertIn("check digit", str(ctx.exception))

	def test_item_not_sold_in_kg_is_named(self) -> None:
		code = sb.generate_scale_barcode(RULE_A, "99001", 0.5)
		with self.assertRaises(barcode.ScaleBarcodeError) as ctx:
			barcode.resolve_scale_barcode(code, PROFILE)
		self.assertIn(NOS_ITEM, str(ctx.exception))

	def test_rules_limited_to_profiles(self) -> None:
		name = "POS0001 Test Express Only"
		if not frappe.db.exists("POS Scale Barcode Rule", name):
			frappe.get_doc(
				{
					"doctype": "POS Scale Barcode Rule",
					"rule_name": name,
					"company": COMPANY,
					**{k: v for k, v in RULE_A.items() if k not in ("name",)},
					"prefix": "27",
					"pos_profiles": [{"pos_profile": "Express Till"}],
				}
			).insert(ignore_permissions=True)
		main = [r["name"] for r in barcode.get_scale_rules(PROFILE)]
		express = [r["name"] for r in barcode.get_scale_rules("Express Till")]
		self.assertNotIn(name, main)
		self.assertIn(name, express)
		self.assertIn("Scale Weight 20", main)
		self.assertIn("Scale Weight 20", express)

	def test_rule_layout_is_validated(self) -> None:
		doc = frappe.get_doc(
			{
				"doctype": "POS Scale Barcode Rule",
				"rule_name": f"bad-{uuid.uuid4().hex[:6]}",
				"company": COMPANY,
				**{k: v for k, v in RULE_A.items() if k != "name"},
				"item_code_start": 2,
			}
		)
		self.assertRaises(frappe.ValidationError, doc.insert)

	def test_scan_cache(self) -> None:
		frappe.set_user(CASHIER)
		cache = barcode.get_scan_cache(PROFILE)
		self.assertEqual(cache["plu_map"].get("12345"), PLU_ITEM)
		self.assertEqual({r["name"] for r in cache["rules"]} >= {"Scale Weight 20", "Scale Price 22"}, True)
		self.assertEqual(cache["uom_barcodes"]["6299990000021"], {"item_code": BOX_ITEM, "uom": "Box"})
		self.assertEqual(cache["uom_barcodes"]["6299990000014"], {"item_code": BOX_ITEM, "uom": "Nos"})
		self.assertGreaterEqual(cache["refresh_minutes"], 1)

	def test_access_checks(self) -> None:
		frappe.set_user(_ensure_outsider())
		for call in (
			lambda: barcode.get_scale_rules(PROFILE),
			lambda: barcode.get_scan_cache(PROFILE),
			lambda: barcode.resolve_scale_barcode(VECTORS[0][0], PROFILE),
		):
			self.assertRaises(frappe.PermissionError, call)
		frappe.set_user("Guest")
		self.assertRaises(frappe.PermissionError, barcode.generate_scale_barcode, "Scale Weight 20", PLU_ITEM, 1)

	def test_generate_scale_barcode_endpoint(self) -> None:
		frappe.set_user(CASHIER)
		self.assertEqual(barcode.generate_scale_barcode("Scale Weight 20", PLU_ITEM, 1.25), "2012345012509")
		self.assertEqual(barcode.generate_scale_barcode("Scale Price 22", PLU_ITEM, 9.99), "2212345009992")
		self.assertRaises(frappe.ValidationError, barcode.generate_scale_barcode, "Scale Weight 20", BOX_ITEM, 1)


def _scale_payload(lines: list[dict]) -> dict:
	"""Invoice shaped like the browser queue's, with scale lines."""
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
		"items": [
			{
				"item_code": line["item_code"],
				"qty": line["qty"],
				"rate": line["rate"],
				"price_list_rate": line["rate"],
				"uom": line["uom"],
				"conversion_factor": line.get("conversion_factor", 1),
				"warehouse": profile.warehouse,
				"pos0001_scale_barcode": line["barcode"],
			}
			for line in lines
		],
		"offline_id": f"pos_offline_{uuid.uuid4()}",
	}
	draft = frappe.get_doc(json.loads(json.dumps(invoice)))
	draft.set_missing_values()
	draft.calculate_taxes_and_totals()
	total = flt(draft.rounded_total or draft.grand_total)
	invoice["payments"] = [{"mode_of_payment": "Cash", "amount": total}]
	invoice["grand_total"] = total
	return invoice


class TestScaleLinesOnSync(FrappeTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		frappe.set_user("Administrator")
		ensure_scale_barcodes()
		_ensure_kg_price()

	def setUp(self) -> None:
		frappe.set_user(CASHIER)

	def tearDown(self) -> None:
		frappe.set_user("Administrator")

	def test_scale_lines_sync_with_printed_amount(self) -> None:
		weight = barcode.resolve(VECTORS[0][0], PROFILE)
		price = barcode.resolve(VECTORS[3][0], PROFILE)
		# The same label twice gives two lines.
		lines = [weight, weight, price]
		payload = _scale_payload(lines)
		result = sync.submit_offline_invoice(json.dumps(payload), None)
		self.assertEqual(result["status"], "Synced", result)
		invoice = frappe.get_doc("Sales Invoice", result["invoice_name"])
		self.assertEqual(len(invoice.items), 3)
		self.assertEqual([r.qty for r in invoice.items[:2]], [1.25, 1.25])
		self.assertEqual(invoice.items[2].amount, 9.99)
		self.assertEqual(invoice.items[2].qty, price["qty"])
		self.assertEqual(invoice.items[2].pos0001_scale_barcode, VECTORS[3][0])

	def test_tampered_weight_is_stored_as_failed(self) -> None:
		line = {**barcode.resolve(VECTORS[1][0], PROFILE), "qty": 2}
		payload = _scale_payload([line])
		result = sync.submit_offline_invoice(json.dumps(payload), None)
		self.assertEqual(result["status"], "Failed", result)
		self.assertTrue(result["stored"])
		self.assertIn(VECTORS[1][0], result["error"])

	def test_tampered_price_is_rejected(self) -> None:
		line = {**barcode.resolve(VECTORS[2][0], PROFILE)}
		line["rate"] = sb.round_to(line["rate"] + 1, 2)
		result = sync.submit_offline_invoice(json.dumps(_scale_payload([line])), None)
		self.assertEqual(result["status"], "Failed", result)
		self.assertIn("25.0", result["error"])

	def test_wrong_item_for_label_is_rejected(self) -> None:
		line = {**barcode.resolve(VECTORS[0][0], PROFILE), "item_code": "PLU-12346"}
		result = sync.submit_offline_invoice(json.dumps(_scale_payload([line])), None)
		self.assertEqual(result["status"], "Failed", result)
		self.assertIn("PLU-12345", result["error"])
