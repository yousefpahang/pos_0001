# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Barcode label printing (SPEC F4).

The POS and the desk page ``pos-labels`` (which shows the POS label screen) build label
jobs in the browser from the label cache, so labels print offline. The server gives:

- ``get_label_cache``: templates, the till's label printer, price list, VAT, company.
- ``get_label_profiles``: POS Profiles the user may print labels for (desk page).
- ``search_items`` / ``resolve_rows``: rows with barcode and price incl. VAT per UOM.
- ``items_from_document``: rows from a Purchase Receipt or Stock Entry (received qty).
- ``render``: the raw job (ZPL / EPL / TSPL, base64) or an A4 PDF file.

Access: a POS role, access to the POS Profile, and the profile's Print Labels role
(empty: POS managers only).
"""

from __future__ import annotations

import json
import math
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, flt, formatdate, getdate, nowdate

from pos_next.pos_0001 import labels
from pos_next.pos_0001.api.barcode import _item_plu, _uom_factor, _unit_rate, rules_for
from pos_next.pos_0001.api.printing import resolve_printers
from pos_next.pos_0001.permissions import (
	allowed_pos_profiles,
	check_pos_profile_access,
	is_pos_manager,
	require_pos_user,
)
from pos_next.pos_0001.scale_barcode import ScaleRule, generate_scale_barcode, round_to

TEMPLATE = "POS Label Template"
TEMPLATE_FIELDS = (
	"name",
	"template_name",
	"language",
	"is_default",
	"company",
	"width_mm",
	"height_mm",
	"dpi",
	"gap_mm",
	"barcode_type",
	"a4_columns",
	"a4_rows",
	"margins_mm",
	"body",
)
SOURCE_DOCTYPES = ("Purchase Receipt", "Stock Entry")
SEARCH_LIMIT = 20


def _parse(value: Any) -> Any:
	if isinstance(value, str):
		return json.loads(value) if value.strip() else None
	return value


# ---------------------------------------------------------------------------
# Access
# ---------------------------------------------------------------------------


def can_print_labels(pos_profile: str | None, user: str | None = None) -> bool:
	"""POS managers, or users with the profile's Print Labels role."""
	user = user or frappe.session.user
	if is_pos_manager(user):
		return True
	if not pos_profile:
		return False
	role = frappe.db.get_value("POS Profile", pos_profile, "pos0001_label_role")
	return bool(role and role in frappe.get_roles(user))


def check_label_access(pos_profile: str | None) -> None:
	check_pos_profile_access(pos_profile)
	if not can_print_labels(pos_profile):
		frappe.throw(
			_("You are not allowed to print labels for POS Profile {0}.").format(pos_profile),
			frappe.PermissionError,
		)


# ---------------------------------------------------------------------------
# Profile data: price list, VAT, templates
# ---------------------------------------------------------------------------


def _profile(pos_profile: str) -> frappe._dict:
	row = frappe.db.get_value(
		"POS Profile",
		pos_profile,
		["name", "company", "selling_price_list", "currency", "taxes_and_charges", "pos0001_default_label_template"],
		as_dict=True,
	)
	if not row:
		frappe.throw(_("POS Profile {0} was not found.").format(pos_profile), frappe.DoesNotExistError)
	if not row.currency:
		row.currency = frappe.get_cached_value("Company", row.company, "default_currency")
	return row


def vat_info(profile: frappe._dict) -> dict:
	"""VAT rate of the profile's sales tax template and whether prices already include it."""
	template = profile.taxes_and_charges or frappe.db.get_value(
		"Sales Taxes and Charges Template", {"company": profile.company, "is_default": 1, "disabled": 0}, "name"
	)
	if not template:
		return {"vat_rate": 0.0, "prices_include_vat": 0, "tax_accounts": []}
	rows = frappe.get_all(
		"Sales Taxes and Charges",
		filters={"parenttype": "Sales Taxes and Charges Template", "parent": template},
		fields=["charge_type", "rate", "account_head", "included_in_print_rate"],
	)
	net_rows = [r for r in rows if r.charge_type == "On Net Total"]
	return {
		"vat_rate": flt(sum(flt(r.rate) for r in net_rows), 6),
		"prices_include_vat": 1 if any(cint(r.included_in_print_rate) for r in net_rows) else 0,
		"tax_accounts": sorted({r.account_head for r in net_rows if r.account_head}),
	}


