# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Report endpoints for the POS (SPEC section 9)."""

from __future__ import annotations

import frappe

from pos_next.pos_0001.permissions import allowed_pos_profiles, check_pos_profile_access, require_pos_user
from pos_next.pos_0001.report.sales_person_commission.sales_person_commission import get_rows


@frappe.whitelist()
def sales_person_commission(
	from_date: str,
	to_date: str,
	pos_profile: str | None = None,
	company: str | None = None,
) -> list[dict]:
	"""Sales Person Commission rows. Cashiers see only POS Profiles they are on."""
	require_pos_user()
	if pos_profile:
		check_pos_profile_access(pos_profile)
		allowed = None
	else:
		allowed = allowed_pos_profiles()
	return get_rows(
		from_date=from_date,
		to_date=to_date,
		company=company,
		pos_profile=pos_profile,
		allowed_profiles=allowed,
	)
