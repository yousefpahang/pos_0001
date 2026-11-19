# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""F13 tests: Item Wizard price logic (shared vectors with Vitest), Create per preset (records
match the SPEC F13 list), rollback on error, duplicate barcodes, edit packaging (never deletes),
CSV import and access.

Needs the demo data from pos_next/pos_0001/demo/seed.py (POS Profile "Main Till", warehouse
"Stores - DTL", VAT 5% exclusive, item group "Groceries", cashier@pos.test).
"""

from __future__ import annotations

import json
import os
from unittest.mock import patch

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import add_days, flt, nowdate

from pos_next.pos_0001 import item_wizard as wiz
from pos_next.pos_0001.api import items as api
from pos_next.pos_0001.install import default_item_wizard_presets, ensure_item_wizard_setup
from pos_next.pos_0001.scale_barcode import has_valid_check_digit
from pos_next.pos_0001.tests.test_sync import CASHIER, PROFILE, _ensure_outsider

VECTORS = os.path.join(os.path.dirname(__file__), "item_wizard_vectors.json")
WAREHOUSE = "Stores - DTL"
GROUP = "Groceries"
WIZARD_USER = "pos0001-wizard@pos.test"
NEW_UOM = "POS0001 Test Sack"


def _ensure_wizard_user() -> str:
	"""A manager with the wizard role but not on any POS Profile user list."""
	if not frappe.db.exists("User", WIZARD_USER):
		frappe.get_doc(
			{
				"doctype": "User",
				"email": WIZARD_USER,
				"first_name": "Wizard",
				"send_welcome_email": 0,
				"roles": [{"role": "POS Item Wizard"}, {"role": "Stock User"}],
			}
		).insert(ignore_permissions=True)
	return WIZARD_USER


def _barcodes(n: int) -> list[str]:
	out: list[str] = []
	for _i in range(n):
		out.append(wiz.generate_internal_barcode(out))
	return out


def _preset_payload(name: str, **extra) -> dict:
	"""Wizard payload from a shipped preset with prices, barcodes and opening stock filled in."""
	preset = frappe.get_doc("POS Item Wizard Preset", name).as_dict()
	payload = wiz.preset_payload(preset)
	codes = _barcodes(len(payload["selling_units"]))
	for unit, code in zip(payload["selling_units"], codes, strict=True):
		unit["barcode"] = code
	payload.update(
		{
			"pos_profile": PROFILE,
			"item_name": f"Wizard {frappe.generate_hash(length=6)}",
			"item_name_ar": "صنف تجريبي",
			"item_group": GROUP,
			"buying_price": 75,
			"base_price": 4.5,
			"opening_stock": {"qty": 2, "warehouse": WAREHOUSE},
		}
	)
	payload.update(extra)
	return payload


def rice_payload(**extra) -> dict:
	"""SPEC F13 worked example: bought in 25 kg bags at AED 75, sold by the Kg at 4.50, a 500 g
	pack at 2.50 and the whole bag at 99.00 (all incl. VAT), 4 bags opening stock."""
	codes = _barcodes(3)
	payload = {
		"pos_profile": PROFILE,
		"preset": "Bulk by weight (sack/bag → kg)",
		"item_name": f"Basmati Rice {frappe.generate_hash(length=6)}",
		"item_name_ar": "أرز بسمتي",
		"item_group": GROUP,
		"stock_uom": "Kg",
		"buying_units": [{"uom": "Bag", "size": 25, "parent_uom": "Kg"}],
		"buying_price": 75,
		"selling_units": [
			{"uom": "Kg", "size": 1, "size_uom": "Kg", "barcode": codes[0]},
			{"uom": "Pack", "size": 500, "size_uom": "Gram", "price": 2.5, "barcode": codes[1]},
			{"uom": "Bag", "size": 1, "size_uom": "Bag", "price": 99, "barcode": codes[2]},
		],
		"sold_on_scale": 1,
		"base_price": 4.5,
		"prices_include_vat": 1,
		"item_tax_template": "UAE VAT 5% - DTL",
		"opening_stock": {"qty": 4, "uom": "Bag", "warehouse": WAREHOUSE, "cost": 75},
	}
	payload.update(extra)
	return payload


class TestWizardLogic(FrappeTestCase):
	def test_vectors_match_the_browser(self) -> None:
		with open(VECTORS, encoding="utf-8") as handle:
			vectors = json.load(handle)
		self.assertGreaterEqual(len(vectors), 6)
		for v in vectors:
			p = wiz.normalize(v["payload"])
			out = wiz.unit_prices(p, v["vat_rate"], v["profile_inclusive"])
			e = v["expected"]
			for key in ("factors", "purchase_uom", "cost_per_stock_uom", "base_price", "units", "opening_stock_qty", "warnings", "errors"):
				self.assertEqual(out[key], e[key], f"{v['name']}: {key}")
			self.assertEqual(wiz.payload_errors(p), e["payload_errors"], v["name"])

	def test_rice_example_numbers(self) -> None:
		p = wiz.normalize(rice_payload())
		out = wiz.unit_prices(p, 5, 0)
		units = {u["uom"]: u for u in out["units"]}
		self.assertEqual(out["cost_per_stock_uom"], 3.0)
		self.assertEqual(units["Kg"]["margin_pct"], 50.0)
		self.assertEqual(units["Pack"]["calculated"], 2.25)
		self.assertEqual(units["Bag"]["calculated"], 112.5)
		self.assertEqual([units[u]["shelf_price"] for u in ("Kg", "Pack", "Bag")], [4.5, 2.5, 99.0])
		self.assertNotIn("Gram", units)
		self.assertEqual(out["opening_stock_qty"], 100.0)

	def test_error_messages_are_plain_words(self) -> None:
		for code in ("barcode_in_use", "unknown_unit", "below_cost", "entry_unit_not_sold", "plu_in_use"):
			message = wiz.error_message({"code": code, "uom": "Bag", "barcode": "1", "item_code": "X", "value": "1"})
			self.assertNotEqual(message, code)


class TestWizardCreate(FrappeTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		ensure_item_wizard_setup()
		frappe.set_user("Administrator")

	def tearDown(self) -> None:
		frappe.set_user("Administrator")

	def _check_records(self, payload: dict, out: dict) -> frappe.model.document.Document:
		"""Records listed in SPEC F13 "What Create writes"."""
		p = wiz.normalize(payload)
		ctx = wiz.profile_context(PROFILE)
		calc = wiz.compute(p, ctx)
		item = frappe.get_doc("Item", out["item_code"])
		self.assertEqual(item.stock_uom, p["stock_uom"])
		self.assertEqual(item.item_name_ar, p["item_name_ar"])
		self.assertEqual(item.is_stock_item, 1)
		self.assertEqual(item.purchase_uom or item.stock_uom, calc["purchase_uom"])
		live = [u["uom"] for u in p["selling_units"]]
		self.assertEqual(item.sales_uom or item.stock_uom, live[0])
		conversions = {r.uom: flt(r.conversion_factor) for r in item.uoms}
		for uom in set(live) | {u["uom"] for u in p["buying_units"]}:
			self.assertAlmostEqual(conversions[uom], calc["factors"][uom], places=9)
		entry = wiz.ENTRY_UNITS.get(item.stock_uom)
		if entry:
			self.assertNotIn(entry["uom"], conversions, "entry units get no conversion row")
		self.assertEqual(
			{(r.barcode, r.uom) for r in item.barcodes},
			{(u["barcode"], u["uom"]) for u in p["selling_units"] if u["barcode"]},
		)
		if p["item_tax_template"]:
			self.assertEqual([t.item_tax_template for t in item.taxes], [p["item_tax_template"]])
		defaults = item.item_defaults[0]
		self.assertEqual(defaults.company, ctx.company)
		self.assertEqual(defaults.default_warehouse, p["opening_stock"]["warehouse"] or ctx.warehouse)
		prices = {
			r.uom: flt(r.price_list_rate)
			for r in frappe.get_all(
				"Item Price",
				filters={"item_code": item.name, "price_list": ctx.selling_price_list},
				fields=["uom", "price_list_rate"],
			)
		}
		self.assertEqual(prices, {u["uom"]: u["list_rate"] for u in calc["units"] if u["priced"]})
		if entry:
			self.assertNotIn(entry["uom"], prices)
		buying = frappe.get_all(
			"Item Price",
			filters={"item_code": item.name, "price_list": ctx.buying_price_list},
			fields=["uom", "price_list_rate"],
		)
		self.assertEqual([(b.uom, flt(b.price_list_rate)) for b in buying], [(calc["purchase_uom"], flt(p["buying_price"]))])
		for uom in conversions:
			whole = frappe.db.get_value("UOM", uom, "must_be_whole_number")
			if uom in ("Kg", "Gram", "Litre", "Millilitre"):
				self.assertEqual(whole, 0, uom)
		if p["opening_stock"]["qty"]:
			sle = frappe.get_all(
				"Stock Ledger Entry",
				filters={"item_code": item.name, "is_cancelled": 0},
				fields=["actual_qty", "warehouse", "voucher_type"],
			)
			self.assertEqual(len(sle), 1)
			self.assertEqual(sle[0].voucher_type, "Stock Entry")
			self.assertAlmostEqual(flt(sle[0].actual_qty), calc["opening_stock_qty"], places=6)
			self.assertEqual(sle[0].warehouse, p["opening_stock"]["warehouse"])
		return item

	def test_four_default_presets_are_installed(self) -> None:
		names = [p["preset_name"] for p in default_item_wizard_presets()]
		self.assertEqual(len(names), 4)
		for name in names:
			doc = frappe.get_doc("POS Item Wizard Preset", name)
			self.assertEqual(doc.is_standard, 1)
			self.assertEqual(wiz.preset_errors(doc.as_dict()), [])
		for uom in ("Bag", "Pack", "Carton", "Drum", "Can"):
			self.assertEqual(frappe.db.get_value("UOM", uom, "must_be_whole_number"), 1, uom)

	def test_create_rice_example(self) -> None:
		payload = rice_payload()
		out = api.wizard_create(json.dumps(payload))
		item = self._check_records(payload, out)
		created = {c["doctype"] for c in out["created"]}
		self.assertTrue({"Item", "Item Barcode", "Item Price", "Stock Entry"} <= created)
		self.assertEqual(item.purchase_uom, "Bag")
		self.assertTrue(item.scale_plu, "sold on the scale gets a PLU")
		self.assertEqual(
			int(frappe.db.get_single_value("POS 0001 Settings", "next_scale_plu")), int(item.scale_plu) + 1
		)
		rates = {
			r.uom: flt(r.price_list_rate)
			for r in frappe.get_all("Item Price", filters={"item_code": item.name, "price_list": "Standard Selling"}, fields=["uom", "price_list_rate"])
		}
		self.assertEqual(rates, {"Kg": 4.29, "Pack": 2.38, "Bag": 94.29})
		se = frappe.get_doc("Stock Entry", next(c["name"] for c in out["created"] if c["doctype"] == "Stock Entry"))
		self.assertEqual(se.docstatus, 1)
		self.assertEqual(se.purpose, "Material Receipt")
		self.assertAlmostEqual(flt(se.items[0].transfer_qty), 100.0)
		self.assertAlmostEqual(flt(se.items[0].basic_rate), 3.0)

	def test_create_each_preset(self) -> None:
		for preset in default_item_wizard_presets():
			name = preset["preset_name"]
			with self.subTest(preset=name):
				extra = {}
				if preset["stock_uom"] == "Nos":
					extra["base_price"] = 1.5
					extra["buying_price"] = 24
				payload = _preset_payload(name, **extra)
				validation = api.wizard_validate(json.dumps(payload))
				self.assertEqual(validation["errors"], [], name)
				out = api.wizard_create(json.dumps(payload))
				item = self._check_records(payload, out)
				self.assertEqual(bool(item.scale_plu), bool(preset["sold_on_scale"]))
				if name.startswith("Pre-packed"):
					conv = {r.uom: flt(r.conversion_factor) for r in item.uoms}
					self.assertEqual((conv["Pack"], conv["Carton"]), (0.5, 6.0))
					self.assertEqual(item.purchase_uom, "Carton")

	def test_rollback_on_any_error(self) -> None:
		payload = rice_payload(buying_units=[{"uom": NEW_UOM, "size": 25}], opening_stock={"qty": 1, "uom": NEW_UOM, "warehouse": WAREHOUSE})
		payload["selling_units"][2] = {"uom": NEW_UOM, "size": 1, "size_uom": NEW_UOM, "price": 99, "barcode": payload["selling_units"][2]["barcode"]}
		item_code = wiz.suggest_item_code(GROUP)
		payload["item_code"] = item_code
		before = {dt: frappe.db.count(dt) for dt in ("Item Price", "Stock Entry", "Stock Ledger Entry", "GL Entry")}
		self.assertFalse(frappe.db.exists("UOM", NEW_UOM))
		with patch.object(wiz, "_bump_counters", side_effect=frappe.ValidationError("boom")):
			with self.assertRaises(frappe.ValidationError):
				api.wizard_create(json.dumps(payload))
		self.assertFalse(frappe.db.exists("Item", item_code))
		self.assertFalse(frappe.db.exists("UOM", NEW_UOM))
		self.assertFalse(frappe.db.exists("Item Barcode", {"barcode": payload["selling_units"][0]["barcode"]}))
		self.assertEqual({dt: frappe.db.count(dt) for dt in before}, before)
		# The same payload goes through once the cause is gone.
		out = api.wizard_create(json.dumps(payload))
		self.assertEqual(out["item_code"], item_code)
		self.assertEqual(frappe.db.get_value("UOM", NEW_UOM, "must_be_whole_number"), 1)

	def test_bad_warehouse_rolls_back_after_item_insert(self) -> None:
		payload = rice_payload()
		payload["item_code"] = wiz.suggest_item_code(GROUP)
		with patch.object(wiz, "_opening_stock", side_effect=frappe.ValidationError("stock failed")):
			with self.assertRaises(frappe.ValidationError):
				wiz.create(payload)
		self.assertFalse(frappe.db.exists("Item", payload["item_code"]))
		self.assertFalse(frappe.db.exists("Item Price", {"item_code": payload["item_code"]}))

	def test_duplicate_barcode_is_blocked_with_item_name(self) -> None:
		first = rice_payload()
		out = api.wizard_create(json.dumps(first))
		second = rice_payload()
		taken = first["selling_units"][1]["barcode"]
		second["selling_units"][1]["barcode"] = taken
		result = api.wizard_validate(json.dumps(second), steps=json.dumps(["barcodes"]))
		self.assertEqual(len(result["errors"]), 1)
		self.assertEqual(result["errors"][0]["code"], "barcode_in_use")
		self.assertEqual(result["errors"][0]["item_code"], out["item_code"])
		self.assertIn(out["item_code"], result["errors"][0]["message"])
		with self.assertRaises(frappe.ValidationError):
			api.wizard_create(json.dumps(second))
		self.assertFalse(frappe.db.exists("Item", {"item_name": second["item_name"]}))
		# Repeated inside one payload, and an existing item code / PLU.
		third = rice_payload(item_code=out["item_code"], scale_plu=frappe.db.get_value("Item", out["item_code"], "scale_plu"))
		third["selling_units"][2]["barcode"] = third["selling_units"][0]["barcode"]
		codes = {e["code"] for e in api.wizard_validate(json.dumps(third))["errors"]}
		self.assertTrue({"barcode_repeated", "item_exists", "plu_in_use"} <= codes, codes)

	def test_preview_and_step_validation(self) -> None:
		payload = rice_payload(base_price=2.0)
		preview = api.wizard_preview(json.dumps(payload))
		self.assertEqual([u["uom"] for u in preview["units"]], ["Kg", "Pack", "Bag"])
		self.assertEqual(preview["vat_rate"], 5.0)
		self.assertIn("below_cost", {w["code"] for w in preview["warnings"]})
		self.assertTrue(all(w["message"] for w in preview["warnings"]))
		basics = api.wizard_validate(json.dumps({**payload, "item_name": ""}), steps=json.dumps(["basics"]))
		self.assertEqual([e["field"] for e in basics["errors"]], ["item_name"])

	def test_generated_barcodes_and_codes(self) -> None:
		first = api.generate_internal_barcode(PROFILE)["barcode"]
		second = api.generate_internal_barcode(PROFILE, exclude=json.dumps([first]))["barcode"]
		for code in (first, second):
			self.assertEqual(len(code), 13)
			self.assertTrue(code.startswith("29"))
			self.assertTrue(has_valid_check_digit(code))
		self.assertNotEqual(first, second)
		code = api.suggest_item_code(PROFILE, GROUP)["item_code"]
		self.assertTrue(code.startswith("GROC-"))
		self.assertFalse(frappe.db.exists("Item", code))

	def test_defaults(self) -> None:
		out = api.wizard_defaults(PROFILE, preset="Bulk by weight (sack/bag → kg)")
		self.assertEqual(out["profile"]["selling_price_list"], "Standard Selling")
		self.assertEqual(out["profile"]["buying_price_list"], "Standard Buying")
		self.assertEqual(out["default_item_tax_template"], "UAE VAT 5% - DTL")
		self.assertIn(WAREHOUSE, out["warehouses"])
		self.assertEqual(len([p for p in out["presets"] if p["is_standard"]]), 4)
		self.assertEqual(out["payload"]["stock_uom"], "Kg")
		self.assertTrue(out["next_scale_plu"].isdigit())
		self.assertEqual(out["entry_units"]["Kg"]["uom"], "Gram")

	def test_copy_from_existing_item(self) -> None:
		out = api.wizard_create(json.dumps(rice_payload()))
		copy = api.wizard_defaults(PROFILE, copy_from=out["item_code"])["payload"]
		self.assertEqual(copy["item_code"], "")
		self.assertEqual(copy["stock_uom"], "Kg")
		self.assertEqual({u["uom"]: u["price"] for u in copy["selling_units"]}, {"Kg": 4.5, "Pack": 2.5, "Bag": 99.0})
		self.assertTrue(all(not u["barcode"] for u in copy["selling_units"]))
		self.assertEqual(copy["buying_units"], [{"uom": "Bag", "size": 25.0, "parent_uom": "Kg"}])


class TestEditPackaging(FrappeTestCase):
	def test_add_change_and_remove_without_deleting(self) -> None:
		frappe.set_user("Administrator")
		out = api.wizard_create(json.dumps(rice_payload()))
		code = out["item_code"]
		before = frappe.get_doc("Item", code)
		edit = api.wizard_defaults(PROFILE, edit=code)["payload"]
		self.assertTrue(all(u.get("existing") for u in edit["selling_units"]))
		box_barcode = wiz.generate_internal_barcode()
		for unit in edit["selling_units"]:
			if unit["uom"] == "Kg":
				unit["price"] = 4.75
			if unit["uom"] == "Pack":
				unit["remove"] = 1
		edit["selling_units"].append({"uom": "Box", "size": 10, "size_uom": "Kg", "price": 44, "barcode": box_barcode})
		edit["pos_profile"] = PROFILE
		result = api.wizard_update_packaging(code, json.dumps(edit))
		actions = {(c["action"], c["doctype"]) for c in result["changes"]}
		self.assertIn(("added", "UOM Conversion Detail"), actions)
		self.assertIn(("added", "Item Barcode"), actions)
		self.assertIn(("disabled", "Item Barcode"), actions)
		self.assertIn(("ended", "Item Price"), actions)
		item = frappe.get_doc("Item", code)
		self.assertEqual(len(item.uoms), len(before.uoms) + 1, "nothing deleted, Box added")
		self.assertEqual(len(item.barcodes), len(before.barcodes) + 1)
		pack_barcode = next(r for r in item.barcodes if r.uom == "Pack")
		self.assertEqual(pack_barcode.pos0001_disabled, 1)
		pack_price = frappe.get_value("Item Price", {"item_code": code, "uom": "Pack", "price_list": "Standard Selling"}, ["valid_upto"])
		self.assertEqual(str(pack_price), str(add_days(nowdate(), -1)))
		rates = {
			r.uom: flt(r.price_list_rate)
			for r in frappe.get_all("Item Price", filters={"item_code": code, "price_list": "Standard Selling"}, fields=["uom", "price_list_rate"])
		}
		self.assertEqual(rates["Kg"], 4.52)  # 4.75 incl. VAT
		self.assertEqual(rates["Box"], 41.9)  # 44.00 incl. VAT
		self.assertEqual(rates["Pack"], 2.38, "the ended price is kept")
		# The edit payload no longer lists the removed unit; adding it back enables it again.
		again = api.wizard_defaults(PROFILE, edit=code)["payload"]
		self.assertNotIn("Pack", [u["uom"] for u in again["selling_units"]])


class TestCsvImport(FrappeTestCase):
	def test_template_row_and_failures_per_row(self) -> None:
		frappe.set_user("Administrator")
		template = api.wizard_csv_template(PROFILE)
		lines = template["content"].strip().split("\n")
		self.assertEqual(lines[0].split(","), wiz.CSV_COLUMNS)
		taken = _barcodes(1)[0]
		frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": f"POS0001-CSV-{frappe.generate_hash(length=5)}",
				"item_name": "Barcode owner",
				"item_group": GROUP,
				"stock_uom": "Nos",
				"barcodes": [{"barcode": taken}],
			}
		).insert(ignore_permissions=True)
		bad = dict(wiz.CSV_EXAMPLE, item_name="Bad Rice", unit1_barcode=taken)
		missing = dict(wiz.CSV_EXAMPLE, item_name="", unit1_barcode="")
		import csv
		import io

		buf = io.StringIO()
		writer = csv.DictWriter(buf, fieldnames=wiz.CSV_COLUMNS, lineterminator="\n")
		writer.writeheader()
		for row in (wiz.CSV_EXAMPLE, bad, missing):
			writer.writerow({k: row.get(k, "") for k in wiz.CSV_COLUMNS})
		results = api.import_wizard_csv(PROFILE, content=buf.getvalue())
		self.assertEqual([r["status"] for r in results], ["Created", "Failed", "Failed"])
		self.assertEqual([r["row"] for r in results], [2, 3, 4])
		self.assertIn("already used by item", results[1]["errors"][0])
		self.assertIn("Item name", results[2]["errors"][0])
		item = frappe.get_doc("Item", results[0]["item_code"])
		self.assertEqual(item.item_name_ar, "أرز بسمتي")
		self.assertEqual({r.uom for r in item.barcodes}, {"Kg", "Pack", "Bag"})
		self.assertFalse(frappe.db.exists("Item", {"item_name": "Bad Rice"}))
		qty = frappe.db.get_value("Bin", {"item_code": item.name, "warehouse": WAREHOUSE}, "actual_qty")
		self.assertEqual(flt(qty), 100.0)


class TestWizardAccess(FrappeTestCase):
	def tearDown(self) -> None:
		frappe.set_user("Administrator")

	def test_cashier_without_role_is_refused(self) -> None:
		frappe.set_user(CASHIER)
		self.assertFalse(api.can_use_item_wizard()["allowed"])
		for call in (
			lambda: api.wizard_defaults(PROFILE),
			lambda: api.wizard_create(json.dumps(rice_payload())),
			lambda: api.wizard_preview(json.dumps(rice_payload())),
			lambda: api.generate_internal_barcode(PROFILE),
			lambda: api.import_wizard_csv(PROFILE, content="item_name\n"),
		):
			with self.assertRaises(frappe.PermissionError):
				call()

	def test_role_needs_profile_access(self) -> None:
		_ensure_outsider()
		user = _ensure_wizard_user()
		frappe.set_user(user)
		self.assertTrue(api.can_use_item_wizard()["allowed"])
		self.assertEqual(api.get_wizard_profiles(), [])
		with self.assertRaises(frappe.PermissionError):
			api.wizard_defaults(PROFILE)
		frappe.set_user("Administrator")
		profile = frappe.get_doc("POS Profile", PROFILE)
		profile.append("applicable_for_users", {"user": user})
		profile.save(ignore_permissions=True)
		frappe.set_user(user)
		self.assertEqual([p["name"] for p in api.get_wizard_profiles()], [PROFILE])
		self.assertEqual(api.wizard_defaults(PROFILE)["profile"]["name"], PROFILE)

	def test_guest_is_refused(self) -> None:
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			api.wizard_defaults(PROFILE)