def item_vat_rates(tax_accounts: list[str], item_codes: list[str] | None = None) -> dict[str, float]:
	"""VAT rate of items that have their own Item Tax Template (zero-rated, exempt)."""
	if not tax_accounts:
		return {}
	it = frappe.qb.DocType("Item Tax")
	query = (
		frappe.qb.from_(it)
		.select(it.parent, it.item_tax_template, it.valid_from, it.idx)
		.where(it.parenttype == "Item")
		.where((it.tax_category.isnull()) | (it.tax_category == ""))
		.orderby(it.parent)
		.orderby(it.valid_from, order=frappe.qb.desc)
		.orderby(it.idx)
	)
	if item_codes is not None:
		if not item_codes:
			return {}
		query = query.where(it.parent.isin(item_codes))
	today = getdate(nowdate())
	chosen: dict[str, str] = {}
	for row in query.run(as_dict=True):
		if row.parent in chosen or (row.valid_from and getdate(row.valid_from) > today):
			continue
		chosen[row.parent] = row.item_tax_template
	if not chosen:
		return {}
	detail_rows = frappe.get_all(
		"Item Tax Template Detail",
		filters={"parent": ["in", list(set(chosen.values()))], "tax_type": ["in", tax_accounts]},
		fields=["parent", "tax_rate"],
	)
	rates: dict[str, float] = {}
	for row in detail_rows:
		rates[row.parent] = rates.get(row.parent, 0.0) + flt(row.tax_rate)
	return {item: flt(rates.get(template, 0.0), 6) for item, template in chosen.items()}


def arabic_names() -> dict[str, str]:
	"""Item code -> Arabic name, for labels printed offline (POS Next's item cache has none)."""
	if not frappe.db.has_column("Item", "item_name_ar"):
		return {}
	item = frappe.qb.DocType("Item")
	rows = (
		frappe.qb.from_(item)
		.select(item.name, item.item_name_ar)
		.where(item.disabled == 0)
		.where((item.item_name_ar.isnotnull()) & (item.item_name_ar != ""))
		.run()
	)
	return dict(rows)


def price_incl_vat(amount: float, vat_rate: float, prices_include_vat: int) -> float:
	"""Shelf price: the amount with VAT added, unless prices already include it."""
	if cint(prices_include_vat):
		return round_to(amount, 2)
	return round_to(flt(amount) * (1 + flt(vat_rate) / 100), 2)


def _templates(company: str | None) -> list[dict]:
	rows = frappe.get_all(
		TEMPLATE, filters={"enabled": 1}, fields=list(TEMPLATE_FIELDS), order_by="language asc, template_name asc"
	)
	return [dict(r) for r in rows if not r.company or r.company == company]


def default_template(templates: list[dict], profile_default: str | None, printer: dict | None) -> str | None:
	names = {t["name"] for t in templates}
	if profile_default and profile_default in names:
		return profile_default
	language = (printer or {}).get("label_language") if printer else "PDF"
	for t in templates:
		if t["language"] == language and cint(t["is_default"]):
			return t["name"]
	for t in templates:
		if t["language"] == language:
			return t["name"]
	return templates[0]["name"] if templates else None


def base_context(profile: frappe._dict) -> dict:
	return {
		"currency": profile.currency or "",
		"company": profile.company or "",
		"date": formatdate(nowdate()),
	}


@frappe.whitelist()
def get_label_cache(pos_profile: str, device_id: str | None = None) -> dict:
	"""Everything the POS needs to print labels offline."""
	check_pos_profile_access(pos_profile)
	profile = _profile(pos_profile)
	allowed = can_print_labels(pos_profile)
	vat = vat_info(profile)
	printer = resolve_printers(pos_profile, device_id)["label"]
	templates = _templates(profile.company) if allowed else []
	return {
		"pos_profile": pos_profile,
		"can_print": 1 if allowed else 0,
		"company": profile.company,
		"currency": profile.currency,
		"price_list": profile.selling_price_list,
		"vat_rate": vat["vat_rate"],
		"prices_include_vat": vat["prices_include_vat"],
		"item_vat": item_vat_rates(vat["tax_accounts"]) if allowed else {},
		"ar_names": arabic_names() if allowed else {},
		"date_format": frappe.db.get_default("date_format") or "yyyy-mm-dd",
		"printer": printer,
		"templates": templates,
		"default_template": default_template(templates, profile.pos0001_default_label_template, printer),
	}


