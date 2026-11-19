# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""``before_tests`` hook for ``bench run-tests --app pos_next``.

Frappe runs only the ``before_tests`` hooks of the app under test, so ERPNext's own
setup (setup wizard, Selling defaults, roles for Administrator) never ran for pos_next.
On a fresh site that left no "All Departments" root, and building ERPNext's test records
failed with "Could not find Parent Department: All Departments".

This hook:
1. Completes the setup wizard with the demo company "Demo Trading LLC" (UAE, AED) when
   the site has no company yet. The UAE setup creates the "UAE VAT 5% - DTL" template.
2. Runs ERPNext's ``erpnext.setup.utils.before_tests`` (only when ERPNext is installed).
   It deletes every Item Price, so prices are rebuilt in step 3.
3. Creates the small demo data set the pos_0001 tests use: the items they name, the
   weighed PLU items, prices, opening stock, the cashier user, POS Profiles "Main Till"
   and "Express Till", the scale barcode rules, sales persons, printers and label setup.

Every step is idempotent: on the dev site (full demo data) it only rebuilds Item Prices.
"""

from __future__ import annotations

import random

import frappe

# Items the tests name directly (test_sync, test_held_carts, test_favourites, ...).
TEST_ITEM_NUMBERS = (1, 2, 3, 4, 5, 19990, 19991)


def before_tests() -> None:
	if "erpnext" not in frappe.get_installed_apps():
		return

	from erpnext.setup.utils import before_tests as erpnext_before_tests

	from pos_next.pos_0001.demo import seed

	frappe.clear_cache()
	random.seed(1)
	seed.setup_wizard()
	frappe.db.commit()

	erpnext_before_tests()
	_make_company_test_records()

	if not frappe.db.exists("Company", seed.COMPANY):
		# A site set up with another company: the pos_0001 tests need the demo company.
		print(f"pos_next before_tests: company {seed.COMPANY!r} not found, demo test data skipped")
		return

	bank_account = seed.ensure_accounts()
	modes = seed.ensure_modes_of_payment(bank_account)
	seed.ensure_item_groups()
	seed.ensure_sales_persons()
	seed.ensure_customers()
	frappe.db.commit()
	seed.create_numbered_items(TEST_ITEM_NUMBERS)
	seed.create_weighed_items()
	seed.mark_demo_items_sellable()
	seed.ensure_item_prices()
	frappe.db.commit()
	seed.opening_stock()
	seed.ensure_cashier()
	for name in ("Main Till", "Express Till"):
		seed.ensure_pos_profile(name, modes)
	seed.ensure_scale_barcodes()
	seed.ensure_sales_person_setup()
	seed.ensure_printing_setup()
	seed.ensure_label_setup()
	seed.ensure_uae_receipt_setup()
	frappe.db.commit()


def _make_company_test_records() -> None:
	"""Build ERPNext's "_Test Company" test records before any other test records.

	Our custom field User.pos0001_default_sales_person links User to Sales Person, so
	Frappe's dependency walk goes Company > Contact > User > Sales Person > Department and
	builds Department's records (company "_Test Company") before the company exists:
	"Could not find Company: _Test Company". Holding Sales Person back while Company is
	built breaks that cycle; the runner builds Sales Person later, after Company.
	Does nothing with --skip-test-records (make_test_records checks the flag).
	"""
	from frappe.test_runner import make_test_records

	if frappe.flags.skip_test_records:
		return
	_skip_missing_link_targets()
	if "Sales Person" in frappe.local.test_objects:
		return
	frappe.local.test_objects["Sales Person"] = []
	try:
		make_test_records("Company", commit=True)
	finally:
		frappe.local.test_objects.pop("Sales Person", None)


def _skip_missing_link_targets() -> None:
	"""Mark link targets whose DocType is not installed as done for the test-record walk.

	ERPNext's Payment Gateway Account links "Payment Gateway", a DocType of the optional
	payments app. Without that app the walk fails with "DocType Payment Gateway not found".
	"""
	docfield = frappe.qb.DocType("DocField")
	custom_field = frappe.qb.DocType("Custom Field")
	targets = set(
		frappe.qb.from_(docfield).select(docfield.options).distinct()
		.where(docfield.fieldtype == "Link").where(docfield.options.notnull())
		.run(pluck=True)
	) | set(
		frappe.qb.from_(custom_field).select(custom_field.options).distinct()
		.where(custom_field.fieldtype == "Link").where(custom_field.options.notnull())
		.run(pluck=True)
	)
	installed = set(frappe.get_all("DocType", pluck="name"))
	for target in targets - installed:
		if target and target != "[Select]":
			frappe.local.test_objects.setdefault(target, [])
