# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Favourites quick grid (SPEC section 6): the top sellers of a POS Profile.

The till caches the list (IndexedDB) and shows it as one-tap buttons when the search box is
empty; the item details come from the till's own item cache, so it works offline.
"""

from __future__ import annotations

import frappe
from frappe.query_builder.functions import Count, Sum
from frappe.utils import add_days, cint, nowdate

from pos_next.pos_0001.permissions import check_pos_profile_access

DEFAULT_LIMIT = 30
DEFAULT_DAYS = 90
MAX_LIMIT = 60


def top_sellers(pos_profile: str, limit: int = DEFAULT_LIMIT, days: int = DEFAULT_DAYS) -> list[dict]:
	"""Items sold most (by stock quantity) on submitted, non-return sales of the profile."""
	si = frappe.qb.DocType("Sales Invoice")
	sii = frappe.qb.DocType("Sales Invoice Item")
	item = frappe.qb.DocType("Item")
	qty = Sum(sii.stock_qty).as_("qty")
	return (
		frappe.qb.from_(sii)
		.join(si)
		.on(si.name == sii.parent)
		.join(item)
		.on(item.name == sii.item_code)
		.select(sii.item_code, item.item_name, qty, Count(si.name).distinct().as_("invoices"))
		.where(
			(si.docstatus == 1)
			& (si.is_return == 0)
			& (si.pos_profile == pos_profile)
			& (si.posting_date >= add_days(nowdate(), -days))
			& (item.disabled == 0)
			& (item.is_sales_item == 1)
		)
		.groupby(sii.item_code, item.item_name)
		.orderby(qty, order=frappe.qb.desc)
		.orderby(sii.item_code)
		.limit(limit)
		.run(as_dict=True)
	)


@frappe.whitelist()
def get_favourites(pos_profile: str, limit: int = DEFAULT_LIMIT, days: int = DEFAULT_DAYS) -> dict:
	check_pos_profile_access(pos_profile)
	limit = max(1, min(cint(limit) or DEFAULT_LIMIT, MAX_LIMIT))
	days = max(1, cint(days) or DEFAULT_DAYS)
	return {"items": top_sellers(pos_profile, limit, days), "days": days, "limit": limit}