@frappe.whitelist()
def get_label_profiles() -> list[dict]:
	"""POS Profiles the user may print labels for (desk page)."""
	require_pos_user()
	allowed = allowed_pos_profiles()
	filters: dict[str, Any] = {"disabled": 0}
	if allowed is not None:
		if not allowed:
			return []
		filters["name"] = ["in", allowed]
	rows = frappe.get_all("POS Profile", filters=filters, fields=["name", "company"], order_by="name asc")
	return [dict(r) for r in rows if can_print_labels(r.name)]


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------


def _barcode_for(item_code: str, uom: str, stock_uom: str) -> str:
	rows = frappe.get_all(
		"Item Barcode",
		filters={"parent": item_code, "parenttype": "Item"},
		fields=["barcode", "uom"],
		order_by="idx asc",
	)
	for row in rows:
		if row.barcode and (row.uom == uom or (not row.uom and uom == stock_uom)):
			return row.barcode
	if uom == stock_uom:
		for row in rows:
			if row.barcode and (not row.uom or row.uom == stock_uom):
				return row.barcode
	return item_code


def _item_uoms(item_code: str, stock_uom: str) -> list[str]:
	uoms = frappe.get_all(
		"UOM Conversion Detail", filters={"parent": item_code, "parenttype": "Item"}, pluck="uom", order_by="idx asc"
	)
	return [stock_uom] + [u for u in uoms if u and u != stock_uom]


def _scale_rule(profile: frappe._dict, rule_name: str) -> dict:
	for rule in rules_for(profile.company, profile.name):
		if rule["name"] == rule_name:
			return rule
	frappe.throw(_("Scale barcode rule {0} is not enabled for POS Profile {1}.").format(rule_name, profile.name))


def format_price(value: float) -> str:
	return f"{round_to(value, 2):.2f}"


def resolve_row(row: dict, profile: frappe._dict, vat: dict, item_vat: dict[str, float]) -> dict:
	"""One label row with name, barcode and price incl. VAT for its UOM (or scale label)."""
	item_code = (row.get("item_code") or "").strip()
	item = frappe.db.get_value(
		"Item",
		item_code,
		["name", "item_name", "stock_uom", "disabled", "has_variants"]
		+ (["item_name_ar"] if frappe.db.has_column("Item", "item_name_ar") else []),
		as_dict=True,
	)
	if not item:
		frappe.throw(_("Item {0} was not found.").format(item_code or ""), frappe.DoesNotExistError)
	qty = cint(row.get("qty") or 1)
	if qty < 1 or qty > labels.MAX_QTY:
		frappe.throw(_("Label quantity must be between 1 and {0}.").format(labels.MAX_QTY))
	vat_rate = item_vat.get(item.name, vat["vat_rate"])
	out = {
		"item_code": item.name,
		"item_name": item.item_name,
		"item_name_ar": item.get("item_name_ar") or "",
		"qty": qty,
		"uoms": _item_uoms(item.name, item.stock_uom),
		"weight_label": "",
		"is_scale": 0,
	}
	rule_name = row.get("scale_rule")
	if rule_name:
		rule = ScaleRule.from_dict(_scale_rule(profile, rule_name))
		value = flt(row.get("scale_value"))
		if value <= 0:
			frappe.throw(_("Enter the weight or price for the scale label of {0}.").format(item.name))
		plu = _item_plu(rule, item.name)
		if not plu:
			frappe.throw(
				_("Item {0} has no scale code that fits rule {1} ({2} digits).").format(
					item.name, rule.name, rule.item_code_length
				)
			)
		uom = rule.uom or item.stock_uom
		factor = _uom_factor(item.name, item.stock_uom, uom)
		if factor is None:
			frappe.throw(_("Item {0} ({1}) is not sold in {2}.").format(item.name, item.item_name, uom))
		try:
			code = generate_scale_barcode(rule, plu, value)
		except ValueError:
			frappe.throw(
				_("Value {0} does not fit in {1} digits with {2} decimals for rule {3}.").format(
					value, rule.value_length, rule.decimals, rule.name
				)
			)
		if rule.value_type == "Weight":
			rate = _unit_rate(item.name, item.stock_uom, uom, factor, profile.selling_price_list)
			amount = round_to(round_to(value, 3) * rate, 2)
			out["weight_label"] = f"{round_to(value, 3):.3f} {uom}"
		else:
			amount = round_to(value, 2)
		price = price_incl_vat(amount, vat_rate, vat["prices_include_vat"])
		out.update(
			{
				"uom": uom,
				"barcode": code,
				"is_scale": 1,
				"scale_rule": rule.name,
				"scale_value": value,
			}
		)
	else:
		uom = row.get("uom") or item.stock_uom
		factor = _uom_factor(item.name, item.stock_uom, uom)
		if factor is None:
			frappe.throw(_("Item {0} ({1}) has no UOM {2}.").format(item.name, item.item_name, uom))
		rate = _unit_rate(item.name, item.stock_uom, uom, factor, profile.selling_price_list)
		price = price_incl_vat(rate, vat_rate, vat["prices_include_vat"])
		out.update({"uom": uom, "barcode": _barcode_for(item.name, uom, item.stock_uom)})
	if row.get("price") not in (None, ""):
		price = round_to(flt(row.get("price")), 2)
		out["price_override"] = price
	out.update(
		{
			"price": price,
			"price_text": format_price(price),
			"price_label": f"{profile.currency} {format_price(price)}".strip(),
		}
	)
	return out


