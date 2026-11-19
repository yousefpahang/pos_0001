# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Receipt printing support (SPEC F9).

Receipts are built and printed in the browser (works offline). The server only provides:

- ``get_printing_cache``: the till's receipt printer (POS Printer Profile), company details
  for the receipt header, footer and logo, cash modes (drawer kick) and whether the user may
  use No Sale. Stored in the browser and refreshed while online.
- ``get_receipt_data``: receipt JSON of a submitted invoice, for reprints.
- ``log_drawer_events``: No Sale drawer openings, uploaded by the till (also after offline).

QZ Tray signing stays POS Next's (``pos_next.api.qz``, key files in the site's private
folder, DECISIONS.md item 7).
"""

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, flt, get_datetime, now_datetime

from pos_next.pos_0001.permissions import check_pos_profile_access, is_pos_manager, require_pos_user
from pos_next.pos_0001.uae import TITLE_MODES, line_vat_rates, settings_symbol_mode

PRINTER = "POS Printer Profile"
DRAWER_EVENT = "POS Drawer Event"
DEVICE = "POS Device"
DEFAULT_PRINT_FORMAT = "UAE Tax Invoice 80mm"  # pos_0001 print format (SPEC section 7)
POS_NEXT_PRINT_FORMAT = "POS Next Receipt"
MAX_EVENTS = 200
PRINTER_FIELDS = (
	"name",
	"printer_name",
	"purpose",
	"enabled",
	"company",
	"connection",
	"qz_printer",
	"network_host",
	"network_port",
	"print_mode",
	"paper_width_mm",
	"dpi",
	"characters_per_line",
	"auto_cut",
	"copies",
	"drawer_kick",
	"receipt_barcode",
	"print_format",
	"label_language",
)


def _parse_json(value: Any) -> Any:
	if isinstance(value, str):
		return json.loads(value) if value else None
	return value


def printer_dict(name: str | None) -> dict | None:
	"""A POS Printer Profile as the browser uses it, or None if missing or disabled."""
	if not name:
		return None
	row = frappe.db.get_value(PRINTER, name, list(PRINTER_FIELDS), as_dict=True)
	if not row or not cint(row.enabled):
		return None
	return {
		**row,
		"enabled": 1,
		"network_port": cint(row.network_port) or 9100,
		"paper_width_mm": cint(row.paper_width_mm) or 80,
		"dpi": cint(row.dpi) or 203,
		"characters_per_line": cint(row.characters_per_line),
		"auto_cut": cint(row.auto_cut),
		"copies": min(max(cint(row.copies) or 1, 1), 3),
		"drawer_kick": cint(row.drawer_kick),
		"receipt_barcode": row.receipt_barcode or "Code128",
		"print_mode": row.print_mode or "raster",
	}


def default_print_format() -> str:
	"""The UAE tax invoice when it is installed, else POS Next's receipt."""
	if frappe.db.exists("Print Format", DEFAULT_PRINT_FORMAT):
		return DEFAULT_PRINT_FORMAT
	return POS_NEXT_PRINT_FORMAT


def rounding_rule(profile: Any) -> dict:
	"""How ERPNext rounds this profile's POS invoices, so receipts printed before the server
	answers show the same rounded total (``plus/core/rounding.js``). POS Next sets the
	invoice's Disable Rounded Total from the profile (default on when unset)."""
	disabled = profile.get("disable_rounded_total")
	return {
		"disabled": 1 if disabled is None else cint(disabled),
		"fraction": flt(
			frappe.db.get_value("Currency", profile.get("currency"), "smallest_currency_fraction_value")
		)
		if profile.get("currency")
		else 0,
		"method": frappe.get_system_settings("rounding_method") or "Banker's Rounding (legacy)",
	}


