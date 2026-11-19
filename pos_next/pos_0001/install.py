# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Install and migrate steps of pos_0001."""

from __future__ import annotations

import json
import os

import frappe

DEFAULTS_FILE = os.path.join(os.path.dirname(__file__), "default_label_templates.json")


def default_label_templates() -> list[dict]:
	with open(DEFAULTS_FILE, encoding="utf-8") as handle:
		return json.load(handle)


def ensure_default_label_templates() -> None:
	"""Create the shipped label templates (SPEC F4) when missing. Never overwrites edits."""
	if not frappe.db.table_exists("POS Label Template"):
		return
	for row in default_label_templates():
		if frappe.db.exists("POS Label Template", row["template_name"]):
			continue
		values = dict(row)
		if values.get("is_default") and frappe.db.exists(
			"POS Label Template", {"language": values["language"], "is_default": 1}
		):
			values["is_default"] = 0
		doc = frappe.get_doc({"doctype": "POS Label Template", **values})
		doc.flags.ignore_permissions = True
		doc.insert()


UPSTREAM_WORKSPACE = "POSNext"


def hide_upstream_workspace() -> None:
	"""The "POS 0001" workspace replaces POS Next's "POSNext" one. Frappe keeps is_hidden as a
	site setting when it syncs workspace files, so it is set here: once by the patch on existing
	sites, and after install on new ones. An admin can show it again from the sidebar."""
	if frappe.db.exists("Workspace", UPSTREAM_WORKSPACE):
		frappe.db.set_value("Workspace", UPSTREAM_WORKSPACE, "is_hidden", 1, update_modified=False)