def _resolve(rows: list[dict], profile: frappe._dict) -> list[dict]:
	vat = vat_info(profile)
	codes = list({(r.get("item_code") or "").strip() for r in rows if r.get("item_code")})
	item_vat = item_vat_rates(vat["tax_accounts"], codes)
	return [resolve_row(frappe._dict(r), profile, vat, item_vat) for r in rows]


def _rows_arg(rows: Any) -> list[dict]:
	rows = _parse(rows) or []
	if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
		frappe.throw(_("Rows must be a list."))
	if len(rows) > labels.MAX_ROWS:
		frappe.throw(_("At most {0} rows per print.").format(labels.MAX_ROWS))
	return rows


@frappe.whitelist()
def resolve_rows(rows: Any, pos_profile: str) -> list[dict]:
	"""Barcode, price incl. VAT and names for label rows (the POS uses this when online)."""
	check_label_access(pos_profile)
	return _resolve(_rows_arg(rows), _profile(pos_profile))


@frappe.whitelist()
def search_items(query: str, pos_profile: str) -> list[dict]:
	"""Items to add to the label list: exact barcode first, then code or name."""
	check_label_access(pos_profile)
	query = (query or "").strip()
	if not query:
		return []
	codes: list[str] = []
	exact = frappe.db.get_value("Item Barcode", {"barcode": query, "parenttype": "Item"}, ["parent", "uom"], as_dict=True)
	rows: list[dict] = []
	if exact:
		rows.append({"item_code": exact.parent, "uom": exact.uom or None, "qty": 1})
		codes.append(exact.parent)
	item = frappe.qb.DocType("Item")
	like = f"%{query}%"
	condition = (item.name.like(f"{query}%")) | (item.item_name.like(like))
	if frappe.db.has_column("Item", "item_name_ar"):
		condition = condition | (item.item_name_ar.like(like))
	found = (
		frappe.qb.from_(item)
		.select(item.name)
		.where(item.disabled == 0)
		.where(item.has_variants == 0)
		.where(item.is_sales_item == 1)
		.where(condition)
		.orderby(item.name)
		.limit(SEARCH_LIMIT)
		.run(pluck=True)
	)
	for code in found:
		if code not in codes:
			rows.append({"item_code": code, "qty": 1})
			codes.append(code)
	return _resolve(rows[:SEARCH_LIMIT], _profile(pos_profile))


def _default_profile_for(company: str) -> str | None:
	allowed = allowed_pos_profiles()
	filters: dict[str, Any] = {"company": company, "disabled": 0}
	if allowed is not None:
		filters["name"] = ["in", allowed or [""]]
	for name in frappe.get_all("POS Profile", filters=filters, pluck="name", order_by="name asc"):
		if can_print_labels(name):
			return name
	return None


