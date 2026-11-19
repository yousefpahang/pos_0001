# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""POS 0001 workspace: every pos_0001 feature is reachable and every link resolves."""

from __future__ import annotations

import json

import frappe
from frappe.tests.utils import FrappeTestCase

WORKSPACE = "POS 0001"
POS_0001_TARGETS = {
	"POS Scale Barcode Rule",
	"POS Label Template",
	"pos-labels",
	"POS Printer Profile",
	"POS Drawer Event",
	"POS Device",
	"Offline Invoice Sync",
	"POS 0001 Settings",
	"Sales Person Commission",
}


class TestWorkspace(FrappeTestCase):
	def setUp(self) -> None:
		self.ws = frappe.get_doc("Workspace", WORKSPACE)

	def test_links_resolve(self) -> None:
		for link in self.ws.links:
			if link.type != "Link":
				continue
			doctype = {"DocType": "DocType", "Report": "Report", "Page": "Page"}[link.link_type]
			self.assertTrue(frappe.db.exists(doctype, link.link_to), f"{link.link_type} {link.link_to} missing")

	def test_pos_0001_features_listed(self) -> None:
		targets = {link.link_to for link in self.ws.links if link.type == "Link"}
		self.assertFalse(POS_0001_TARGETS - targets)

	def test_card_counts_match(self) -> None:
		count, card = 0, None
		for link in [*self.ws.links, frappe._dict(type="Card Break")]:
			if link.type == "Card Break":
				if card:
					self.assertEqual(card.link_count, count, card.label)
				card, count = link, 0
			else:
				count += 1

	def test_content_blocks_exist(self) -> None:
		cards = {link.label for link in self.ws.links if link.type == "Card Break"}
		shortcuts = {s.label for s in self.ws.shortcuts}
		for block in json.loads(self.ws.content):
			if block["type"] == "card":
				self.assertIn(block["data"]["card_name"], cards)
			if block["type"] == "shortcut":
				self.assertIn(block["data"]["shortcut_name"], shortcuts)



class TestBrandWorkspace(FrappeTestCase):
	def test_upstream_workspace_hidden(self) -> None:
		self.assertEqual(frappe.db.get_value("Workspace", "POSNext", "is_hidden"), 1)
		self.assertEqual(frappe.db.get_value("Workspace", WORKSPACE, "is_hidden"), 0)
