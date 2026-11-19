# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Item Wizard endpoints (SPEC F13, section 9 ``items.*``).

Every endpoint needs the role "POS Item Wizard" (Administrator always passes) and access to
the POS Profile whose price lists, warehouse and VAT the wizard uses. The wizard needs to be
online; nothing here is cached by the till.
"""

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, flt

from pos_next.pos_0001 import item_wizard as wiz
from pos_next.pos_0001.permissions import has_pos_profile_access


def can_use_wizard(user: str | None = None) -> bool:
	user = user or frappe.session.user
	if user == "Guest":
		return False
	return user == "Administrator" or wiz.WIZARD_ROLE in frappe.get_roles(user)


def check_wizard_access(pos_profile: str | None) -> None:
	if not can_use_wizard():
		frappe.throw(_("You need the role {0} to create items.").format(_(wiz.WIZARD_ROLE)), frappe.PermissionError)
	if not pos_profile or not has_pos_profile_access(pos_profile):
		frappe.throw(
			_("You don't have access to POS Profile {0}.").format(pos_profile or _("(none)")), frappe.PermissionError
		)


def _payload(payload: Any) -> dict:
	if isinstance(payload, str):
		try:
			payload = json.loads(payload or "{}")
		except ValueError:
			frappe.throw(_("The wizard sent data the server cannot read. Reload the page and try again."))
	if not isinstance(payload, dict):
		frappe.throw(_("The wizard sent data the server cannot read. Reload the page and try again."))
	return payload


def _list(value: Any) -> list:
	if isinstance(value, str):
		value = json.loads(value or "[]")
	return list(value or [])


@frappe.whitelist()
def can_use_item_wizard() -> dict:
	"""For the "New item" menu entry."""
	return {"allowed": can_use_wizard()}


@frappe.whitelist()
def get_wizard_profiles() -> list[dict]:
	"""POS Profiles the user may create items for."""
	if not can_use_wizard():
		frappe.throw(_("You need the role {0} to create items.").format(_(wiz.WIZARD_ROLE)), frappe.PermissionError)
	rows = frappe.get_all("POS Profile", filters={"disabled": 0}, fields=["name", "company"], order_by="name asc")
	return [r for r in rows if has_pos_profile_access(r.name)]


def _presets() -> list[dict]:
	out = []
	for name in frappe.get_all("POS Item Wizard Preset", order_by="is_standard desc, creation asc", pluck="name"):
		doc = frappe.get_doc("POS Item Wizard Preset", name)
		out.append(
			{
				"name": doc.name,
				"preset_name": doc.preset_name,
				"preset_name_ar": doc.preset_name_ar,
				"description": doc.description,
				"is_standard": doc.is_standard,
				"payload": wiz.preset_payload(doc.as_dict()),
			}
		)
	return out


@frappe.whitelist()
def wizard_defaults(
	pos_profile: str, preset: str | None = None, copy_from: str | None = None, edit: str | None = None
) -> dict:
	"""Everything the wizard steps need: price lists, warehouses, VAT templates, units, groups,
	presets, scale rules and the next PLU. ``copy_from`` / ``edit`` also return the payload of
	that item."""
	check_wizard_access(pos_profile)
	ctx = wiz.profile_context(pos_profile)
	company = ctx.company
	tax_templates = []
	for t in frappe.get_all("Item Tax Template", filters={"company": company, "disabled": 0}, fields=["name", "title"]):
		tax_templates.append({"name": t.name, "title": t.title, "rate": wiz.tax_template_rate(t.name, 0)})
	default_tax = next(
		(t["name"] for t in tax_templates if abs(t["rate"] - flt(ctx.vat_rate)) < 1e-9 and t["rate"] > 0), ""
	)
	rules = frappe.get_all(
		"POS Scale Barcode Rule",
		filters={"company": company, "enabled": 1},
		fields=["name", "prefix", "value_type", "item_match", "item_code_length", "uom"],
		order_by="priority asc, name asc",
	)
	length = cint(rules[0].item_code_length) if rules else 5
	out = {
		"profile": {
			"name": ctx.name,
			"company": company,
			"currency": ctx.currency,
			"selling_price_list": ctx.selling_price_list,
			"buying_price_list": ctx.buying_price_list,
			"warehouse": ctx.warehouse,
			"vat_rate": ctx.vat_rate,
			"prices_include_vat": ctx.prices_include_vat,
		},
		"default_item_tax_template": default_tax,
		"tax_templates": tax_templates,
		"warehouses": frappe.get_all(
			"Warehouse", filters={"company": company, "is_group": 0, "disabled": 0}, pluck="name", order_by="name asc"
		),
		"uoms": frappe.get_all("UOM", filters={"enabled": 1}, fields=["name", "must_be_whole_number"], order_by="name asc"),
		"item_groups": frappe.get_all("Item Group", filters={"is_group": 0}, pluck="name", order_by="name asc"),
		"brands": frappe.get_all("Brand", pluck="name", order_by="name asc", limit=500),
		"suppliers": frappe.get_all(
			"Supplier", filters={"disabled": 0}, pluck="name", order_by="name asc", limit=500
		),
		"presets": _presets(),
		"scale_rules": rules,
		"next_scale_plu": wiz.next_scale_plu(length),
		"internal_barcode_prefix": wiz.internal_barcode_prefix(),
		"entry_units": wiz.ENTRY_UNITS,
		"item_naming_by_series": frappe.db.get_single_value("Stock Settings", "item_naming_by") == "Naming Series",
		"payload": None,
	}
	if preset:
		match = next((p for p in out["presets"] if p["name"] == preset), None)
		if not match:
			frappe.throw(_("Item Wizard Preset {0} does not exist.").format(preset), frappe.DoesNotExistError)
		out["payload"] = match["payload"]
	source = edit or copy_from
	if source:
		payload = wiz.item_payload(source, ctx)
		if copy_from and not edit:
			payload.update({"item_code": "", "item_name": "", "item_name_ar": "", "image": "", "scale_plu": ""})
			for unit in payload["selling_units"]:
				unit["barcode"] = ""
				unit.pop("existing", None)
		out["payload"] = payload
	return out


@frappe.whitelist()
def suggest_item_code(pos_profile: str, item_group: str | None = None) -> dict:
	check_wizard_access(pos_profile)
	return {"item_code": wiz.suggest_item_code(item_group)}


@frappe.whitelist()
def wizard_preview(payload: Any) -> dict:
	"""Per-unit prices, cost, margin and warnings. No writes."""
	data = _payload(payload)
	check_wizard_access(data.get("pos_profile"))
	p = wiz.normalize(data)
	ctx = wiz.profile_context(p["pos_profile"])
	out = wiz.compute(p, ctx)
	out["warnings"] = wiz.with_messages(out["warnings"])
	out["errors"] = wiz.with_messages(out["errors"])
	return out


@frappe.whitelist()
def wizard_validate(payload: Any, steps: Any = None, item_code: str | None = None) -> dict:
	"""Errors and warnings per step: duplicate barcodes, codes and PLUs, sizes, below cost."""
	data = _payload(payload)
	check_wizard_access(data.get("pos_profile"))
	step_list = tuple(_list(steps)) if steps else None
	return wiz.validate(data, step_list, existing_item=item_code or None)


@frappe.whitelist(methods=["POST"])
def wizard_create(payload: Any) -> dict:
	"""Create the item and every record of SPEC F13 in one transaction."""
	data = _payload(payload)
	check_wizard_access(data.get("pos_profile"))
	return wiz.create(data)


@frappe.whitelist(methods=["POST"])
def wizard_update_packaging(item_code: str, payload: Any) -> dict:
	"""Edit mode: add units, change prices, add barcodes; removing a unit only disables it."""
	data = _payload(payload)
	check_wizard_access(data.get("pos_profile"))
	return wiz.update_packaging(item_code, data)


@frappe.whitelist()
def generate_internal_barcode(pos_profile: str, uom: str | None = None, exclude: Any = None) -> dict:
	"""Unused internal EAN-13 with the prefix from POS 0001 Settings. ``exclude`` lists codes
	already shown in the wizard but not saved yet."""
	check_wizard_access(pos_profile)
	return {"barcode": wiz.generate_internal_barcode(_list(exclude)), "uom": uom}


@frappe.whitelist(methods=["POST"])
def import_wizard_csv(pos_profile: str, content: str | None = None, file_url: str | None = None) -> list[dict]:
	"""Create many items from the wizard CSV template; one result per row."""
	check_wizard_access(pos_profile)
	if file_url and not content:
		file_doc = frappe.get_doc("File", {"file_url": file_url})
		file_doc.check_permission("read")
		content = file_doc.get_content()
		if isinstance(content, bytes):
			content = content.decode("utf-8-sig")
	if not content:
		frappe.throw(_("The CSV file is empty."))
	return wiz.import_csv(content, pos_profile)


@frappe.whitelist()
def wizard_csv_template(pos_profile: str) -> dict:
	check_wizard_access(pos_profile)
	return {"filename": "item_wizard_template.csv", "content": wiz.csv_template(), "columns": wiz.CSV_COLUMNS}


@frappe.whitelist(methods=["POST"])
def save_wizard_preset(pos_profile: str, preset_name: str, payload: Any) -> dict:
	""""Save as preset" after Create: units, group, VAT and scale choice; no prices or barcodes."""
	check_wizard_access(pos_profile)
	preset_name = (preset_name or "").strip()
	if not preset_name:
		frappe.throw(_("Give the preset a name."))
	if frappe.db.exists("POS Item Wizard Preset", preset_name):
		frappe.throw(_("A preset named {0} already exists. Pick another name.").format(preset_name))
	p = wiz.normalize(_payload(payload))
	doc = frappe.get_doc(
		{
			"doctype": "POS Item Wizard Preset",
			"preset_name": preset_name,
			"item_group": p["item_group"] or None,
			"stock_uom": p["stock_uom"],
			"sold_on_scale": p["sold_on_scale"],
			"item_tax_template": p["item_tax_template"] or None,
			"prices_include_vat": p["prices_include_vat"],
			"buying_units": [
				{"uom": u["uom"], "size": u["size"], "parent_uom": u["parent_uom"] if u["parent_uom"] != p["stock_uom"] else None}
				for u in p["buying_units"]
			],
			"selling_units": [
				{
					"uom": u["uom"],
					"size": u["size"],
					"size_uom": u["size_uom"] if u["size_uom"] != p["stock_uom"] else None,
					"priced": u["priced"],
					"default_margin": u["margin"],
				}
				for u in p["selling_units"]
				if not u["remove"]
			],
		}
	)
	doc.insert(ignore_permissions=True)
	return {"name": doc.name}


@frappe.whitelist()
def search_items(pos_profile: str, query: str = "") -> list[dict]:
	"""Items to copy from or to open in edit mode."""
	check_wizard_access(pos_profile)
	query = (query or "").strip()
	item = frappe.qb.DocType("Item")
	q = (
		frappe.qb.from_(item)
		.select(item.name, item.item_name, item.item_name_ar, item.stock_uom)
		.where(item.disabled == 0)
		.where(item.has_variants == 0)
		.orderby(item.modified, order=frappe.qb.desc)
		.limit(20)
	)
	if query:
		like = f"%{query}%"
		q = q.where((item.name.like(like)) | (item.item_name.like(like)) | (item.item_name_ar.like(like)))
	return q.run(as_dict=True)