@frappe.whitelist()
def items_from_document(doctype: str, name: str, pos_profile: str | None = None) -> dict:
	"""Label rows from a Purchase Receipt or Stock Entry: received items and quantities."""
	require_pos_user()
	if doctype not in SOURCE_DOCTYPES:
		frappe.throw(_("Labels can be taken from a Purchase Receipt or a Stock Entry."))
	if not frappe.db.exists(doctype, name):
		frappe.throw(_("{0} {1} was not found.").format(_(doctype), name), frappe.DoesNotExistError)
	doc = frappe.get_doc(doctype, name)
	if not frappe.has_permission(doctype, "read", doc):
		frappe.throw(_("You cannot read {0} {1}.").format(_(doctype), name), frappe.PermissionError)
	pos_profile = pos_profile or _default_profile_for(doc.company)
	if not pos_profile:
		frappe.throw(
			_("You may not print labels for any POS Profile of company {0}.").format(doc.company), frappe.PermissionError
		)
	check_label_access(pos_profile)
	rows = []
	for line in doc.items:
		if doctype == "Stock Entry" and not line.get("t_warehouse"):
			continue
		qty = flt(line.qty)  # accepted qty in the line's UOM
		if qty <= 0 or not line.item_code:
			continue
		rows.append({"item_code": line.item_code, "uom": line.uom, "qty": min(max(math.ceil(qty), 1), labels.MAX_QTY)})
	return {
		"doctype": doctype,
		"name": name,
		"pos_profile": pos_profile,
		"rows": _resolve(rows[: labels.MAX_ROWS], _profile(pos_profile)),
	}


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _template(name: str, company: str | None) -> labels.Template:
	row = frappe.db.get_value(TEMPLATE, name, list(TEMPLATE_FIELDS) + ["enabled"], as_dict=True)
	if not row or not cint(row.enabled):
		frappe.throw(_("Label template {0} was not found or is disabled.").format(name))
	if row.company and row.company != company:
		frappe.throw(_("Label template {0} belongs to company {1}.").format(name, row.company))
	return labels.Template.from_dict(row)


def with_barcode_types(template: labels.Template, rows: list[dict]) -> list[dict]:
	out = []
	for row in rows:
		preferred = "EAN13" if row.get("is_scale") else template.barcode_type
		out.append({**row, "barcode_type": labels.effective_barcode_type(preferred, row.get("barcode") or "")})
	return out


def html_to_pdf(html: str) -> bytes:
	"""A4 sheets to PDF with WeasyPrint (a Frappe dependency). wkhtmltopdf builds without
	patched Qt scale pages, which would move labels off the sheet's die-cut grid."""
	from weasyprint import HTML

	return HTML(string=html, base_url=frappe.utils.get_url()).write_pdf()


@frappe.whitelist(methods=["POST"])
def render(template: str, rows: Any, pos_profile: str) -> dict:
	"""Raw job (base64) for ZPL / EPL / TSPL templates, or a private PDF file for PDF ones."""
	check_label_access(pos_profile)
	profile = _profile(pos_profile)
	tpl = _template(template, profile.company)
	resolved = with_barcode_types(tpl, _resolve(_rows_arg(rows), profile))
	if not resolved:
		frappe.throw(_("Add at least one item to print labels."))
	base = base_context(profile)
	try:
		if tpl.language == "PDF":
			pdf = html_to_pdf(labels.render_pdf_html(tpl, resolved, base))
			file = frappe.get_doc(
				{
					"doctype": "File",
					"file_name": f"labels-{frappe.generate_hash(length=10)}.pdf",
					"is_private": 1,
					"content": pdf,
				}
			)
			file.flags.ignore_permissions = True
			file.insert()
			return {"language": "PDF", "file_url": file.file_url, "labels": labels.check_rows(resolved)}
		data = labels.render_raw(tpl, resolved, base)
	except labels.ArabicBitmapUnavailable:
		frappe.throw(
			_(
				"Arabic text cannot be drawn on this server (Pillow needs libraqm and an Arabic font). Print these labels from the POS, which draws Arabic in the browser."
			)
		)
	except labels.LabelTemplateError as error:
		frappe.throw(_("The label template cannot be used: {0}").format(str(error)))
	return {
		"language": tpl.language,
		"data": labels.to_base64(data),
		"labels": labels.check_rows(resolved),
	}
