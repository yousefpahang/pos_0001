# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Sales person modes, default per cashier, barcode lookup and Sales Team checks (SPEC F6).

The POS keeps POS Next's sales person code path (payment dialog, ``sales_team`` sent to
``submit_invoice``). This module adds:

- ``get_sales_person_cache``: effective mode, default sales person of the user and the
  sales person list with barcodes, stored in the browser so the picker works offline.
- Sales Invoice ``before_validate``: fills each Sales Team row's commission rate from the
  Sales Person (POS Next leaves it empty, so ERPNext computed no incentives) and fixes
  rounding drift in the split so it totals exactly 100 %.
- Sales Invoice ``validate``: a profile set to Mandatory cannot submit a POS sale without
  a sales person (online sales only; queued offline invoices were checked by the till
  and are never rejected for this, see "Decisions to review" in PROGRESS.md Phase 3).
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, flt

from pos_next.pos_0001.permissions import check_pos_profile_access
from pos_next.pos_0001.sales_person import SalesPersonMode, normalize_allocation, resolve_mode

OFFLINE_FLAG = "pos0001_offline_submit"


def mode_for_profile(pos_profile: str | None) -> SalesPersonMode:
	if not pos_profile:
		return resolve_mode(None, None)
	profile_mode = frappe.db.get_value("POS Profile", pos_profile, "pos0001_sales_person_mode")
	pos_next_mode = frappe.db.get_value("POS Settings", {"pos_profile": pos_profile}, "enable_sales_persons")
	return resolve_mode(profile_mode, pos_next_mode)


def sales_persons_for(pos_profile: str | None) -> list[dict]:
	"""Enabled, non-group sales persons (same filter as POS Next's get_sales_persons)."""
	filters: dict[str, Any] = {"enabled": 1, "is_group": 0}
	if pos_profile and frappe.db.has_column("Sales Person", "company"):
		company = frappe.db.get_value("POS Profile", pos_profile, "company")
		if company:
			filters["company"] = company
	return frappe.get_all(
		"Sales Person",
		filters=filters,
		fields=["name", "sales_person_name", "commission_rate", "employee", "sales_person_barcode"],
		order_by="sales_person_name asc",
	)


@frappe.whitelist()
def get_sales_person_cache(pos_profile: str) -> dict:
	"""Everything the till needs to pick sales persons offline."""
	check_pos_profile_access(pos_profile)
	mode = mode_for_profile(pos_profile)
	persons = sales_persons_for(pos_profile) if mode.enabled else []
	names = {p.name for p in persons}
	default = frappe.db.get_value("User", frappe.session.user, "pos0001_default_sales_person")
	return {
		**mode.as_dict(),
		"pos_profile": pos_profile,
		"default_sales_person": default if default in names else None,
		"sales_persons": [
			{
				"name": p.name,
				"sales_person_name": p.sales_person_name or p.name,
				"commission_rate": flt(p.commission_rate),
				"employee": p.employee,
				"barcode": p.sales_person_barcode or None,
			}
			for p in persons
		],
	}


@frappe.whitelist()
def find_by_barcode(barcode: str, pos_profile: str) -> dict | None:
	"""Sales person whose ``sales_person_barcode`` is the scanned code, or None."""
	check_pos_profile_access(pos_profile)
	barcode = (barcode or "").strip()
	if not barcode:
		return None
	for person in sales_persons_for(pos_profile):
		if person.sales_person_barcode == barcode:
			return {
				"name": person.name,
				"sales_person_name": person.sales_person_name or person.name,
				"commission_rate": flt(person.commission_rate),
			}
	return None


# ---------------------------------------------------------------------------
# Sales Invoice hooks
# ---------------------------------------------------------------------------


def prepare_sales_team(doc, method: str | None = None) -> None:
	"""before_validate: tidy the Sales Team of POS invoices before ERPNext checks it."""
	if not cint(doc.get("is_pos")) or not doc.get("sales_team"):
		return
	rows = [row for row in doc.sales_team if row.sales_person]
	if len(rows) != len(doc.sales_team):
		doc.set("sales_team", rows)
		for idx, row in enumerate(rows, start=1):
			row.idx = idx
	if not rows:
		return
	rates = dict(
		frappe.get_all(
			"Sales Person",
			filters={"name": ["in", [row.sales_person for row in rows]]},
			fields=["name", "commission_rate"],
			as_list=True,
		)
	)
	for row in rows:
		if row.commission_rate in (None, ""):
			row.commission_rate = flt(rates.get(row.sales_person))
	for row, share in zip(rows, normalize_allocation([flt(row.allocated_percentage) for row in rows])):
		row.allocated_percentage = share


def validate_sales_team(doc, method: str | None = None) -> None:
	"""validate: a Mandatory profile needs a sales person on every POS sale."""
	if not cint(doc.get("is_pos")) or cint(doc.get("is_return")):
		return
	if getattr(doc, "_action", None) != "submit" or frappe.flags.get(OFFLINE_FLAG):
		return
	# Only an explicit Mandatory on the POS Profile is enforced here. POS Next's own
	# "mandatory when enabled" stays a till-side rule, as it was before Phase 3.
	pos_profile = doc.get("pos_profile")
	explicit = pos_profile and frappe.db.get_value("POS Profile", pos_profile, "pos0001_sales_person_mode")
	if explicit == "Mandatory" and not any(row.sales_person for row in doc.get("sales_team") or []):
		frappe.throw(
			_("Choose a sales person for this sale. POS Profile {0} requires one.").format(doc.pos_profile),
			title=_("Sales person required"),
		)
