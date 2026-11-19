# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Scale barcodes (SPEC F5) and the browser scan cache.

The POS parses scale labels in the browser (plus/core/scaleBarcode.js) so it works
offline. This module gives the browser the rules and the barcode index it needs, resolves
labels on the server when the browser cannot, and re-validates scale lines when the
invoice arrives (Sales Invoice validate hook).
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.query_builder.functions import Count
from frappe.utils import flt, getdate, nowdate

from pos_next.pos_0001.permissions import check_pos_profile_access, require_pos_user
from pos_next.pos_0001.scale_barcode import (
	ParsedBarcode,
	ScaleRule,
	generate_scale_barcode as _generate,
	parse_scale_barcode,
	plu_candidates,
	price_line,
	round_to,
)

RULE_DOCTYPE = "POS Scale Barcode Rule"
RULE_FIELDS = [
	"name",
	"company",
	"priority",
	"prefix",
	"total_length",
	"check_digit_mode",
	"item_code_start",
	"item_code_length",
	"item_match",
	"value_type",
	"uom",
	"value_start",
	"value_length",
	"decimals",
]
QTY_TOLERANCE = 0.0005
AMOUNT_TOLERANCE = 0.005


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


def rules_for(company: str | None, pos_profile: str | None) -> list[dict]:
	"""Enabled rules of the company, limited to the profile when a rule lists profiles."""
	if not company:
		return []
	rules = frappe.get_all(
		RULE_DOCTYPE,
		filters={"enabled": 1, "company": company},
		fields=RULE_FIELDS,
		order_by="priority asc, name asc",
	)
	if not rules:
		return []
	limits: dict[str, set[str]] = {}
	for row in frappe.get_all(
		"POS Scale Barcode Rule Profile",
		filters={"parenttype": RULE_DOCTYPE, "parent": ["in", [r.name for r in rules]]},
		fields=["parent", "pos_profile"],
	):
		limits.setdefault(row.parent, set()).add(row.pos_profile)
	return [
		dict(r) for r in rules if r.name not in limits or (pos_profile and pos_profile in limits[r.name])
	]


def _profile_company(pos_profile: str) -> str | None:
	return frappe.db.get_value("POS Profile", pos_profile, "company")


@frappe.whitelist()
def get_scale_rules(pos_profile: str) -> list[dict]:
	"""Scale rules for a POS Profile (cached by the browser for offline scanning)."""
	check_pos_profile_access(pos_profile)
	return rules_for(_profile_company(pos_profile), pos_profile)


def _plu_map() -> dict[str, str]:
	item = frappe.qb.DocType("Item")
	rows = (
		frappe.qb.from_(item)
		.select(item.scale_plu, item.name)
		.where((item.scale_plu.isnotnull()) & (item.scale_plu != ""))
		.where(item.disabled == 0)
		.where(item.is_sales_item == 1)
		.where(item.has_variants == 0)
		.run(as_dict=True)
	)
	return {r.scale_plu: r.name for r in rows}


def _uom_barcodes() -> dict[str, dict]:
	"""Barcodes the plain items cache cannot answer exactly.

	POS Next caches each item's barcodes as one joined string without their UOM, so a box
	barcode would be sold as one piece. List every barcode with its own UOM, and every
	barcode of items that have more than one.
	"""
	ib = frappe.qb.DocType("Item Barcode")
	item = frappe.qb.DocType("Item")
	multi = (
		frappe.qb.from_(ib)
		.select(ib.parent)
		.where(ib.parenttype == "Item")
		.groupby(ib.parent)
		.having(Count(ib.name) > 1)
	)
	rows = (
		frappe.qb.from_(ib)
		.join(item)
		.on(item.name == ib.parent)
		.select(ib.barcode, ib.parent, ib.uom, item.stock_uom)
		.where(ib.parenttype == "Item")
		.where(item.disabled == 0)
		.where(
			((ib.uom.isnotnull()) & (ib.uom != "") & (ib.uom != item.stock_uom)) | ib.parent.isin(multi)
		)
		.run(as_dict=True)
	)
	return {r.barcode: {"item_code": r.parent, "uom": r.uom or r.stock_uom} for r in rows if r.barcode}


@frappe.whitelist()
def get_scan_cache(pos_profile: str) -> dict[str, Any]:
	"""Everything the browser needs to resolve scans offline: rules, PLU map, UOM barcodes."""
	check_pos_profile_access(pos_profile)
	from pos_next.pos_0001.doctype.pos_0001_settings.pos_0001_settings import get_settings

	return {
		"pos_profile": pos_profile,
		"rules": rules_for(_profile_company(pos_profile), pos_profile),
		"plu_map": _plu_map(),
		"uom_barcodes": _uom_barcodes(),
		"refresh_minutes": int(get_settings().get("cache_refresh_minutes") or 5),
	}


