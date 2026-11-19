# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""About / Source code entry (SPEC section 2, AGPL source offer)."""

from __future__ import annotations

import frappe
from frappe.tests.utils import FrappeTestCase

from pos_next.pos_0001 import __version__
from pos_next.pos_0001.api import about
from pos_next.pos_0001.tests.test_sync import CASHIER

SETTINGS = "POS 0001 Settings"


class TestAbout(FrappeTestCase):
	def setUp(self) -> None:
		frappe.set_user("Administrator")
		self.saved_url = frappe.db.get_single_value(SETTINGS, "about_source_url")

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		frappe.db.set_single_value(SETTINGS, "about_source_url", self.saved_url)
		frappe.clear_document_cache(SETTINGS, SETTINGS)

	def test_cashier_gets_version_and_source_link(self) -> None:
		frappe.db.set_single_value(SETTINGS, "about_source_url", "https://example.com/shop/pos_0001")
		frappe.clear_document_cache(SETTINGS, SETTINGS)
		frappe.set_user(CASHIER)
		out = about.get_about()
		self.assertEqual(out["version"], __version__)
		self.assertEqual(out["license"], "AGPL-3.0")
		self.assertEqual(out["source_url"], "https://example.com/shop/pos_0001")
		self.assertTrue(out["pos_next_version"])

	def test_empty_setting_falls_back_to_the_public_repository(self) -> None:
		frappe.db.set_single_value(SETTINGS, "about_source_url", "")
		frappe.clear_document_cache(SETTINGS, SETTINGS)
		self.assertEqual(about.get_about()["source_url"], "https://github.com/yousefpahang/pos_0001")

	def test_guest_is_rejected(self) -> None:
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			about.get_about()
