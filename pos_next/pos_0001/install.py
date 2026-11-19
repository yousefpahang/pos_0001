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


BLOCKS_DIR = os.path.join(os.path.dirname(__file__), "workspace_blocks")
WORKSPACE_BLOCKS = {"POS 0001 Hero": "hero", "POS 0001 Features": "features"}


def ensure_workspace_blocks() -> None:
	"""Create or refresh the Custom HTML Blocks of the "POS 0001" workspace from workspace_blocks/.
	These blocks are shipped design, so local edits are replaced on migrate."""
	if not frappe.db.table_exists("Custom HTML Block"):
		return
	for name, stem in WORKSPACE_BLOCKS.items():
		parts = {}
		for field, ext in (("html", "html"), ("style", "css"), ("script", "js")):
			with open(os.path.join(BLOCKS_DIR, f"{stem}.{ext}"), encoding="utf-8") as handle:
				parts[field] = handle.read()
		if frappe.db.exists("Custom HTML Block", name):
			doc = frappe.get_doc("Custom HTML Block", name)
			if all(doc.get(field) == value for field, value in parts.items()):
				continue
			doc.update(parts)
			doc.save(ignore_permissions=True)
		else:
			frappe.get_doc({"doctype": "Custom HTML Block", "name": name, "private": 0, **parts}).insert(
				ignore_permissions=True, set_name=name
			)


PRESETS_FILE = os.path.join(os.path.dirname(__file__), "default_item_wizard_presets.json")
ITEM_WIZARD_ROLE = "POS Item Wizard"


def default_item_wizard_presets() -> list[dict]:
	with open(PRESETS_FILE, encoding="utf-8") as handle:
		return json.load(handle)


def ensure_item_wizard_setup() -> None:
	"""Role "POS Item Wizard" and the four shipped presets (SPEC F13). Never overwrites edits."""
	if not frappe.db.exists("Role", ITEM_WIZARD_ROLE):
		frappe.get_doc({"doctype": "Role", "role_name": ITEM_WIZARD_ROLE, "desk_access": 1}).insert(
			ignore_permissions=True
		)
	if not frappe.db.table_exists("POS Item Wizard Preset"):
		return
	from pos_next.pos_0001.item_wizard import ensure_uoms

	for row in default_item_wizard_presets():
		if frappe.db.exists("POS Item Wizard Preset", row["preset_name"]):
			continue
		units = [row["stock_uom"]]
		for unit in row.get("buying_units", []):
			units += [unit["uom"], unit.get("parent_uom")]
		for unit in row.get("selling_units", []):
			units += [unit["uom"], unit.get("size_uom")]
		ensure_uoms([u for u in dict.fromkeys(units) if u])
		doc = frappe.get_doc({"doctype": "POS Item Wizard Preset", "is_standard": 1, **row})
		doc.flags.ignore_permissions = True
		doc.insert()