# ---------------------------------------------------------------------------
# Resolution (same steps as plus/core/scanResolve.js)
# ---------------------------------------------------------------------------


class ScaleBarcodeError(frappe.ValidationError):
	pass


def _find_item(parsed: ParsedBarcode) -> str | None:
	for plu in plu_candidates(parsed.plu):
		if parsed.rule.item_match == "Scale PLU":
			code = frappe.db.get_value("Item", {"scale_plu": plu, "disabled": 0}, "name")
		else:
			code = frappe.db.get_value("Item Barcode", {"barcode": plu, "parenttype": "Item"}, "parent")
		if code:
			return code
	return None


def _uom_factor(item_code: str, stock_uom: str, uom: str) -> float | None:
	if not uom or uom == stock_uom:
		return 1.0
	factor = frappe.db.get_value(
		"UOM Conversion Detail", {"parent": item_code, "parenttype": "Item", "uom": uom}, "conversion_factor"
	)
	return flt(factor) or None


def _price(item_code: str, price_list: str, uom: str) -> float | None:
	ip = frappe.qb.DocType("Item Price")
	today = getdate(nowdate())
	rows = (
		frappe.qb.from_(ip)
		.select(ip.price_list_rate, ip.valid_from, ip.valid_upto)
		.where(ip.item_code == item_code)
		.where(ip.price_list == price_list)
		.where(ip.uom == uom)
		.orderby(ip.valid_from, order=frappe.qb.desc)
		.run(as_dict=True)
	)
	for r in rows:
		if (not r.valid_from or getdate(r.valid_from) <= today) and (
			not r.valid_upto or getdate(r.valid_upto) >= today
		):
			return flt(r.price_list_rate)
	return None


def _unit_rate(item_code: str, stock_uom: str, uom: str, factor: float, price_list: str | None) -> float:
	if not price_list:
		return 0.0
	rate = _price(item_code, price_list, uom)
	if rate is None and uom != stock_uom:
		base = _price(item_code, price_list, stock_uom)
		rate = base * factor if base is not None else None
	return flt(rate)


def _parse_or_throw(barcode: str, rules: list[dict]) -> ParsedBarcode:
	parsed = parse_scale_barcode(barcode, rules)
	if parsed is None:
		frappe.throw(_("Barcode {0} does not match any scale barcode rule.").format(barcode), ScaleBarcodeError)
	if not parsed.ok:
		frappe.throw(
			_(
				"Barcode {0} has a wrong check digit. Scan it again, or ask a manager to check the scale rule {1}."
			).format(barcode, parsed.rule.name),
			ScaleBarcodeError,
		)
	return parsed


def resolve(barcode: str, pos_profile: str) -> dict[str, Any]:
	"""Resolve a scale label for a profile. Throws ScaleBarcodeError with a plain message."""
	profile = frappe.get_cached_doc("POS Profile", pos_profile)
	parsed = _parse_or_throw(barcode, rules_for(profile.company, pos_profile))
	item_code = _find_item(parsed)
	if not item_code:
		frappe.throw(
			_("No item has scale code {0} (barcode {1}).").format(parsed.plu, barcode), ScaleBarcodeError
		)
	item = frappe.db.get_value("Item", item_code, ["item_name", "stock_uom"], as_dict=True)
	uom = parsed.rule.uom or item.stock_uom
	factor = _uom_factor(item_code, item.stock_uom, uom)
	if factor is None:
		frappe.throw(
			_("Item {0} ({1}) is not sold in {2}, so scale barcode {3} cannot be used for it.").format(
				item_code, item.item_name, uom, barcode
			),
			ScaleBarcodeError,
		)
	rate = _unit_rate(item_code, item.stock_uom, uom, factor, profile.selling_price_list)
	if parsed.rule.value_type == "Weight":
		qty = round_to(parsed.value, 3)
		amount = round_to(qty * rate, 2)
	else:
		line = price_line(parsed.value, rate)
		if not line:
			frappe.throw(
				_("Item {0} ({1}) has no price in {2}, so the price label cannot be turned into a quantity.").format(
					item_code, item.item_name, uom
				),
				ScaleBarcodeError,
			)
		qty, rate, amount = line["qty"], line["rate"], line["amount"]
	return {
		"barcode": parsed.barcode,
		"rule": parsed.rule.name,
		"value_type": parsed.rule.value_type,
		"value": parsed.value,
		"plu": parsed.plu,
		"item_code": item_code,
		"item_name": item.item_name,
		"uom": uom,
		"conversion_factor": factor,
		"qty": qty,
		"rate": round_to(rate, 2),
		"amount": amount,
	}


@frappe.whitelist()
def resolve_scale_barcode(barcode: str, pos_profile: str) -> dict[str, Any]:
	"""Server-side resolution, same logic as the browser: {item_code, qty, amount, ...}."""
	check_pos_profile_access(pos_profile)
	return resolve(str(barcode or "").strip(), pos_profile)


