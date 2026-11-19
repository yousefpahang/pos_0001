# Copyright (c) 2026, BrainWise and contributors
# For license information, please see license.txt

try:
	from frappe.tests import IntegrationTestCase
except ImportError:  # Frappe v15
	from frappe.tests.utils import FrappeTestCase as IntegrationTestCase


class TestBankDeposits(IntegrationTestCase):
	pass
