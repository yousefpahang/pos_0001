# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Item Wizard (SPEC F13): buy in bags, sell by kg, gram or other units.

Two parts:

- Pure functions (``normalize``, ``unit_factors``, ``unit_prices``, ``payload_errors``): no
  database access, server copy of ``POS/src/plus/core/itemWizard.js``. Both copies are checked
  against ``tests/item_wizard_vectors.json``. Keep them in step.
- Database work (``validate``, ``create``, ``update_packaging``, ``import_csv``): every record
  of one item is written inside one savepoint and rolled back on any error.

Core rule: the stock unit is the weighing unit (Kg, or Litre for liquids) and prices are set
per Kg / Litre. Gram and Millilitre are entry units only: the cart turns 250 g into 0.250 Kg at
the per-Kg price. They get no Item Price and no UOM conversion row (a per-gram price such as
AED 0.0045 rounds to 0.00 at 2 decimals, and POS Next's unit picker would offer it).
"""

from __future__ import annotations

import csv
import io
import json
import re
from typing import Any

import frappe
from frappe import _
from frappe.utils import add_days, cint, flt, nowdate

from pos_next.pos_0001.scale_barcode import gs1_check_digit, has_valid_check_digit, is_digits, round_to

# Stock unit -> its entry unit (no price, converted in the cart).
ENTRY_UNITS: dict[str, dict] = {
	"Kg": {"uom": "Gram", "factor": 0.001, "symbol": "g"},
	"Litre": {"uom": "Millilitre", "factor": 0.001, "symbol": "ml"},
}
# Units created with "must be whole number" off. Every other new unit gets it on.
FRACTIONAL_UOMS = frozenset({"Kg", "Gram", "Litre", "Millilitre"})
# Units an item may be sized in without listing them (always known).
BASE_FACTORS: dict[str, dict[str, float]] = {
	"Kg": {"Gram": 0.001},
	"Litre": {"Millilitre": 0.001},
}
STEPS = ("start", "basics", "buying", "selling", "prices", "barcodes", "stock", "review")
MAX_UNITS = 8
CSV_UNIT_COLUMNS = 5
WIZARD_ROLE = "POS Item Wizard"


# --------------------------------------------------------------------------------------------
# Pure part (mirrored in plus/core/itemWizard.js)
# --------------------------------------------------------------------------------------------


def _num(value: Any) -> float | None:
	"""Number or None for empty input ("", None)."""
	if value is None or (isinstance(value, str) and not value.strip()):
		return None
	try:
		return float(value)
	except (TypeError, ValueError):
		return None


def _text(value: Any) -> str:
	return str(value).strip() if value is not None else ""


def normalize(raw: Any) -> dict:
	"""Wizard payload with every key present and numbers as numbers."""
	if isinstance(raw, str):
		raw = json.loads(raw or "{}")
	raw = dict(raw or {})
	stock_uom = _text(raw.get("stock_uom")) or "Nos"
	buying = []
	for row in raw.get("buying_units") or []:
		row = dict(row or {})
		uom = _text(row.get("uom"))
		if not uom:
			continue
		buying.append(
			{"uom": uom, "size": _num(row.get("size")), "parent_uom": _text(row.get("parent_uom")) or stock_uom}
		)
	selling = []
	for row in raw.get("selling_units") or []:
		row = dict(row or {})
		uom = _text(row.get("uom"))
		if not uom:
			continue
		priced = row.get("priced")
		selling.append(
			{
				"uom": uom,
				"size": _num(row.get("size")) if _num(row.get("size")) is not None else 1.0,
				"size_uom": _text(row.get("size_uom")) or (uom if uom == stock_uom else stock_uom),
				"priced": 1 if priced is None or cint(priced) else 0,
				"price": _num(row.get("price")),
				"barcode": _text(row.get("barcode")),
				"margin": _num(row.get("margin")),
				"remove": 1 if cint(row.get("remove")) else 0,
			}
		)
	opening = dict(raw.get("opening_stock") or {})
	return {
		"pos_profile": _text(raw.get("pos_profile")),
		"preset": _text(raw.get("preset")),
		"item_code": _text(raw.get("item_code")),
		"item_name": _text(raw.get("item_name")),
		"item_name_ar": _text(raw.get("item_name_ar")),
		"item_group": _text(raw.get("item_group")),
		"brand": _text(raw.get("brand")),
		"image": _text(raw.get("image")),
		"stock_uom": stock_uom,
		"buying_units": buying,
		"supplier": _text(raw.get("supplier")),
		"buying_price": _num(raw.get("buying_price")),
		"selling_units": selling,
		"sold_on_scale": 1 if cint(raw.get("sold_on_scale")) else 0,
		"scale_rule": _text(raw.get("scale_rule")),
		"scale_plu": _text(raw.get("scale_plu")),
		"price_mode": "margin" if raw.get("price_mode") == "margin" else "price",
		"base_price": _num(raw.get("base_price")),
		"margin_pct": _num(raw.get("margin_pct")),
		"prices_include_vat": 0 if raw.get("prices_include_vat") is not None and not cint(raw.get("prices_include_vat")) else 1,
		"item_tax_template": _text(raw.get("item_tax_template")),
		"opening_stock": {
			"qty": _num(opening.get("qty")),
			"uom": _text(opening.get("uom")),
			"warehouse": _text(opening.get("warehouse")),
			"cost": _num(opening.get("cost")),
		},
	}


def unit_factors(p: dict) -> tuple[dict[str, float], list[dict]]:
	"""Conversion of every unit to the stock unit, and the problems found.

	Buying units may be listed in any order (Carton = 12 Pack, Pack = 500 Gram).
	"""
	stock = p["stock_uom"]
	factors: dict[str, float] = {stock: 1.0, **BASE_FACTORS.get(stock, {})}
	errors: list[dict] = []
	pending = [u for u in p["buying_units"]]
	for u in pending:
		if u["uom"] == stock or u["uom"] in BASE_FACTORS.get(stock, {}):
			errors.append({"step": "buying", "code": "buying_is_stock_unit", "uom": u["uom"]})
		if u["size"] is None or u["size"] <= 0:
			errors.append({"step": "buying", "code": "size_not_positive", "uom": u["uom"]})
	pending = [u for u in pending if u["size"] and u["size"] > 0 and u["uom"] not in factors]
	while pending:
		progress = False
		for u in list(pending):
			if u["parent_uom"] in factors:
				factors[u["uom"]] = round(u["size"] * factors[u["parent_uom"]], 9)
				pending.remove(u)
				progress = True
		if not progress:
			for u in pending:
				errors.append({"step": "buying", "code": "unknown_unit", "uom": u["uom"], "parent_uom": u["parent_uom"]})
			break
	seen: set[str] = set()
	for u in p["selling_units"]:
		uom = u["uom"]
		if uom in seen:
			errors.append({"step": "selling", "code": "duplicate_unit", "uom": uom})
			continue
		seen.add(uom)
		entry = ENTRY_UNITS.get(stock)
		if entry and uom == entry["uom"]:
			errors.append({"step": "selling", "code": "entry_unit_not_sold", "uom": uom})
			continue
		if u["size"] is None or u["size"] <= 0:
			errors.append({"step": "selling", "code": "size_not_positive", "uom": uom})
			continue
		if u["size_uom"] not in factors:
			errors.append({"step": "selling", "code": "unknown_unit", "uom": uom, "parent_uom": u["size_uom"]})
			continue
		if u["size_uom"] == uom:
			if uom not in factors or abs(u["size"] - 1) > 1e-9:
				errors.append({"step": "selling", "code": "unknown_unit", "uom": uom, "parent_uom": uom})
			continue
		factor = round(u["size"] * factors[u["size_uom"]], 9)
		if uom in factors and abs(factors[uom] - factor) > 1e-9:
			errors.append({"step": "selling", "code": "conflicting_size", "uom": uom})
			continue
		factors[uom] = factor
	return factors, errors


def purchase_uom(p: dict, factors: dict[str, float] | None = None) -> str:
	"""The biggest buying unit (Carton in Carton = 12 Pack, Pack = 500 g), else the stock unit."""
	if factors is None:
		factors, _errors = unit_factors(p)
	best, best_factor = p["stock_uom"], 1.0
	for u in p["buying_units"]:
		f = factors.get(u["uom"])
		if f and f > best_factor:
			best, best_factor = u["uom"], f
	return best


def unit_prices(p: dict, vat_rate: float, profile_inclusive: int) -> dict:
	"""Prices per selling unit, cost, margin and warnings (SPEC F13 step 5).

	``price`` is in the basis the user typed (incl. VAT when ``prices_include_vat``).
	``list_rate`` is what goes into the Item Price, in the basis of the POS Profile's tax
	template (``profile_inclusive``). ``shelf_price`` is what a customer pays for one unit.
	"""
	factors, errors = unit_factors(p)
	vat = flt(vat_rate) / 100
	buy_uom = purchase_uom(p, factors)
	cost_per_stock = None
	if p["buying_price"] is not None and p["buying_price"] >= 0 and factors.get(buy_uom):
		cost_per_stock = p["buying_price"] / factors[buy_uom]
	base = p["base_price"]
	if p["price_mode"] == "margin":
		base = (
			round_to(cost_per_stock * (1 + flt(p["margin_pct"]) / 100), 2)
			if cost_per_stock is not None and p["margin_pct"] is not None
			else None
		)
	units = []
	warnings: list[dict] = []
	entry = ENTRY_UNITS.get(p["stock_uom"])
	done: set[str] = set()
	for u in p["selling_units"]:
		factor = factors.get(u["uom"])
		if factor is None or u["remove"] or u["uom"] in done or (entry and u["uom"] == entry["uom"]):
			continue
		done.add(u["uom"])
		row = {
			"uom": u["uom"],
			"factor": factor,
			"priced": u["priced"],
			"calculated": (
				round_to(cost_per_stock * factor * (1 + u["margin"] / 100), 2)
				if p["price_mode"] == "margin" and u["margin"] is not None and cost_per_stock is not None
				else round_to(base * factor, 2)
				if base is not None
				else None
			),
			"price": None,
			"overridden": 0,
			"cost": round_to(cost_per_stock * factor, 2) if cost_per_stock is not None else None,
			"margin_pct": None,
			"list_rate": None,
			"shelf_price": None,
		}
		if u["priced"]:
			if u["price"] is not None:
				row["price"] = round_to(u["price"], 2)
				row["overridden"] = 1 if row["calculated"] is None or row["price"] != row["calculated"] else 0
			else:
				row["price"] = row["calculated"]
		price = row["price"]
		if price is not None:
			net = price / (1 + vat) if p["prices_include_vat"] else price
			gross = price if p["prices_include_vat"] else price * (1 + vat)
			row["list_rate"] = round_to(gross if profile_inclusive else net, 2)
			row["shelf_price"] = row["list_rate"] if profile_inclusive else round_to(row["list_rate"] * (1 + vat), 2)
			if cost_per_stock is not None and cost_per_stock > 0:
				exact_cost = cost_per_stock * factor
				row["margin_pct"] = round_to((price - exact_cost) / exact_cost * 100, 1)
				if net < exact_cost - 0.005:
					warnings.append({"step": "prices", "code": "below_cost", "uom": u["uom"]})
			if price <= 0:
				warnings.append({"step": "prices", "code": "zero_price", "uom": u["uom"]})
			if p["prices_include_vat"] and abs(row["shelf_price"] - price) > 0.001:
				warnings.append({"step": "prices", "code": "vat_rounding", "uom": u["uom"], "shelf_price": row["shelf_price"]})
		units.append(row)
	stock_qty = None
	opening = p["opening_stock"]
	if opening["qty"]:
		f = factors.get(opening["uom"] or buy_uom)
		stock_qty = round_to(opening["qty"] * f, 6) if f else None
	return {
		"factors": factors,
		"purchase_uom": buy_uom,
		"cost_per_stock_uom": round_to(cost_per_stock, 4) if cost_per_stock is not None else None,
		"base_price": base,
		"units": units,
		"entry_unit": entry,
		"opening_stock_qty": stock_qty,
		"warnings": warnings,
		"errors": errors,
	}


def barcode_format_error(code: str) -> str | None:
	"""None when the barcode may be used. GTINs (8, 12, 13, 14 digits) need a valid check digit."""
	if not code:
		return None
	if len(code) > 40 or not re.fullmatch(r"[A-Za-z0-9\-\.]+", code):
		return "barcode_format"
	if is_digits(code) and len(code) in (8, 12, 13, 14) and not has_valid_check_digit(code):
		return "barcode_check_digit"
	return None


def payload_errors(p: dict, steps: tuple[str, ...] | None = None) -> list[dict]:
	"""Problems that need no database (mirrored in JS so the wizard can block Next at once)."""
	errors: list[dict] = []
	if not p["item_name"]:
		errors.append({"step": "basics", "code": "required", "field": "item_name"})
	if not p["item_group"]:
		errors.append({"step": "basics", "code": "required", "field": "item_group"})
	if not p["stock_uom"]:
		errors.append({"step": "basics", "code": "required", "field": "stock_uom"})
	factors, unit_errs = unit_factors(p)
	errors.extend(unit_errs)
	live = [u for u in p["selling_units"] if not u["remove"]]
	if not live:
		errors.append({"step": "selling", "code": "no_selling_unit"})
	if len(p["selling_units"]) + len(p["buying_units"]) > MAX_UNITS * 2:
		errors.append({"step": "selling", "code": "too_many_units"})
	if p["sold_on_scale"] and p["stock_uom"] not in ENTRY_UNITS:
		errors.append({"step": "selling", "code": "scale_needs_weight_unit"})
	if p["price_mode"] == "price" and p["base_price"] is None and any(
		u["priced"] and u["price"] is None for u in live
	):
		errors.append({"step": "prices", "code": "required", "field": "base_price"})
	if p["price_mode"] == "margin":
		if p["buying_price"] is None:
			errors.append({"step": "prices", "code": "margin_needs_cost"})
		if p["margin_pct"] is None:
			errors.append({"step": "prices", "code": "required", "field": "margin_pct"})
	for u in live:
		if u["price"] is not None and u["price"] < 0:
			errors.append({"step": "prices", "code": "negative_price", "uom": u["uom"]})
	if p["buying_price"] is not None and p["buying_price"] < 0:
		errors.append({"step": "buying", "code": "negative_price", "field": "buying_price"})
	seen: dict[str, str] = {}
	for u in live:
		code = u["barcode"]
		if not code:
			continue
		problem = barcode_format_error(code)
		if problem:
			errors.append({"step": "barcodes", "code": problem, "uom": u["uom"], "barcode": code})
		if code in seen:
			errors.append({"step": "barcodes", "code": "barcode_repeated", "uom": u["uom"], "barcode": code})
		seen[code] = u["uom"]
	o = p["opening_stock"]
	if o["qty"] is not None:
		if o["qty"] < 0:
			errors.append({"step": "stock", "code": "negative_qty"})
		elif o["qty"] > 0:
			if not o["warehouse"]:
				errors.append({"step": "stock", "code": "required", "field": "warehouse"})
			if (o["uom"] or purchase_uom(p)) not in factors:
				errors.append({"step": "stock", "code": "unknown_unit", "uom": o["uom"]})
			if o["cost"] is not None and o["cost"] < 0:
				errors.append({"step": "stock", "code": "negative_price", "field": "cost"})
	if steps:
		errors = [e for e in errors if e["step"] in steps]
	return errors


def preset_errors(preset: dict) -> list[str]:
	"""Messages for a POS Item Wizard Preset that the wizard could not use."""
	p = normalize(preset_payload(preset))
	_, errs = unit_factors(p)
	if not p["selling_units"]:
		errs.append({"step": "selling", "code": "no_selling_unit"})
	return [error_message(e) for e in errs]


def preset_payload(preset: dict) -> dict:
	"""Wizard payload pre-filled from a preset (doc dict or default JSON)."""
	return {
		"preset": preset.get("preset_name") or preset.get("name") or "",
		"item_group": preset.get("item_group") or "",
		"stock_uom": preset.get("stock_uom") or "Nos",
		"sold_on_scale": cint(preset.get("sold_on_scale")),
		"item_tax_template": preset.get("item_tax_template") or "",
		"prices_include_vat": 1 if preset.get("prices_include_vat") is None else cint(preset.get("prices_include_vat")),
		"buying_units": [
			{"uom": r.get("uom"), "size": r.get("size"), "parent_uom": r.get("parent_uom") or ""}
			for r in preset.get("buying_units") or []
		],
		"selling_units": [
			{
				"uom": r.get("uom"),
				"size": r.get("size") if r.get("size") not in (None, "", 0) else 1,
				"size_uom": r.get("size_uom") or "",
				"priced": 1 if r.get("priced") is None else cint(r.get("priced")),
				"margin": r.get("default_margin"),
			}
			for r in preset.get("selling_units") or []
		],
	}


def error_message(e: dict) -> str:
	"""Plain-words message for an error code (what happened and what to do)."""
	uom = e.get("uom") or ""
	field_labels = {
		"item_name": _("Item name"),
		"item_group": _("Item group"),
		"stock_uom": _("Stock unit"),
		"base_price": _("Price per stock unit"),
		"margin_pct": _("Margin %"),
		"warehouse": _("Warehouse"),
		"buying_price": _("Buying price"),
		"cost": _("Cost"),
		"item_code": _("Item code"),
	}
	code = e.get("code")
	messages = {
		"required": _("{0} is required. Fill it in to continue.").format(field_labels.get(e.get("field"), e.get("field"))),
		"size_not_positive": _("Size of {0} must be more than 0.").format(uom),
		"buying_is_stock_unit": _("{0} is the stock unit; a buying unit must be a bigger unit such as Bag.").format(uom),
		"unknown_unit": _("{0} is measured in {1}, which is not one of this item's units. Add {1} first or pick another unit.").format(uom, e.get("parent_uom") or ""),
		"duplicate_unit": _("{0} is listed twice. Keep one row per unit.").format(uom),
		"entry_unit_not_sold": _("{0} is an entry unit: the cashier types grams and the cart sells Kg. Remove the {0} row.").format(uom),
		"conflicting_size": _("{0} has two different sizes. Use the same size in buying and selling.").format(uom),
		"no_selling_unit": _("Tick at least one selling unit."),
		"too_many_units": _("Too many units. Keep at most {0} buying and {0} selling units.").format(MAX_UNITS),
		"scale_needs_weight_unit": _("Items sold on the scale need Kg or Litre as stock unit."),
		"margin_needs_cost": _("A margin needs the buying price. Enter it on the buying step or type the price."),
		"negative_price": _("Prices cannot be negative."),
		"barcode_format": _("Barcode {0} has characters a scanner cannot read. Use digits or letters only.").format(e.get("barcode")),
		"barcode_check_digit": _("Barcode {0} has a wrong check digit. Scan it again or press Generate.").format(e.get("barcode")),
		"barcode_repeated": _("Barcode {0} is used for two units. Each unit needs its own barcode.").format(e.get("barcode")),
		"barcode_in_use": _("Barcode {0} is already used by item {1}.").format(e.get("barcode"), e.get("item_code")),
		"negative_qty": _("Opening stock cannot be negative."),
		"item_exists": _("Item code {0} is already used. Pick another code.").format(e.get("item_code")),
		"item_group_missing": _("Item group {0} does not exist.").format(e.get("value")),
		"uom_missing": _("Unit {0} does not exist and cannot be created here.").format(uom),
		"brand_missing": _("Brand {0} does not exist.").format(e.get("value")),
		"supplier_missing": _("Supplier {0} does not exist.").format(e.get("value")),
		"tax_template_missing": _("VAT template {0} does not belong to this company.").format(e.get("value")),
		"warehouse_missing": _("Warehouse {0} is not a warehouse of this company.").format(e.get("value")),
		"plu_in_use": _("Scale PLU {0} is already used by item {1}.").format(e.get("value"), e.get("item_code")),
		"plu_format": _("Scale PLU {0} must be digits and fit the scale rule ({1} digits).").format(e.get("value"), e.get("length")),
		"scale_rule_missing": _("Pick the shop's scale barcode rule for items sold on the scale."),
		"below_cost": _("{0} sells below cost.").format(uom),
		"zero_price": _("{0} has price 0.").format(uom),
		"vat_rounding": _("{0}: after VAT rounding the shelf price is {1}.").format(uom, e.get("shelf_price")),
		"item_missing": _("Item {0} does not exist.").format(e.get("item_code")),
	}
	return messages.get(code, code or _("Unknown problem"))


def with_messages(errors: list[dict]) -> list[dict]:
	return [{**e, "message": error_message(e)} for e in errors]


# --------------------------------------------------------------------------------------------
# Database part
# --------------------------------------------------------------------------------------------


def profile_context(pos_profile: str) -> frappe._dict:
	"""Company, price lists, warehouse and VAT of the POS Profile the wizard works for."""
	from pos_next.pos_0001.api.labels import vat_info

	prof = frappe.db.get_value(
		"POS Profile",
		pos_profile,
		["name", "company", "selling_price_list", "warehouse", "taxes_and_charges", "currency"],
		as_dict=True,
	)
	if not prof:
		frappe.throw(_("POS Profile {0} does not exist.").format(pos_profile), frappe.DoesNotExistError)
	vat = vat_info(prof)
	buying_list = frappe.db.get_single_value("Buying Settings", "buying_price_list") or (
		"Standard Buying" if frappe.db.exists("Price List", "Standard Buying") else None
	)
	return frappe._dict(
		{
			**prof,
			"vat_rate": vat["vat_rate"],
			"prices_include_vat": vat["prices_include_vat"],
			"buying_price_list": buying_list,
		}
	)


def tax_template_rate(template: str | None, default: float) -> float:
	if not template:
		return default
	rows = frappe.get_all("Item Tax Template Detail", filters={"parent": template}, pluck="tax_rate")
	return flt(max(rows)) if rows else 0.0


def compute(p: dict, ctx: frappe._dict) -> dict:
	rate = tax_template_rate(p["item_tax_template"], ctx.vat_rate)
	out = unit_prices(p, rate, ctx.prices_include_vat)
	out["vat_rate"] = rate
	out["profile_prices_include_vat"] = ctx.prices_include_vat
	return out


def barcode_owner(code: str, exclude_item: str | None = None) -> str | None:
	ib = frappe.qb.DocType("Item Barcode")
	q = frappe.qb.from_(ib).select(ib.parent).where(ib.barcode == code).where(ib.parenttype == "Item")
	if exclude_item:
		q = q.where(ib.parent != exclude_item)
	rows = q.limit(1).run(pluck=True)
	return rows[0] if rows else None


def db_errors(p: dict, ctx: frappe._dict, existing_item: str | None = None) -> list[dict]:
	"""Problems that need the database: duplicate codes, barcodes and PLUs, missing links."""
	errors: list[dict] = []
	if not existing_item:
		if p["item_code"] and frappe.db.exists("Item", p["item_code"]):
			errors.append({"step": "basics", "code": "item_exists", "item_code": p["item_code"]})
		if p["item_group"] and not frappe.db.exists("Item Group", p["item_group"]):
			errors.append({"step": "basics", "code": "item_group_missing", "value": p["item_group"]})
		if p["brand"] and not frappe.db.exists("Brand", p["brand"]):
			errors.append({"step": "basics", "code": "brand_missing", "value": p["brand"]})
		if p["stock_uom"] and not frappe.db.exists("UOM", p["stock_uom"]):
			errors.append({"step": "basics", "code": "uom_missing", "uom": p["stock_uom"]})
	if p["supplier"] and not frappe.db.exists("Supplier", p["supplier"]):
		errors.append({"step": "buying", "code": "supplier_missing", "value": p["supplier"]})
	if p["item_tax_template"] and not frappe.db.exists(
		"Item Tax Template", {"name": p["item_tax_template"], "company": ctx.company}
	):
		errors.append({"step": "prices", "code": "tax_template_missing", "value": p["item_tax_template"]})
	for u in p["selling_units"]:
		if u["barcode"] and not u["remove"]:
			owner = barcode_owner(u["barcode"], existing_item)
			if owner:
				errors.append(
					{"step": "barcodes", "code": "barcode_in_use", "uom": u["uom"], "barcode": u["barcode"], "item_code": owner}
				)
	if p["sold_on_scale"]:
		rule = scale_rule(p, ctx)
		if not rule:
			errors.append({"step": "selling", "code": "scale_rule_missing"})
		elif p["scale_plu"]:
			length = cint(rule.item_code_length)
			if not is_digits(p["scale_plu"]) or len(p["scale_plu"]) > length:
				errors.append({"step": "selling", "code": "plu_format", "value": p["scale_plu"], "length": length})
			owner = frappe.db.get_value("Item", {"scale_plu": p["scale_plu"], "name": ["!=", existing_item or ""]})
			if owner:
				errors.append({"step": "selling", "code": "plu_in_use", "value": p["scale_plu"], "item_code": owner})
	o = p["opening_stock"]
	if o["qty"] and o["warehouse"] and not frappe.db.exists(
		"Warehouse", {"name": o["warehouse"], "company": ctx.company, "is_group": 0}
	):
		errors.append({"step": "stock", "code": "warehouse_missing", "value": o["warehouse"]})
	return errors


def validate(raw: Any, steps: tuple[str, ...] | None = None, existing_item: str | None = None) -> dict:
	p = normalize(raw)
	ctx = profile_context(p["pos_profile"])
	errors = payload_errors(p) + db_errors(p, ctx, existing_item)
	if existing_item:
		errors = [e for e in errors if e["code"] not in ("item_exists",) and e["step"] != "basics"]
	if steps:
		errors = [e for e in errors if e["step"] in steps]
	warnings = compute(p, ctx)["warnings"]
	if steps:
		warnings = [w for w in warnings if w["step"] in steps]
	return {"errors": with_messages(errors), "warnings": with_messages(warnings)}


def scale_rule(p: dict, ctx: frappe._dict) -> frappe._dict | None:
	filters = {"company": ctx.company, "enabled": 1}
	if p["scale_rule"]:
		filters["name"] = p["scale_rule"]
	rows = frappe.get_all(
		"POS Scale Barcode Rule",
		filters=filters,
		fields=["name", "item_match", "item_code_length", "uom", "value_type", "priority"],
		order_by="priority asc, name asc",
	)
	return frappe._dict(rows[0]) if rows else None


def next_scale_plu(length: int = 5, exclude: list[str] | None = None) -> str:
	"""Next free scale PLU: POS 0001 Settings ``next_scale_plu`` or one above the highest used."""
	used = {
		v
		for v in frappe.get_all("Item", filters={"scale_plu": ["is", "set"]}, pluck="scale_plu")
		if v
	}
	used |= set(exclude or [])
	numeric = [int(v) for v in used if is_digits(v)]
	start = max(cint(frappe.db.get_single_value("POS 0001 Settings", "next_scale_plu")), 1)
	candidate = max([start] + [n + 1 for n in numeric])
	limit = 10 ** max(length, 1)
	if candidate >= limit:  # wrapped: find the first hole
		candidate = next((n for n in range(1, limit) if str(n).zfill(length) not in used), None)
		if candidate is None:
			frappe.throw(_("No free scale PLU is left for {0} digits.").format(length))
	while str(candidate).zfill(length) in used:
		candidate += 1
	return str(candidate).zfill(length)


def internal_barcode_prefix() -> str:
	prefix = _text(frappe.db.get_single_value("POS 0001 Settings", "internal_barcode_prefix")) or "29"
	if not is_digits(prefix) or not 1 <= len(prefix) <= 3:
		frappe.throw(_("Internal Barcode Prefix in POS 0001 Settings must be 1 to 3 digits."))
	return prefix


def generate_internal_barcode(exclude: list[str] | None = None) -> str:
	"""Next unused internal EAN-13: prefix, running number, check digit."""
	prefix = internal_barcode_prefix()
	ib = frappe.qb.DocType("Item Barcode")
	codes = (
		frappe.qb.from_(ib)
		.select(ib.barcode)
		.where(ib.barcode.like(f"{prefix}%"))
		.run(pluck=True)
	)
	body_len = 12 - len(prefix)
	numbers = [int(c[len(prefix) : 12]) for c in codes if c and len(c) == 13 and is_digits(c)]
	n = max(numbers, default=0) + 1
	taken = set(codes) | set(exclude or [])
	while True:
		if n >= 10**body_len:
			frappe.throw(_("No internal barcode numbers are left for prefix {0}.").format(prefix))
		body = prefix + str(n).zfill(body_len)
		code = body + str(gs1_check_digit(body))
		if code not in taken:
			return code
		n += 1


def suggest_item_code(item_group: str | None, exclude: list[str] | None = None) -> str:
	"""Item code from the item group: up to 4 letters of the group, a dash and a running number.

	ERPNext has no naming series per item group. When Stock Settings names items by naming
	series this returns "" and ERPNext names the item.
	"""
	if frappe.db.get_single_value("Stock Settings", "item_naming_by") == "Naming Series":
		return ""
	letters = re.sub(r"[^A-Za-z]", "", item_group or "").upper()[:4] or "ITEM"
	prefix = f"{letters}-"
	item = frappe.qb.DocType("Item")
	codes = frappe.qb.from_(item).select(item.name).where(item.name.like(f"{prefix}%")).run(pluck=True)
	numbers = [int(c[len(prefix) :]) for c in codes if c[len(prefix) :].isdigit()]
	n = max(numbers, default=0) + 1
	taken = set(codes) | set(exclude or [])
	while f"{prefix}{n:05d}" in taken:
		n += 1
	return f"{prefix}{n:05d}"


def ensure_uoms(units: list[str]) -> list[str]:
	"""Create missing UOMs. Weight and volume units allow fractions, others are whole numbers."""
	created = []
	for uom in units:
		if uom and not frappe.db.exists("UOM", uom):
			doc = frappe.get_doc(
				{"doctype": "UOM", "uom_name": uom, "must_be_whole_number": 0 if uom in FRACTIONAL_UOMS else 1}
			)
			doc.insert(ignore_permissions=True)
			created.append(doc.name)
	return created


def _item_price(item_code: str, price_list: str, uom: str, rate: float) -> str:
	"""Insert or update the Item Price of one unit (only rows without customer, supplier or batch)."""
	name = frappe.db.get_value(
		"Item Price",
		{
			"item_code": item_code,
			"price_list": price_list,
			"uom": uom,
			"customer": ["is", "not set"],
			"supplier": ["is", "not set"],
			"batch_no": ["is", "not set"],
		},
	)
	if name:
		doc = frappe.get_doc("Item Price", name)
		doc.price_list_rate = rate
		doc.valid_upto = None
		doc.save(ignore_permissions=True)
		return doc.name
	doc = frappe.get_doc(
		{"doctype": "Item Price", "item_code": item_code, "price_list": price_list, "uom": uom, "price_list_rate": rate}
	)
	doc.insert(ignore_permissions=True)
	return doc.name


def _finish_plu(p: dict, ctx: frappe._dict, item_code: str | None = None) -> str | None:
	if not p["sold_on_scale"]:
		return None
	rule = scale_rule(p, ctx)
	if not rule:
		frappe.throw(error_message({"code": "scale_rule_missing"}))
	return p["scale_plu"] or next_scale_plu(cint(rule.item_code_length) or 5)


def _raise_errors(errors: list[dict]) -> None:
	if errors:
		frappe.throw("<br>".join(error_message(e) for e in errors), title=_("Item Wizard"))


def create(raw: Any) -> dict:
	"""Write every record of SPEC F13 for one item, all or nothing."""
	p = normalize(raw)
	ctx = profile_context(p["pos_profile"])
	if not p["item_code"]:
		p["item_code"] = suggest_item_code(p["item_group"])
	_raise_errors(payload_errors(p) + db_errors(p, ctx))
	calc = compute(p, ctx)
	_raise_errors(calc["errors"])
	savepoint = "pos0001_item_wizard"
	frappe.db.savepoint(savepoint)
	try:
		out = _create(p, ctx, calc)
	except Exception:
		frappe.db.rollback(save_point=savepoint)
		if p["item_code"]:
			frappe.clear_document_cache("Item", p["item_code"])
		raise
	frappe.db.release_savepoint(savepoint)
	return out


def _create(p: dict, ctx: frappe._dict, calc: dict) -> dict:
	created: list[dict] = []
	factors = calc["factors"]
	stock = p["stock_uom"]
	live = [u for u in p["selling_units"] if not u["remove"]]
	units_needed = [stock] + [u["uom"] for u in p["buying_units"]] + [u["uom"] for u in live]
	for uom in ensure_uoms(list(dict.fromkeys(units_needed))):
		created.append({"doctype": "UOM", "name": uom})

	plu = _finish_plu(p, ctx)
	conv_units = [u for u in dict.fromkeys([u["uom"] for u in p["buying_units"]] + [u["uom"] for u in live]) if u != stock]
	buy_uom = calc["purchase_uom"]
	sales_uom = live[0]["uom"] if live else stock
	item = frappe.get_doc(
		{
			"doctype": "Item",
			"item_code": p["item_code"] or None,
			"item_name": p["item_name"],
			"item_name_ar": p["item_name_ar"],
			"item_group": p["item_group"],
			"brand": p["brand"] or None,
			"image": p["image"] or None,
			"stock_uom": stock,
			"is_stock_item": 1,
			"is_sales_item": 1,
			"is_purchase_item": 1,
			"include_item_in_manufacturing": 0,
			"purchase_uom": buy_uom if buy_uom != stock else None,
			"sales_uom": sales_uom if sales_uom != stock else None,
			"scale_plu": plu,
			"valuation_rate": calc["cost_per_stock_uom"] or 0,
			"uoms": [{"uom": stock, "conversion_factor": 1}]
			+ [{"uom": u, "conversion_factor": factors[u]} for u in conv_units],
			"barcodes": [
				{"barcode": u["barcode"], "uom": u["uom"]} for u in live if u["barcode"]
			],
			"item_defaults": [
				{
					"company": ctx.company,
					"default_warehouse": p["opening_stock"]["warehouse"] or ctx.warehouse,
					"default_price_list": ctx.selling_price_list,
				}
			],
			"taxes": [{"item_tax_template": p["item_tax_template"]}] if p["item_tax_template"] else [],
			"supplier_items": [{"supplier": p["supplier"]}] if p["supplier"] else [],
		}
	)
	item.insert(ignore_permissions=True)
	created.append({"doctype": "Item", "name": item.name})
	for row in item.barcodes:
		created.append({"doctype": "Item Barcode", "name": row.barcode, "uom": row.uom})
	if p["supplier"]:
		created.append({"doctype": "Item Supplier", "name": p["supplier"]})

	for row in calc["units"]:
		if row["priced"] and row["list_rate"] is not None:
			name = _item_price(item.name, ctx.selling_price_list, row["uom"], row["list_rate"])
			created.append({"doctype": "Item Price", "name": name, "uom": row["uom"], "price_list": ctx.selling_price_list, "rate": row["list_rate"]})
	if p["buying_price"] is not None and ctx.buying_price_list:
		name = _item_price(item.name, ctx.buying_price_list, buy_uom, round_to(p["buying_price"], 2))
		created.append({"doctype": "Item Price", "name": name, "uom": buy_uom, "price_list": ctx.buying_price_list, "rate": round_to(p["buying_price"], 2)})

	o = p["opening_stock"]
	if o["qty"] and o["qty"] > 0:
		name = _opening_stock(item.name, p, ctx, calc)
		created.append({"doctype": "Stock Entry", "name": name, "qty": calc["opening_stock_qty"], "uom": stock})
	_bump_counters(plu)
	return {"item_code": item.name, "created": created, "scale_plu": plu}


def _opening_stock(item_code: str, p: dict, ctx: frappe._dict, calc: dict) -> str:
	"""Material Receipt in the stock unit (4 Bags of 25 Kg -> 100 Kg at the cost per Kg)."""
	o = p["opening_stock"]
	unit = o["uom"] or calc["purchase_uom"]
	factor = calc["factors"][unit]
	qty = calc["opening_stock_qty"]
	if o["cost"] is not None:
		rate = o["cost"] / factor
	else:
		rate = calc["cost_per_stock_uom"] or 0
	se = frappe.get_doc(
		{
			"doctype": "Stock Entry",
			"stock_entry_type": "Material Receipt",
			"purpose": "Material Receipt",
			"company": ctx.company,
			"remarks": _("Opening stock from the Item Wizard"),
			"items": [
				{
					"item_code": item_code,
					"qty": qty,
					"uom": p["stock_uom"],
					"stock_uom": p["stock_uom"],
					"conversion_factor": 1,
					"t_warehouse": o["warehouse"],
					"basic_rate": flt(rate, 6),
					"allow_zero_valuation_rate": 1 if not rate else 0,
				}
			],
		}
	)
	se.insert(ignore_permissions=True)
	se.submit()
	return se.name


def _bump_counters(plu: str | None) -> None:
	"""Move POS 0001 Settings ``next_scale_plu`` past the PLU just used."""
	if plu and is_digits(plu):
		current = cint(frappe.db.get_single_value("POS 0001 Settings", "next_scale_plu"))
		if int(plu) + 1 > current:
			frappe.db.set_single_value("POS 0001 Settings", "next_scale_plu", int(plu) + 1)


# --------------------------------------------------------------------------------------------
# Existing items: copy, edit packaging
# --------------------------------------------------------------------------------------------


def item_payload(item_code: str, ctx: frappe._dict) -> dict:
	"""Wizard payload of an existing item (for "Copy from existing item" and edit mode)."""
	if not frappe.db.exists("Item", item_code):
		frappe.throw(error_message({"code": "item_missing", "item_code": item_code}), frappe.DoesNotExistError)
	item = frappe.get_doc("Item", item_code)
	stock = item.stock_uom
	factors = {r.uom: flt(r.conversion_factor) for r in item.uoms}
	prices = {
		r.uom or stock: flt(r.price_list_rate)
		for r in frappe.get_all(
			"Item Price",
			filters={
				"item_code": item_code,
				"price_list": ctx.selling_price_list,
				"customer": ["is", "not set"],
				"valid_upto": ["is", "not set"],
			},
			fields=["uom", "price_list_rate"],
		)
	}
	barcodes = {}
	for r in item.barcodes:
		if not cint(r.get("pos0001_disabled")):
			barcodes.setdefault(r.uom or stock, r.barcode)
	buy_uom = item.purchase_uom or stock
	buying_price = frappe.db.get_value(
		"Item Price",
		{"item_code": item_code, "price_list": ctx.buying_price_list, "uom": buy_uom},
		"price_list_rate",
	) if ctx.buying_price_list else None
	tax = item.taxes[0].item_tax_template if item.taxes else ""
	rate = tax_template_rate(tax, ctx.vat_rate)
	# Item Prices are stored in the profile's basis; show them incl. VAT like the wizard asks.
	def shown(rate_value: float) -> float:
		if ctx.prices_include_vat:
			return round_to(rate_value, 2)
		return round_to(rate_value * (1 + rate / 100), 2)

	selling_uoms = [stock] + [u for u in factors if u != stock and (u in prices or u in barcodes)]
	if item.sales_uom and item.sales_uom in factors and item.sales_uom not in selling_uoms:
		selling_uoms.append(item.sales_uom)
	buying_units = []
	if buy_uom != stock and buy_uom in factors:
		buying_units.append({"uom": buy_uom, "size": factors[buy_uom], "parent_uom": stock})
	return {
		"item_code": item.name,
		"item_name": item.item_name,
		"item_name_ar": item.get("item_name_ar") or "",
		"item_group": item.item_group,
		"brand": item.brand or "",
		"image": item.image or "",
		"stock_uom": stock,
		"buying_units": buying_units,
		"supplier": item.supplier_items[0].supplier if item.supplier_items else "",
		"buying_price": buying_price,
		"selling_units": [
			{
				"uom": u,
				"size": factors.get(u, 1) if u != stock else 1,
				"size_uom": stock,
				"priced": 1 if u in prices or u == stock else 0,
				"price": shown(prices[u]) if u in prices else None,
				"barcode": barcodes.get(u, ""),
				"existing": 1,
			}
			for u in selling_uoms
		],
		"sold_on_scale": 1 if item.get("scale_plu") else 0,
		"scale_plu": item.get("scale_plu") or "",
		"price_mode": "price",
		"base_price": shown(prices[stock]) if stock in prices else None,
		"prices_include_vat": 1,
		"item_tax_template": tax,
		"opening_stock": {},
	}


def update_packaging(item_code: str, raw: Any) -> dict:
	"""Edit mode (steps 3-6): add units, change prices, add barcodes. Never deletes anything:
	a removed unit keeps its UOM row; its Item Price ends yesterday and its barcodes are
	marked disabled."""
	p = normalize(raw)
	ctx = profile_context(p["pos_profile"])
	if not frappe.db.exists("Item", item_code):
		frappe.throw(error_message({"code": "item_missing", "item_code": item_code}), frappe.DoesNotExistError)
	item = frappe.get_doc("Item", item_code)
	p["stock_uom"] = item.stock_uom
	p["item_name"] = p["item_name"] or item.item_name
	p["item_group"] = p["item_group"] or item.item_group
	existing = {r.uom: flt(r.conversion_factor) for r in item.uoms}
	# Units the item already has count as known sizes.
	for uom, factor in existing.items():
		if uom != item.stock_uom and uom not in [u["uom"] for u in p["buying_units"]]:
			p["buying_units"].append({"uom": uom, "size": factor, "parent_uom": item.stock_uom})
	errors = [e for e in payload_errors(p) + db_errors(p, ctx, existing_item=item_code) if e["step"] != "basics"]
	calc = compute(p, ctx)
	errors += [e for e in calc["errors"] if e["code"] != "buying_is_stock_unit"]
	_raise_errors(errors)
	savepoint = "pos0001_item_wizard_edit"
	frappe.db.savepoint(savepoint)
	try:
		out = _update(item, p, ctx, calc, existing)
	except Exception:
		frappe.db.rollback(save_point=savepoint)
		raise
	frappe.db.release_savepoint(savepoint)
	return out


def _update(item, p: dict, ctx: frappe._dict, calc: dict, existing: dict[str, float]) -> dict:
	changes: list[dict] = []
	factors = calc["factors"]
	live = [u for u in p["selling_units"] if not u["remove"]]
	for uom in ensure_uoms([u["uom"] for u in live]):
		changes.append({"action": "created", "doctype": "UOM", "name": uom})
	for u in [b["uom"] for b in p["buying_units"]] + [s["uom"] for s in live]:
		if u != item.stock_uom and u not in existing:
			item.append("uoms", {"uom": u, "conversion_factor": factors[u]})
			existing[u] = factors[u]
			changes.append({"action": "added", "doctype": "UOM Conversion Detail", "uom": u, "conversion_factor": factors[u]})
	have = {r.barcode for r in item.barcodes}
	for u in live:
		if u["barcode"] and u["barcode"] not in have:
			item.append("barcodes", {"barcode": u["barcode"], "uom": u["uom"]})
			changes.append({"action": "added", "doctype": "Item Barcode", "barcode": u["barcode"], "uom": u["uom"]})
		elif u["barcode"]:
			for r in item.barcodes:
				if r.barcode == u["barcode"] and cint(r.get("pos0001_disabled")):
					r.pos0001_disabled = 0
					changes.append({"action": "enabled", "doctype": "Item Barcode", "barcode": r.barcode, "uom": r.uom})
	removed = [u["uom"] for u in p["selling_units"] if u["remove"]]
	for r in item.barcodes:
		if (r.uom or item.stock_uom) in removed and not cint(r.get("pos0001_disabled")):
			r.pos0001_disabled = 1
			changes.append({"action": "disabled", "doctype": "Item Barcode", "barcode": r.barcode, "uom": r.uom})
	if p["sold_on_scale"] and not item.get("scale_plu"):
		item.scale_plu = _finish_plu(p, ctx)
		changes.append({"action": "set", "doctype": "Item", "field": "scale_plu", "value": item.scale_plu})
	item.save(ignore_permissions=True)
	for row in calc["units"]:
		if not row["priced"] or row["list_rate"] is None:
			continue
		current = frappe.db.get_value(
			"Item Price",
			{"item_code": item.name, "price_list": ctx.selling_price_list, "uom": row["uom"], "customer": ["is", "not set"]},
			["name", "price_list_rate", "valid_upto"],
			as_dict=True,
		)
		if current and flt(current.price_list_rate) == row["list_rate"] and not current.valid_upto:
			continue
		name = _item_price(item.name, ctx.selling_price_list, row["uom"], row["list_rate"])
		changes.append({"action": "price", "doctype": "Item Price", "name": name, "uom": row["uom"], "rate": row["list_rate"]})
	yesterday = add_days(nowdate(), -1)
	for uom in removed:
		for name in frappe.get_all(
			"Item Price",
			filters={"item_code": item.name, "price_list": ctx.selling_price_list, "uom": uom, "valid_upto": ["is", "not set"]},
			pluck="name",
		):
			doc = frappe.get_doc("Item Price", name)
			doc.valid_from = min(str(doc.valid_from or yesterday), yesterday)
			doc.valid_upto = yesterday
			doc.save(ignore_permissions=True)
			changes.append({"action": "ended", "doctype": "Item Price", "name": name, "uom": uom, "valid_upto": yesterday})
	_bump_counters(item.get("scale_plu"))
	return {"item_code": item.name, "changes": changes}


# --------------------------------------------------------------------------------------------
# CSV import (same validation and create code as the wizard)
# --------------------------------------------------------------------------------------------

CSV_COLUMNS = [
	"item_code", "item_name", "item_name_ar", "item_group", "brand", "stock_uom",
	"buy_uom", "buy_size", "buy_size_uom", "buy_inner_uom", "buy_inner_size", "buy_inner_size_uom",
	"supplier", "buying_price", "price_per_stock_uom", "margin_pct", "prices_include_vat",
	"item_tax_template", "sold_on_scale",
] + [f"unit{i}_{k}" for i in range(1, CSV_UNIT_COLUMNS + 1) for k in ("uom", "size", "size_uom", "price", "barcode")] + [
	"opening_qty", "opening_uom", "warehouse", "opening_cost",
]

CSV_EXAMPLE = {
	"item_name": "Basmati Rice", "item_name_ar": "أرز بسمتي", "item_group": "Groceries", "stock_uom": "Kg",
	"buy_uom": "Bag", "buy_size": "25", "buy_size_uom": "Kg", "buying_price": "75",
	"price_per_stock_uom": "4.50", "prices_include_vat": "1", "sold_on_scale": "1",
	"unit1_uom": "Kg", "unit1_size": "1", "unit1_barcode": "generate",
	"unit2_uom": "Pack", "unit2_size": "500", "unit2_size_uom": "Gram", "unit2_price": "2.50", "unit2_barcode": "generate",
	"unit3_uom": "Bag", "unit3_size": "1", "unit3_size_uom": "Bag", "unit3_price": "99", "unit3_barcode": "generate",
	"opening_qty": "4", "opening_uom": "Bag", "opening_cost": "75",
}


def csv_template() -> str:
	out = io.StringIO()
	writer = csv.DictWriter(out, fieldnames=CSV_COLUMNS, lineterminator="\n")
	writer.writeheader()
	writer.writerow({k: CSV_EXAMPLE.get(k, "") for k in CSV_COLUMNS})
	return out.getvalue()


def csv_row_payload(row: dict, pos_profile: str) -> dict:
	g = lambda k: _text(row.get(k))  # noqa: E731
	buying = []
	if g("buy_uom"):
		buying.append({"uom": g("buy_uom"), "size": g("buy_size"), "parent_uom": g("buy_size_uom")})
	if g("buy_inner_uom"):
		buying.append({"uom": g("buy_inner_uom"), "size": g("buy_inner_size"), "parent_uom": g("buy_inner_size_uom")})
	selling = []
	for i in range(1, CSV_UNIT_COLUMNS + 1):
		uom = g(f"unit{i}_uom")
		if uom:
			selling.append(
				{
					"uom": uom,
					"size": g(f"unit{i}_size") or 1,
					"size_uom": g(f"unit{i}_size_uom"),
					"price": g(f"unit{i}_price"),
					"barcode": g(f"unit{i}_barcode"),
				}
			)
	margin = g("margin_pct")
	return {
		"pos_profile": pos_profile,
		"item_code": g("item_code"),
		"item_name": g("item_name"),
		"item_name_ar": g("item_name_ar"),
		"item_group": g("item_group"),
		"brand": g("brand"),
		"stock_uom": g("stock_uom"),
		"buying_units": buying,
		"supplier": g("supplier"),
		"buying_price": g("buying_price"),
		"selling_units": selling,
		"sold_on_scale": cint(g("sold_on_scale")),
		"price_mode": "margin" if margin and not g("price_per_stock_uom") else "price",
		"base_price": g("price_per_stock_uom"),
		"margin_pct": margin,
		"prices_include_vat": g("prices_include_vat") if g("prices_include_vat") != "" else 1,
		"item_tax_template": g("item_tax_template"),
		"opening_stock": {"qty": g("opening_qty"), "uom": g("opening_uom"), "warehouse": g("warehouse"), "cost": g("opening_cost")},
	}


def import_csv(content: str, pos_profile: str) -> list[dict]:
	"""One result per data row. Each row is created on its own (one bad row does not stop the
	others) through ``create``."""
	ctx = profile_context(pos_profile)
	reader = csv.DictReader(io.StringIO(content.lstrip("﻿")))
	missing = [c for c in ("item_name", "item_group", "stock_uom") if c not in (reader.fieldnames or [])]
	if missing:
		frappe.throw(_("The CSV file has no column {0}. Download the template and keep its first row.").format(", ".join(missing)))
	results = []
	reserved: list[str] = []
	for index, row in enumerate(reader, start=2):
		if not any(_text(v) for v in row.values()):
			continue
		payload = csv_row_payload(row, pos_profile)
		for unit in payload["selling_units"]:
			if unit["barcode"].lower() == "generate":
				unit["barcode"] = generate_internal_barcode(reserved)
				reserved.append(unit["barcode"])
		if not payload["opening_stock"]["warehouse"]:
			payload["opening_stock"]["warehouse"] = ctx.warehouse
		try:
			out = create(payload)
			results.append({"row": index, "status": "Created", "item_code": out["item_code"], "errors": []})
		except frappe.ValidationError as exc:
			frappe.local.message_log = []
			results.append(
				{"row": index, "status": "Failed", "item_code": payload["item_code"], "errors": [str(exc).replace("<br>", "\n")]}
			)
	return results
