# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Access checks shared by every pos_0001 endpoint."""

from __future__ import annotations

import frappe
from frappe import _

POS_ROLES = frozenset({"POSNext Cashier", "Nexus POS Manager", "POS User", "System Manager"})
POS_MANAGER_ROLES = frozenset({"Nexus POS Manager", "System Manager"})


def _roles(user: str) -> set[str]:
	return set(frappe.get_roles(user))


def is_pos_manager(user: str | None = None) -> bool:
	user = user or frappe.session.user
	return user == "Administrator" or bool(_roles(user) & POS_MANAGER_ROLES)


def require_pos_user(user: str | None = None) -> None:
	"""Throw PermissionError unless the user is logged in and has a POS role."""
	user = user or frappe.session.user
	if user == "Guest" or not (user == "Administrator" or _roles(user) & POS_ROLES):
		frappe.throw(_("You need a POS role to do this."), frappe.PermissionError)


def has_pos_profile_access(pos_profile: str | None, user: str | None = None) -> bool:
	"""True if the user is listed on the POS Profile, or is a POS manager."""
	user = user or frappe.session.user
	if is_pos_manager(user):
		return True
	if not pos_profile:
		return False
	return bool(frappe.db.exists("POS Profile User", {"parent": pos_profile, "user": user}))


def check_pos_profile_access(pos_profile: str | None, user: str | None = None) -> None:
	require_pos_user(user)
	if not has_pos_profile_access(pos_profile, user):
		frappe.throw(
			_("You don't have access to POS Profile {0}.").format(pos_profile or _("(none)")),
			frappe.PermissionError,
		)


def allowed_pos_profiles(user: str | None = None) -> list[str] | None:
	"""Profiles the user may see. None means all (managers)."""
	user = user or frappe.session.user
	if is_pos_manager(user):
		return None
	return frappe.get_all("POS Profile User", filters={"user": user}, pluck="parent", distinct=True)