def template_vat_rate(template: str | None) -> float | None:
	"""VAT % of a Sales Taxes and Charges Template ("On Net Total" rows), for offline
	receipts, which carry only the VAT total. None without a template."""
	if not template:
		return None
	rates = frappe.get_all(
		"Sales Taxes and Charges",
		filters={"parent": template, "parenttype": "Sales Taxes and Charges Template", "charge_type": "On Net Total"},
		pluck="rate",
	)
	return round(sum(flt(r) for r in rates), 2) if rates else None


def resolve_printers(pos_profile: str | None, device_id: str | None) -> dict[str, dict | None]:
	"""Receipt and label printer for a till: the POS Device's own, else the POS Profile's."""
	receipt = label = None
	if device_id and frappe.db.exists(DEVICE, device_id):
		receipt, label = frappe.db.get_value(DEVICE, device_id, ["receipt_printer", "label_printer"])
	if pos_profile and (not receipt or not label):
		profile_receipt, profile_label = frappe.db.get_value(
			"POS Profile", pos_profile, ["pos0001_receipt_printer", "pos0001_label_printer"]
		) or (None, None)
		receipt = receipt or profile_receipt
		label = label or profile_label
	return {"receipt": printer_dict(receipt), "label": printer_dict(label)}


def can_open_drawer(pos_profile: str | None, user: str | None = None) -> bool:
	"""No Sale: POS managers, or users with the profile's No Sale role."""
	user = user or frappe.session.user
	if is_pos_manager(user):
		return True
	if not pos_profile:
		return False
	role = frappe.db.get_value("POS Profile", pos_profile, "pos0001_no_sale_role")
	return bool(role and role in frappe.get_roles(user))


def cash_modes(pos_profile: str) -> list[str]:
	"""Modes of payment of type Cash on the profile, plus POS Next's cash mode field."""
	modes = frappe.get_all("POS Payment Method", filters={"parent": pos_profile}, pluck="mode_of_payment")
	cash = set()
	if modes:
		cash.update(frappe.get_all("Mode of Payment", filters={"name": ["in", modes], "type": "Cash"}, pluck="name"))
	if frappe.db.has_column("POS Profile", "posa_cash_mode_of_payment"):
		extra = frappe.db.get_value("POS Profile", pos_profile, "posa_cash_mode_of_payment")
		if extra:
			cash.add(extra)
	return sorted(cash)


def company_details(company: str | None) -> dict:
	if not company:
		return {}
	from frappe.contacts.doctype.address.address import get_company_address

	row = frappe.db.get_value("Company", company, ["company_name", "tax_id", "phone_no"], as_dict=True) or {}
	address = get_company_address(company).get("company_address_display") or ""
	address = " ".join(
		part.strip() for part in frappe.utils.strip_html(address.replace("<br>", ", ")).split() if part.strip()
	)
	return {
		"name": row.get("company_name") or company,
		"tax_id": row.get("tax_id") or "",
		"phone": row.get("phone_no") or "",
		"address": address.strip(", "),
	}


@frappe.whitelist()
def get_printing_cache(pos_profile: str, device_id: str | None = None) -> dict:
	"""Everything the till needs to print receipts offline."""
	check_pos_profile_access(pos_profile)
	profile = frappe.db.get_value(
		"POS Profile",
		pos_profile,
		[
			"company",
			"print_format",
			"pos0001_receipt_template",
			"pos0001_receipt_footer",
			"pos0001_receipt_logo",
			"pos0001_invoice_title",
			"taxes_and_charges",
			"currency",
			"disable_rounded_total",
		],
		as_dict=True,
	)
	printers = resolve_printers(pos_profile, device_id)
	return {
		"pos_profile": pos_profile,
		"printer": printers["receipt"],
		"label_printer": printers["label"],
		"company": company_details(profile.company),
		"footer": profile.pos0001_receipt_footer or "",
		"logo_url": profile.pos0001_receipt_logo or None,
		"print_format": profile.pos0001_receipt_template or profile.print_format or default_print_format(),
		"invoice_title": profile.pos0001_invoice_title if profile.pos0001_invoice_title in TITLE_MODES else "Tax Invoice",
		"currency_symbol": settings_symbol_mode(),
		"vat_rate": template_vat_rate(profile.taxes_and_charges),
		"rounding": rounding_rule(profile),
		"cash_modes": cash_modes(pos_profile),
		"can_no_sale": can_open_drawer(pos_profile),
		"cashier": frappe.utils.get_fullname(frappe.session.user),
	}


