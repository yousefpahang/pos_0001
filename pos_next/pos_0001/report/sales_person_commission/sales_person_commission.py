# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Sales Person Commission (SPEC F6).

One row per sales person over submitted Sales Invoices in a date range, from the
invoices' Sales Team table:

- Invoices: sales (not returns) the person is on.
- Net Sales: their share (allocated amount) of the invoices' commissionable net amount,
  excluding VAT, in company currency.
- Returns: their share of credit notes in the range (negative).
- Net After Returns: Net Sales + Returns.
- Commission: sum of ERPNext's incentives on those rows (share x the commission rate
  stored on the row when the invoice was saved), so it matches ERPNext's own figures
  even if a rate changed during the period.
"""

from __future__ import annotations

from typing import Any

import frappe
from frappe import _
from frappe.query_builder import Case
from frappe.query_builder.functions import Count, Sum
from frappe.utils import flt, getdate


def execute(filters: dict | None = None) -> tuple[list[dict], list[dict]]:
	filters = frappe._dict(filters or {})
	if not filters.get("from_date") or not filters.get("to_date"):
		frappe.throw(_("Choose a From Date and a To Date."))
	rows = get_rows(
		from_date=filters.from_date,
		to_date=filters.to_date,
		company=filters.get("company"),
		pos_profile=filters.get("pos_profile"),
		sales_person=filters.get("sales_person"),
	)
	return get_columns(), rows


def get_columns() -> list[dict]:
	return [
		{
			"fieldname": "sales_person",
			"label": _("Sales Person"),
			"fieldtype": "Link",
			"options": "Sales Person",
			"width": 180,
		},
		{"fieldname": "invoices", "label": _("Invoices"), "fieldtype": "Int", "width": 90},
		{"fieldname": "net_sales", "label": _("Net Sales"), "fieldtype": "Currency", "width": 130},
		{"fieldname": "return_count", "label": _("Return Invoices"), "fieldtype": "Int", "width": 110},
		{"fieldname": "returns", "label": _("Returns"), "fieldtype": "Currency", "width": 120},
		{
			"fieldname": "net_after_returns",
			"label": _("Net After Returns"),
			"fieldtype": "Currency",
			"width": 140,
		},
		{"fieldname": "commission_rate", "label": _("Commission Rate (%)"), "fieldtype": "Float", "width": 140},
		{"fieldname": "commission", "label": _("Commission"), "fieldtype": "Currency", "width": 120},
	]


def get_rows(
	from_date: Any,
	to_date: Any,
	company: str | None = None,
	pos_profile: str | None = None,
	sales_person: str | None = None,
	allowed_profiles: list[str] | None = None,
) -> list[dict]:
	"""Aggregated commission rows. ``allowed_profiles`` limits rows to those POS Profiles."""
	if getdate(from_date) > getdate(to_date):
		frappe.throw(_("From Date must be before To Date."))
	if allowed_profiles is not None and not allowed_profiles:
		return []

	si = frappe.qb.DocType("Sales Invoice")
	st = frappe.qb.DocType("Sales Team")
	sale = si.is_return == 0
	ret = si.is_return == 1
	query = (
		frappe.qb.from_(st)
		.join(si)
		.on(st.parent == si.name)
		.select(
			st.sales_person,
			Count(Case().when(sale, si.name)).distinct().as_("invoices"),
			Sum(Case().when(sale, st.allocated_amount).else_(0)).as_("net_sales"),
			Count(Case().when(ret, si.name)).distinct().as_("return_count"),
			Sum(Case().when(ret, st.allocated_amount).else_(0)).as_("returns"),
			Sum(st.incentives).as_("commission"),
		)
		.where(st.parenttype == "Sales Invoice")
		.where(si.docstatus == 1)
		.where(si.posting_date[getdate(from_date) : getdate(to_date)])
		.groupby(st.sales_person)
		.orderby(st.sales_person)
	)
	if company:
		query = query.where(si.company == company)
	if pos_profile:
		query = query.where(si.pos_profile == pos_profile)
	if allowed_profiles is not None:
		query = query.where(si.pos_profile.isin(allowed_profiles))
	if sales_person:
		query = query.where(st.sales_person == sales_person)

	data = query.run(as_dict=True)
	rates = dict(
		frappe.get_all(
			"Sales Person",
			filters={"name": ["in", [row.sales_person for row in data] or [""]]},
			fields=["name", "commission_rate"],
			as_list=True,
		)
	)
	rows = []
	for row in data:
		net_sales = flt(row.net_sales, 2)
		returns = flt(row.returns, 2)
		rows.append(
			{
				"sales_person": row.sales_person,
				"invoices": int(row.invoices or 0),
				"net_sales": net_sales,
				"return_count": int(row.return_count or 0),
				"returns": returns,
				"net_after_returns": flt(net_sales + returns, 2),
				"commission_rate": flt(rates.get(row.sales_person)),
				"commission": flt(row.commission, 2),
			}
		)
	return rows
