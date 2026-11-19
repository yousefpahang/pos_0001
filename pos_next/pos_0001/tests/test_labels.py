# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""F4 tests: label rendering snapshots (shared with Vitest), POS Label Template, label rows,
documents, render endpoint and access.

Needs the demo data from pos_next/pos_0001/demo/seed.py (POS Profile "Main Till", user
cashier@pos.test, weighed item PLU-12345 with rules "Scale Weight 20" / "Scale Price 22").
"""

from __future__ import annotations

import base64
import io
import json
import os

import frappe
from frappe.tests.utils import FrappeTestCase

from pos_next.pos_0001 import labels
from pos_next.pos_0001.api import labels as api
from pos_next.pos_0001.install import default_label_templates, ensure_default_label_templates
from pos_next.pos_0001.tests.test_barcode import PLU_ITEM, _ensure_kg_price
from pos_next.pos_0001.tests.test_sync import CASHIER, PROFILE, _ensure_outsider

SNAPSHOTS = os.path.join(os.path.dirname(__file__), "label_snapshots.json")
ITEM = "POS0001 Label Item"
NOS_BARCODE = "6291111111110"
BOX_BARCODE = "6291111111127"
LABEL_ROLE = "POS0001 Test Label Printer"
SUPPLIER = "POS0001 Label Supplier"
TEMPLATE = "POS0001 Test Template"


class TestLabelSnapshots(FrappeTestCase):
	"""Same bytes as plus/core/labels.test.js (one file, both test suites)."""

	def test_snapshots_match_the_browser(self) -> None:
		with open(SNAPSHOTS, encoding="utf-8") as handle:
			data = json.load(handle)
		self.assertGreaterEqual(len(data["cases"]), 29)
		for case in data["cases"]:
			template = labels.Template.from_dict(case["template"])
			if case["kind"] == "pdf_html":
				out = labels.render_pdf_html(template, case["rows"], data["base"])
			else:
				out = labels.to_base64(labels.render_raw(template, case["rows"], data["base"], labels.fake_bitmap))
			self.assertEqual(out, case["output"], template.name)

	def test_default_templates_are_in_the_snapshot(self) -> None:
		with open(SNAPSHOTS, encoding="utf-8") as handle:
			names = {c["template"]["name"] for c in json.load(handle)["cases"]}
		for row in default_label_templates():
			self.assertIn(row["template_name"], names)

	def test_zpl_label_text(self) -> None:
		template = labels.Template.from_dict(
			next(t for t in default_label_templates() if t["template_name"] == "Shelf Label 38x25 (ZPL)")
		)
		row = {
			"item_code": "A1",
			"item_name": "Milk ^1",
			"barcode": "6290000000016",
			"barcode_type": "EAN13",
			"price_label": "AED 6.30",
			"qty": 3,
		}
		data = labels.render_raw(template, [row], {}, labels.fake_bitmap).decode()
		self.assertTrue(data.startswith("^XA\n^CI28\n^PW304\n^LL200\n"))
		self.assertIn("^FDMilk  1^FS", data)
		self.assertIn("^BEN,52,Y,N^FD629000000001^FS", data)
		self.assertIn("^PQ3\n^XZ\n", data)
		self.assertNotIn("^GFA", data)  # no Arabic name, no bitmap

	def test_template_subset(self) -> None:
		for bad in ("{{ item_name|upper }}", "{% for x in y %}{% endfor %}", "{{ nope }}", "{% if item_code %}"):
			with self.assertRaises(labels.LabelTemplateError):
				labels.validate_body(bad)
		labels.validate_body("{% if not weight %}{{ fit(item_name, 3) }}{% else %}{{ weight }}{% endif %}")

	def test_barcode_modules(self) -> None:
		from pos_next.pos_0001.barcodes import code128_modules, ean13_modules

		self.assertEqual(len(ean13_modules("4006381333931")), 95)
		with self.assertRaises(ValueError):
			ean13_modules("4006381333932")
		self.assertTrue(code128_modules("ITM-00001").startswith("11010010000"))
		self.assertTrue(code128_modules("ITM-00001").endswith("1100011101011"))

	def test_bitmap_commands(self) -> None:
		bmp = labels.Bitmap(10, 2, 2, bytes([0xFF, 0xC0, 0x00, 0x00]))
		self.assertEqual(labels.bitmap_command("ZPL", 3, 4, bmp), b"^FO3,4^GFA,4,4,2,FFC00000^FS")
		self.assertEqual(labels.bitmap_command("EPL", 3, 4, bmp), b"GW3,4,2,2," + bytes([0x00, 0x3F, 0xFF, 0xFF]))
		self.assertEqual(
			labels.bitmap_command("TSPL", 3, 4, bmp), b"BITMAP 3,4,2,2,0," + bytes([0x00, 0x3F, 0xFF, 0xFF])
		)

	def test_arabic_bitmap_with_pillow(self) -> None:
		from PIL import features

		if not features.check("raqm") or not labels.arabic_font():
			self.skipTest("Pillow without libraqm or no Arabic font on this server")
		bmp = labels.pillow_bitmap("حليب طازج", 24, 200)
		self.assertEqual(bmp.height, 24)
		self.assertLessEqual(bmp.width, 200)
		ink = sum(bin(b).count("1") for b in bmp.data)
		self.assertGreater(ink, 100)
		narrow = labels.pillow_bitmap("حليب طازج كامل الدسم", 24, 60)
		self.assertLessEqual(narrow.width, 60)


def _ensure_role(name: str) -> None:
	if not frappe.db.exists("Role", name):
		frappe.get_doc({"doctype": "Role", "role_name": name, "desk_access": 1}).insert(ignore_permissions=True)


def _set_cashier_role(present: bool) -> None:
	user = frappe.get_doc("User", CASHIER)
	has = any(r.role == LABEL_ROLE for r in user.roles)
	if present and not has:
		user.append("roles", {"role": LABEL_ROLE})
		user.save(ignore_permissions=True)
	elif not present and has:
		user.set("roles", [r for r in user.roles if r.role != LABEL_ROLE])
		user.save(ignore_permissions=True)
	frappe.clear_cache(user=CASHIER)


def _price(item: str, uom: str, rate: float, price_list: str) -> None:
	filters = {"item_code": item, "price_list": price_list, "uom": uom}
	name = frappe.db.get_value("Item Price", filters)
	if name:
		frappe.db.set_value("Item Price", name, "price_list_rate", rate)
	else:
		frappe.get_doc({"doctype": "Item Price", **filters, "price_list_rate": rate}).insert(ignore_permissions=True)


def _ensure_item(price_list: str) -> None:
	if not frappe.db.exists("UOM", "Box"):
		frappe.get_doc({"doctype": "UOM", "uom_name": "Box"}).insert(ignore_permissions=True)
	if not frappe.db.exists("Item", ITEM):
		frappe.get_doc(
			{
				"doctype": "Item",
				"item_code": ITEM,
				"item_name": "Label Test Milk",
				"item_name_ar": "حليب للاختبار",
				"item_group": "All Item Groups",
				"stock_uom": "Nos",
				"is_stock_item": 1,
				"is_sales_item": 1,
				"uoms": [{"uom": "Nos", "conversion_factor": 1}, {"uom": "Box", "conversion_factor": 12}],
				"barcodes": [
					{"barcode": NOS_BARCODE, "barcode_type": "EAN", "uom": "Nos"},
					{"barcode": BOX_BARCODE, "barcode_type": "EAN", "uom": "Box"},
				],
			}
		).insert(ignore_permissions=True)
	_price(ITEM, "Nos", 10.0, price_list)


class LabelTestCase(FrappeTestCase):
	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		frappe.set_user("Administrator")
		ensure_default_label_templates()
		_ensure_role(LABEL_ROLE)
		cls.profile = frappe.get_doc("POS Profile", PROFILE)
		_ensure_item(cls.profile.selling_price_list)
		_ensure_kg_price()

	def setUp(self) -> None:
		frappe.set_user("Administrator")
		self.saved_role = frappe.db.get_value("POS Profile", PROFILE, "pos0001_label_role")
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_label_role", LABEL_ROLE)
		_set_cashier_role(True)

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_label_role", self.saved_role)
		_set_cashier_role(False)


class TestLabelTemplate(LabelTestCase):
	def _template(self, **values):
		if frappe.db.exists("POS Label Template", TEMPLATE):
			frappe.delete_doc("POS Label Template", TEMPLATE, force=True, ignore_permissions=True)
		doc = frappe.get_doc(
			{
				"doctype": "POS Label Template",
				"template_name": TEMPLATE,
				"language": "TSPL",
				"width_mm": 40,
				"height_mm": 30,
				"body": 'CLS\nTEXT 1,1,"2",0,1,1,"{{ item_name }}"\nPRINT 1,{{ qty }}\n',
				**values,
			}
		)
		doc.insert(ignore_permissions=True)
		return doc

	def test_defaults_shipped(self) -> None:
		rows = {r.name: r for r in frappe.get_all("POS Label Template", fields=["name", "language", "width_mm"])}
		for name in ("Shelf Label 38x25 (ZPL)", "Product Label 50x30 (ZPL)", "A4 Sheet 3x8 (PDF)"):
			self.assertIn(name, rows)
		self.assertEqual(rows["A4 Sheet 3x8 (PDF)"].language, "PDF")

	def test_rejects_bad_bodies_and_sizes(self) -> None:
		with self.assertRaises(frappe.ValidationError):
			self._template(body="{{ item_name|upper }}")
		with self.assertRaises(frappe.ValidationError):
			self._template(width_mm=0)
		with self.assertRaises(frappe.ValidationError):
			self._template(language="PDF", a4_columns=3, a4_rows=8, width_mm=80, height_mm=37, body="x")
		self._template()

	def test_one_default_per_language(self) -> None:
		previous = frappe.get_all("POS Label Template", filters={"language": "TSPL", "is_default": 1}, pluck="name")
		try:
			self._template(is_default=1)
			defaults = frappe.get_all("POS Label Template", filters={"language": "TSPL", "is_default": 1}, pluck="name")
			self.assertEqual(defaults, [TEMPLATE])
		finally:
			for name in previous:
				frappe.db.set_value("POS Label Template", name, "is_default", 1)
			frappe.delete_doc("POS Label Template", TEMPLATE, force=True, ignore_permissions=True)


class TestLabelRows(LabelTestCase):
	def test_price_incl_vat_and_barcode_per_uom(self) -> None:
		frappe.set_user(CASHIER)
		vat = api.vat_info(api._profile(PROFILE))
		rows = api.resolve_rows(json.dumps([{"item_code": ITEM, "qty": 2}, {"item_code": ITEM, "uom": "Box"}]), PROFILE)
		factor = 1 if vat["prices_include_vat"] else 1 + vat["vat_rate"] / 100
		self.assertEqual(rows[0]["barcode"], NOS_BARCODE)
		self.assertEqual(rows[0]["item_name_ar"], "حليب للاختبار")
		self.assertAlmostEqual(rows[0]["price"], round(10 * factor, 2))
		self.assertEqual(rows[0]["price_label"], f"{self.profile.currency or 'AED'} {rows[0]['price_text']}")
		self.assertEqual(rows[0]["qty"], 2)
		self.assertEqual(rows[0]["uoms"], ["Nos", "Box"])
		self.assertEqual(rows[1]["barcode"], BOX_BARCODE)
		self.assertAlmostEqual(rows[1]["price"], round(120 * factor, 2))  # 12 x stock UOM price

	def test_price_override(self) -> None:
		frappe.set_user(CASHIER)
		row = api.resolve_rows([{"item_code": ITEM, "price": "7.5"}], PROFILE)[0]
		self.assertEqual((row["price"], row["price_text"]), (7.5, "7.50"))

	def test_scale_labels_match_spec_vectors(self) -> None:
		frappe.set_user(CASHIER)
		rows = api.resolve_rows(
			[
				{"item_code": PLU_ITEM, "scale_rule": "Scale Weight 20", "scale_value": 1.25},
				{"item_code": PLU_ITEM, "scale_rule": "Scale Price 22", "scale_value": 25},
			],
			PROFILE,
		)
		self.assertEqual(rows[0]["barcode"], "2012345012509")
		self.assertEqual(rows[0]["weight_label"], "1.250 Kg")
		self.assertEqual(rows[1]["barcode"], "2212345025008")
		self.assertTrue(rows[0]["is_scale"])
		with self.assertRaises(frappe.ValidationError):
			api.resolve_rows([{"item_code": ITEM, "scale_rule": "Scale Weight 20", "scale_value": 1}], PROFILE)

	def test_search(self) -> None:
		frappe.set_user(CASHIER)
		by_barcode = api.search_items(BOX_BARCODE, PROFILE)
		self.assertEqual((by_barcode[0]["item_code"], by_barcode[0]["uom"]), (ITEM, "Box"))
		by_name = api.search_items("Label Test Mil", PROFILE)
		self.assertIn(ITEM, [r["item_code"] for r in by_name])
		self.assertEqual(api.search_items("  ", PROFILE), [])

	def test_cache(self) -> None:
		frappe.set_user(CASHIER)
		cache = api.get_label_cache(PROFILE)
		self.assertTrue(cache["can_print"])
		names = [t["name"] for t in cache["templates"]]
		self.assertIn("A4 Sheet 3x8 (PDF)", names)
		self.assertIn(cache["default_template"], names)
		self.assertTrue(all(t["body"] for t in cache["templates"]))
		self.assertEqual(cache["ar_names"].get(ITEM), "حليب للاختبار")

	def test_access(self) -> None:
		frappe.set_user("Administrator")
		_set_cashier_role(False)
		frappe.set_user(CASHIER)
		self.assertFalse(api.get_label_cache(PROFILE)["can_print"])
		self.assertEqual(api.get_label_cache(PROFILE)["templates"], [])
		with self.assertRaises(frappe.PermissionError):
			api.resolve_rows([{"item_code": ITEM}], PROFILE)
		self.assertNotIn(PROFILE, [p["name"] for p in api.get_label_profiles()])
		frappe.set_user(_ensure_outsider())
		with self.assertRaises(frappe.PermissionError):
			api.get_label_cache(PROFILE)
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			api.render("Shelf Label 38x25 (ZPL)", [{"item_code": ITEM}], PROFILE)
		frappe.set_user("Administrator")
		_set_cashier_role(True)
		frappe.set_user(CASHIER)
		self.assertIn(PROFILE, [p["name"] for p in api.get_label_profiles()])


class TestDocumentsAndRender(LabelTestCase):
	def _warehouse(self) -> str:
		return self.profile.warehouse

	def _supplier(self) -> str:
		if not frappe.db.exists("Supplier", SUPPLIER):
			group = frappe.db.get_value("Supplier Group", {"is_group": 0}, "name")
			if not group:
				group = (
					frappe.get_doc(
						{"doctype": "Supplier Group", "supplier_group_name": "POS0001 Suppliers", "is_group": 0}
					)
					.insert(ignore_permissions=True)
					.name
				)
			frappe.get_doc({"doctype": "Supplier", "supplier_name": SUPPLIER, "supplier_group": group}).insert(
				ignore_permissions=True
			)
		return SUPPLIER

	def test_purchase_receipt_rows(self) -> None:
		receipt = frappe.get_doc(
			{
				"doctype": "Purchase Receipt",
				"company": self.profile.company,
				"supplier": self._supplier(),
				"set_warehouse": self._warehouse(),
				"items": [
					{"item_code": ITEM, "qty": 3, "uom": "Box", "conversion_factor": 12, "rate": 100},
					{"item_code": PLU_ITEM, "qty": 2.4, "uom": "Kg", "conversion_factor": 1, "rate": 5},
				],
			}
		).insert(ignore_permissions=True)
		# A stock user at the desk; managers pass the label check, the profile defaults to
		# the first one of the document's company.
		out = api.items_from_document("Purchase Receipt", receipt.name, PROFILE)
		self.assertEqual(out["pos_profile"], PROFILE)
		self.assertTrue(api.items_from_document("Purchase Receipt", receipt.name)["pos_profile"])
		rows = [(r["item_code"], r["uom"], r["qty"], r["barcode"]) for r in out["rows"]]
		self.assertEqual(rows[0], (ITEM, "Box", 3, BOX_BARCODE))
		self.assertEqual(rows[1][:3], (PLU_ITEM, "Kg", 3))  # 2.4 kg -> 3 labels
		with self.assertRaises(frappe.ValidationError):
			api.items_from_document("Sales Invoice", receipt.name)

	def test_stock_entry_rows_only_received_lines(self) -> None:
		entry = frappe.get_doc(
			{
				"doctype": "Stock Entry",
				"company": self.profile.company,
				"stock_entry_type": "Material Receipt",
				"items": [
					{
						"item_code": ITEM,
						"qty": 5,
						"uom": "Nos",
						"conversion_factor": 1,
						"t_warehouse": self._warehouse(),
						"basic_rate": 4,
					}
				],
			}
		).insert(ignore_permissions=True)
		rows = api.items_from_document("Stock Entry", entry.name, PROFILE)["rows"]
		self.assertEqual([(r["item_code"], r["uom"], r["qty"]) for r in rows], [(ITEM, "Nos", 5)])
		# The cashier may print labels but cannot read stock entries.
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.PermissionError):
			api.items_from_document("Stock Entry", entry.name, PROFILE)
		frappe.set_user(_ensure_outsider())
		with self.assertRaises(frappe.PermissionError):
			api.items_from_document("Stock Entry", entry.name, PROFILE)

	def test_render_raw(self) -> None:
		frappe.set_user(CASHIER)
		out = api.render("Product Label 50x30 (TSPL)", json.dumps([{"item_code": ITEM, "qty": 4}]), PROFILE)
		self.assertEqual((out["language"], out["labels"]), ("TSPL", 4))
		data = base64.b64decode(out["data"])
		self.assertTrue(data.startswith(b"SIZE 50 mm,30 mm\r\nGAP 2 mm,0 mm\r\n"))
		self.assertIn(b'BARCODE 60,104,"EAN13",60,1,0,2,2,"629111111111"', data)
		self.assertIn(b"PRINT 1,4\r\n", data)
		from PIL import features

		if features.check("raqm") and labels.arabic_font():
			self.assertIn(b"BITMAP 16,40,", data)  # Arabic name as a bitmap

	def test_render_pdf(self) -> None:
		frappe.set_user(CASHIER)
		out = api.render("A4 Sheet 3x8 (PDF)", [{"item_code": ITEM, "qty": 25}], PROFILE)
		self.assertEqual((out["language"], out["labels"]), ("PDF", 25))
		frappe.set_user("Administrator")
		file = frappe.get_doc("File", {"file_url": out["file_url"]})
		self.assertTrue(file.is_private)
		content = file.get_content()
		self.assertTrue(content.startswith(b"%PDF"))
		from pypdf import PdfReader

		self.assertEqual(len(PdfReader(io.BytesIO(content)).pages), 2)  # 24 per sheet

	def test_render_rejects_bad_input(self) -> None:
		frappe.set_user(CASHIER)
		with self.assertRaises(frappe.ValidationError):
			api.render("Shelf Label 38x25 (ZPL)", [], PROFILE)
		with self.assertRaises(frappe.ValidationError):
			api.render("Shelf Label 38x25 (ZPL)", [{"item_code": ITEM, "qty": 1000}], PROFILE)
		with self.assertRaises(frappe.ValidationError):
			api.render("No Such Template", [{"item_code": ITEM}], PROFILE)