@frappe.whitelist()
def get_receipt_data(invoice: str) -> dict:
	"""Receipt JSON of a Sales Invoice (reprints and online sales)."""
	require_pos_user()
	if not invoice or not frappe.db.exists("Sales Invoice", invoice):
		frappe.throw(_("Invoice {0} was not found.").format(invoice or ""), frappe.DoesNotExistError)
	doc = frappe.get_doc("Sales Invoice", invoice)
	if doc.pos_profile:
		check_pos_profile_access(doc.pos_profile)
	elif not frappe.has_permission("Sales Invoice", "read", doc):
		frappe.throw(_("You don't have access to invoice {0}.").format(invoice), frappe.PermissionError)
	return receipt_for(doc)


def receipt_for_submitted(invoice_name: str) -> dict | None:
	"""Receipt JSON returned with POS Next's online ``submit_invoice`` answer (SPEC section 6).

	The till then prints at once, without a second request for ``get_receipt_data``. The
	data is read back from the database inside the submit transaction, so it holds
	ERPNext's final VAT and rounding (Phase 4 decision 8). The caller already checked the
	POS Profile access. A failure here never fails the sale: the till falls back to
	``get_receipt_data``.
	"""
	try:
		return receipt_for(frappe.get_doc("Sales Invoice", invoice_name))
	except Exception:
		frappe.log_error(title=f"POS receipt data failed: {invoice_name}")
		return None


def receipt_for(doc: Any) -> dict:
	"""Receipt JSON of a loaded Sales Invoice (no access check)."""
	codes = list({row.item_code for row in doc.items if row.item_code})
	arabic = {}
	if codes and frappe.db.has_column("Item", "item_name_ar"):
		arabic = dict(
			frappe.get_all("Item", filters={"name": ["in", codes]}, fields=["name", "item_name_ar"], as_list=True)
		)
	mode_types = {}
	modes = [p.mode_of_payment for p in doc.payments]
	if modes:
		mode_types = dict(
			frappe.get_all("Mode of Payment", filters={"name": ["in", modes]}, fields=["name", "type"], as_list=True)
		)
	offline_id = frappe.db.get_value("Offline Invoice Sync", {"sales_invoice": doc.name}, "offline_id")
	vat_rates = line_vat_rates(doc)
	return {
		"name": doc.name,
		"doctype": "Sales Invoice",
		"docstatus": doc.docstatus,
		"company": doc.company,
		"company_tax_id": doc.get("company_tax_id") or "",
		"posting_date": str(doc.posting_date),
		"posting_time": str(doc.posting_time or ""),
		"pos_profile": doc.pos_profile,
		"cashier": frappe.utils.get_fullname(doc.owner),
		"customer": doc.customer,
		"customer_name": doc.customer_name,
		"customer_tax_id": doc.get("tax_id") or "",
		"currency": doc.currency,
		"is_return": cint(doc.is_return),
		"return_against": doc.return_against or "",
		"items": [
			{
				"item_code": row.item_code,
				"item_name": row.item_name,
				"item_name_ar": arabic.get(row.item_code) or None,
				"qty": flt(row.qty),
				"uom": row.uom,
				"rate": flt(row.rate),
				"amount": flt(row.amount),
				"discount_amount": flt(row.discount_amount),
				"vat_rate": rate,
			}
			for row, rate in zip(doc.items, vat_rates, strict=False)
		],
		"net_total": flt(doc.net_total),
		"discount_amount": flt(doc.discount_amount),
		"taxes": [
			{
				"description": row.description,
				# A rate only for "On Net Total" rows: the receipt prints them as "VAT 5%".
				"rate": flt(row.rate) if row.charge_type == "On Net Total" else None,
				"tax_amount": flt(row.tax_amount_after_discount_amount or row.tax_amount),
			}
			for row in doc.taxes
		],
		"total_taxes_and_charges": flt(doc.total_taxes_and_charges),
		"grand_total": flt(doc.grand_total),
		"rounding_adjustment": flt(doc.rounding_adjustment),
		"rounded_total": 0 if cint(doc.disable_rounded_total) else flt(doc.rounded_total),
		"payments": [
			{"mode_of_payment": p.mode_of_payment, "amount": flt(p.amount), "type": mode_types.get(p.mode_of_payment)}
			for p in doc.payments
		],
		"paid_amount": flt(doc.paid_amount),
		"change_amount": flt(doc.change_amount),
		"outstanding_amount": flt(doc.outstanding_amount),
		"sales_team": [
			{"sales_person": row.sales_person, "allocated_percentage": flt(row.allocated_percentage)}
			for row in doc.get("sales_team") or []
		],
		"offline_id": offline_id,
	}