def _item_plu(rule: ScaleRule, item_code: str) -> str | None:
	if rule.item_match == "Scale PLU":
		plu = frappe.db.get_value("Item", item_code, "scale_plu")
		return plu if plu and plu.isdigit() and len(plu) <= rule.item_code_length else None
	for code in frappe.get_all(
		"Item Barcode", filters={"parent": item_code, "parenttype": "Item"}, pluck="barcode", order_by="idx asc"
	):
		if code and code.isdigit() and len(code) <= rule.item_code_length:
			return code
	return None


@frappe.whitelist()
def generate_scale_barcode(rule: str, item_code: str, value: float) -> str:
	"""EAN-13 (or the rule's length) for an item and a weight or price, with a valid check digit."""
	require_pos_user()
	if not frappe.has_permission(RULE_DOCTYPE, "read", rule):
		frappe.throw(_("You cannot read scale barcode rule {0}.").format(rule), frappe.PermissionError)
	doc = frappe.get_doc(RULE_DOCTYPE, rule)
	scale_rule = ScaleRule.from_dict(doc)
	plu = _item_plu(scale_rule, item_code)
	if not plu:
		frappe.throw(
			_("Item {0} has no scale code that fits rule {1} ({2} digits).").format(
				item_code, rule, scale_rule.item_code_length
			)
		)
	try:
		return _generate(scale_rule, plu, flt(value))
	except ValueError:
		frappe.throw(
			_("Value {0} does not fit in {1} digits with {2} decimals for rule {3}.").format(
				value, scale_rule.value_length, scale_rule.decimals, rule
			)
		)


# ---------------------------------------------------------------------------
# Re-validation on the server (Sales Invoice validate hook)
# ---------------------------------------------------------------------------


def validate_sales_invoice(doc, method: str | None = None) -> None:
	"""Check every line that came from a scale label against the same rules.

	A line whose barcode no longer matches any rule (for example the rule was disabled
	after an offline sale) is accepted as the cashier saw it. A line that matches a rule
	but carries another item, weight or amount than the label says is rejected.
	"""
	if doc.get("is_return"):
		return
	lines = [row for row in doc.get("items") or [] if row.get("pos0001_scale_barcode")]
	if not lines:
		return
	rules = rules_for(doc.company, doc.get("pos_profile"))
	for row in lines:
		barcode = str(row.pos0001_scale_barcode).strip()
		parsed = parse_scale_barcode(barcode, rules)
		if parsed is None:
			continue
		if not parsed.ok:
			frappe.throw(
				_("Row {0}: barcode {1} has a wrong check digit.").format(row.idx, barcode), ScaleBarcodeError
			)
		item_code = _find_item(parsed)
		if item_code and item_code != row.item_code:
			frappe.throw(
				_("Row {0}: barcode {1} is for item {2}, not {3}.").format(row.idx, barcode, item_code, row.item_code),
				ScaleBarcodeError,
			)
		if parsed.rule.value_type == "Weight":
			_check_weight(row, parsed, barcode)
		else:
			_check_amount(row, parsed, barcode)


def _check_weight(row, parsed: ParsedBarcode, barcode: str) -> None:
	weight = round_to(parsed.value, 3)
	rule_uom = parsed.rule.uom
	stock_uom = row.get("stock_uom") or frappe.db.get_value("Item", row.item_code, "stock_uom")
	if not rule_uom or row.uom == rule_uom:
		qty = abs(flt(row.qty))
	elif stock_uom == rule_uom:
		qty = abs(flt(row.qty) * flt(row.conversion_factor or 1))
	else:
		frappe.throw(
			_("Row {0}: barcode {1} is a weight in {2}, but the line is in {3}.").format(
				row.idx, barcode, rule_uom, row.uom
			),
			ScaleBarcodeError,
		)
	if abs(qty - weight) > QTY_TOLERANCE:
		frappe.throw(
			_("Row {0}: barcode {1} says {2} {3}, but the line has {4}.").format(
				row.idx, barcode, weight, rule_uom, qty
			),
			ScaleBarcodeError,
		)


def _check_amount(row, parsed: ParsedBarcode, barcode: str) -> None:
	price = round_to(parsed.value, 2)
	# Before discounts (a promotion may lower the rate) and after them, either may match.
	amounts = [round_to(abs(flt(row.qty) * flt(r)), 2) for r in (row.get("price_list_rate"), row.rate) if r]
	amount = amounts[-1] if amounts else 0.0
	if not any(abs(a - price) <= AMOUNT_TOLERANCE for a in amounts):
		frappe.throw(
			_("Row {0}: barcode {1} says {2}, but the line amount is {3}.").format(
				row.idx, barcode, price, amount
			),
			ScaleBarcodeError,
		)