def _event_time(value: Any):
	if value in (None, ""):
		return now_datetime()
	if isinstance(value, int | float):
		# Browser milliseconds since epoch (UTC) -> system time zone.
		from datetime import datetime, timezone

		from frappe.utils import convert_utc_to_system_timezone

		utc = datetime.fromtimestamp(float(value) / 1000, tz=timezone.utc).replace(tzinfo=None)
		return convert_utc_to_system_timezone(utc).replace(tzinfo=None)
	return get_datetime(value)


@frappe.whitelist(methods=["POST"])
def log_drawer_events(events: Any) -> list[dict]:
	"""Store No Sale drawer openings. Idempotent per ``event_id``.

	The drawer was already opened by the till (possibly offline, after checking the
	cached permission), so an event is never refused for a missing role: it is stored
	with ``permitted = 0`` instead. Profiles the user may not access are refused.
	"""
	require_pos_user()
	events = _parse_json(events) or []
	if not isinstance(events, list):
		frappe.throw(_("Events must be a list."))
	if len(events) > MAX_EVENTS:
		frappe.throw(_("Send at most {0} events at a time.").format(MAX_EVENTS))
	results = []
	for event in events:
		event = frappe._dict(event or {})
		event_id = (event.event_id or "").strip()
		if not event_id or len(event_id) > 64:
			results.append({"event_id": event_id, "status": "Rejected", "error": _("Event ID is missing.")})
			continue
		check_pos_profile_access(event.pos_profile)
		if frappe.db.exists(DRAWER_EVENT, event_id):
			results.append({"event_id": event_id, "status": "Stored"})
			continue
		device = event.device_id if event.device_id and frappe.db.exists(DEVICE, event.device_id) else None
		shift = (
			event.pos_opening_shift
			if event.pos_opening_shift and frappe.db.exists("POS Opening Shift", event.pos_opening_shift)
			else None
		)
		doc = frappe.get_doc(
			{
				"doctype": DRAWER_EVENT,
				"event_id": event_id,
				"event_type": "No Sale",
				"opened_at": _event_time(event.opened_at),
				"user": frappe.session.user,
				"permitted": 1 if can_open_drawer(event.pos_profile) else 0,
				"pos_profile": event.pos_profile,
				"pos_device": device,
				"pos_opening_shift": shift,
				"was_offline": cint(event.was_offline),
				"reason": (event.reason or "")[:500],
			}
		)
		doc.flags.ignore_permissions = True
		try:
			doc.insert()
		except frappe.DuplicateEntryError:
			pass
		results.append({"event_id": event_id, "status": "Stored", "permitted": doc.permitted})
	return results
