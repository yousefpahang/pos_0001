# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""F6 tests: sales person modes, allocation to the Sales Team table, cache, commission report.

Needs the demo data from pos_next/pos_0001/demo/seed.py (POS Profile "Main Till" with
POS Settings "Enable Sales Persons" = Multiple, user cashier@pos.test, items ITM-xxxxx).
"""

from __future__ import annotations

import json

import frappe
from frappe.tests.utils import FrappeTestCase
from frappe.utils import flt, nowdate

from pos_next.pos_0001 import sales_person as sp
from pos_next.pos_0001.api import reports, sync
from pos_next.pos_0001.api import sales_person as api
from pos_next.pos_0001.report.sales_person_commission import sales_person_commission as report
from pos_next.pos_0001.tests.test_sync import CASHIER, ITEM, PROFILE, _device_id, _ensure_outsider, _payload

PERSON_A = "POS0001 Test Seller A"
PERSON_B = "POS0001 Test Seller B"
PERSON_C = "POS0001 Test Seller C"
RATES = {PERSON_A: 10.0, PERSON_B: 5.0, PERSON_C: 2.0}
BARCODES = {PERSON_A: "POS0001SPA", PERSON_B: "POS0001SPB", PERSON_C: "POS0001SPC"}


def _ensure_people() -> None:
	# Demo items were imported without doctype defaults; commission needs grant_commission.
	frappe.db.set_value("Item", ITEM, "grant_commission", 1)
	root = frappe.db.get_value("Sales Person", {"is_group": 1, "parent_sales_person": ["in", ["", None]]})
	for person, rate in RATES.items():
		if not frappe.db.exists("Sales Person", person):
			frappe.get_doc(
				{
					"doctype": "Sales Person",
					"sales_person_name": person,
					"parent_sales_person": root,
					"enabled": 1,
				}
			).insert(ignore_permissions=True)
		frappe.db.set_value(
			"Sales Person",
			person,
			{"commission_rate": rate, "sales_person_barcode": BARCODES[person], "enabled": 1},
		)


def _sync(payload: dict) -> dict:
	result = sync.submit_offline_invoice(json.dumps(payload), _device_id())
	return result


def _team(*pairs: tuple[str, float]) -> list[dict]:
	return [{"sales_person": person, "allocated_percentage": share} for person, share in pairs]


class TestModeAndAllocation(FrappeTestCase):
	def test_mode_matrix(self) -> None:
		cases = [
			# (profile mode, POS Next mode) -> (mode, multiple)
			(("Optional", "Disabled"), ("Optional", False)),
			(("Optional", "Multiple"), ("Optional", True)),
			(("Mandatory", "Single"), ("Mandatory", False)),
			(("Mandatory", None), ("Mandatory", False)),
			(("Off", "Disabled"), ("Off", False)),
			(("Off", "Single"), ("Mandatory", False)),  # POS Next behaviour kept
			(("Off", "Multiple"), ("Mandatory", True)),
			((None, None), ("Off", False)),
		]
		for args, (mode, multiple) in cases:
			resolved = sp.resolve_mode(*args)
			self.assertEqual((resolved.mode, resolved.multiple), (mode, multiple), args)
			self.assertEqual(resolved.enabled, mode != "Off")
			self.assertEqual(resolved.required, mode == "Mandatory")

	def test_split_evenly_totals_exactly_100(self) -> None:
		self.assertEqual(sp.split_evenly(3), [33.34, 33.33, 33.33])
		self.assertEqual(sp.split_evenly(1), [100.0])
		self.assertEqual(sp.split_evenly(0), [])
		for count in range(1, 13):
			shares = sp.split_evenly(count)
			self.assertEqual(len(shares), count)
			self.assertEqual(round(sum(shares), 2), 100.0, count)

	def test_normalize_fixes_drift_only(self) -> None:
		self.assertEqual(sp.allocation_total(sp.normalize_allocation([100 / 3] * 3)), 100.0)
		self.assertEqual(sp.normalize_allocation([33.333, 33.333, 33.333]), [33.33, 33.33, 33.34])
		self.assertEqual(sp.normalize_allocation([60, 40]), [60.0, 40.0])
		# A real mistake is not hidden.
		self.assertEqual(sp.allocation_total(sp.normalize_allocation([50, 30])), 80.0)
		self.assertEqual(sp.normalize_allocation([]), [])


class TestSalesTeamOnInvoice(FrappeTestCase):
	def setUp(self) -> None:
		frappe.set_user("Administrator")
		_ensure_people()
		self.saved_mode = frappe.db.get_value("POS Profile", PROFILE, "pos0001_sales_person_mode")

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_sales_person_mode", self.saved_mode)

	def _invoice(self, result: dict):
		self.assertEqual(result["status"], "Synced", result)
		return frappe.get_doc("Sales Invoice", result["invoice_name"])

	def test_three_way_even_split_totals_100(self) -> None:
		# POS Next's payment dialog sends 100 / 3 to every row; ERPNext would reject 99.999.
		payload = _payload()
		payload["sales_team"] = _team((PERSON_A, 100 / 3), (PERSON_B, 100 / 3), (PERSON_C, 100 / 3))
		invoice = self._invoice(_sync(payload))

		shares = [row.allocated_percentage for row in invoice.sales_team]
		self.assertEqual([row.sales_person for row in invoice.sales_team], [PERSON_A, PERSON_B, PERSON_C])
		self.assertEqual(round(sum(shares), 2), 100.0)
		self.assertAlmostEqual(
			sum(flt(row.allocated_amount) for row in invoice.sales_team),
			flt(invoice.amount_eligible_for_commission),
			delta=0.011,
		)

	def test_commission_rate_and_incentives_filled(self) -> None:
		payload = _payload()
		payload["sales_team"] = _team((PERSON_A, 60), (PERSON_B, 40))
		invoice = self._invoice(_sync(payload))

		eligible = flt(invoice.amount_eligible_for_commission)
		self.assertGreater(eligible, 0)
		by_person = {row.sales_person: row for row in invoice.sales_team}
		self.assertEqual(flt(by_person[PERSON_A].commission_rate), 10.0)
		self.assertEqual(flt(by_person[PERSON_B].commission_rate), 5.0)
		self.assertAlmostEqual(flt(by_person[PERSON_A].allocated_amount), eligible * 0.6, delta=0.01)
		self.assertAlmostEqual(flt(by_person[PERSON_A].incentives), eligible * 0.6 * 0.10, delta=0.01)
		self.assertAlmostEqual(flt(by_person[PERSON_B].incentives), eligible * 0.4 * 0.05, delta=0.01)

	def test_split_that_is_really_wrong_is_rejected(self) -> None:
		payload = _payload()
		payload["sales_team"] = _team((PERSON_A, 50), (PERSON_B, 30))
		result = _sync(payload)
		self.assertEqual(result["status"], "Failed", result)
		self.assertIn("100", result["error"])

	def test_empty_rows_are_dropped(self) -> None:
		payload = _payload()
		payload["sales_team"] = [{"sales_person": "", "allocated_percentage": 0}, *_team((PERSON_A, 100))]
		invoice = self._invoice(_sync(payload))
		self.assertEqual([row.sales_person for row in invoice.sales_team], [PERSON_A])

	def test_mandatory_blocks_online_submit_without_sales_person(self) -> None:
		from pos_next.api.invoices import submit_invoice

		frappe.db.set_value("POS Profile", PROFILE, "pos0001_sales_person_mode", "Mandatory")
		payload = _payload()
		payload.pop("offline_id")
		with self.assertRaises(frappe.ValidationError) as ctx:
			submit_invoice(invoice=json.loads(json.dumps(payload)), data={})
		self.assertIn("sales person", str(ctx.exception).lower())
		frappe.clear_messages()

		payload = _payload()
		payload.pop("offline_id")
		payload["sales_team"] = _team((PERSON_A, 100))
		result = submit_invoice(invoice=json.loads(json.dumps(payload)), data={})
		self.assertEqual(frappe.db.get_value("Sales Invoice", result["name"], "docstatus"), 1)

	def test_mandatory_never_rejects_a_queued_offline_invoice(self) -> None:
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_sales_person_mode", "Mandatory")
		result = _sync(_payload())
		self.assertEqual(result["status"], "Synced", result)
		self.assertFalse(frappe.flags.get(api.OFFLINE_FLAG))

	def test_optional_allows_no_sales_person(self) -> None:
		from pos_next.api.invoices import submit_invoice

		for mode in ("Optional", "Off"):
			# Off + POS Settings Multiple is mandatory at the till only; the server keeps
			# POS Next's behaviour and does not reject the sale.
			frappe.db.set_value("POS Profile", PROFILE, "pos0001_sales_person_mode", mode)
			payload = _payload()
			payload.pop("offline_id")
			result = submit_invoice(invoice=json.loads(json.dumps(payload)), data={})
			self.assertEqual(frappe.db.get_value("Sales Invoice", result["name"], "docstatus"), 1, mode)


class TestSalesPersonCache(FrappeTestCase):
	def setUp(self) -> None:
		frappe.set_user("Administrator")
		_ensure_people()
		self.saved_mode = frappe.db.get_value("POS Profile", PROFILE, "pos0001_sales_person_mode")
		self.saved_default = frappe.db.get_value("User", CASHIER, "pos0001_default_sales_person")
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_sales_person_mode", "Optional")
		frappe.db.set_value("User", CASHIER, "pos0001_default_sales_person", PERSON_B)

	def tearDown(self) -> None:
		frappe.set_user("Administrator")
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_sales_person_mode", self.saved_mode)
		frappe.db.set_value("User", CASHIER, "pos0001_default_sales_person", self.saved_default)

	def test_cache_for_cashier(self) -> None:
		frappe.set_user(CASHIER)
		cache = api.get_sales_person_cache(PROFILE)
		self.assertEqual(cache["mode"], "Optional")
		self.assertTrue(cache["enabled"])
		self.assertFalse(cache["required"])
		self.assertTrue(cache["multiple"])  # demo POS Settings say Multiple
		self.assertEqual(cache["default_sales_person"], PERSON_B)
		by_name = {p["name"]: p for p in cache["sales_persons"]}
		self.assertEqual(by_name[PERSON_A]["barcode"], BARCODES[PERSON_A])
		self.assertEqual(by_name[PERSON_A]["commission_rate"], 10.0)
		self.assertNotIn("Sales Team", by_name)  # group node

	def test_disabled_default_is_not_offered(self) -> None:
		frappe.db.set_value("Sales Person", PERSON_B, "enabled", 0)
		try:
			frappe.set_user(CASHIER)
			cache = api.get_sales_person_cache(PROFILE)
			self.assertIsNone(cache["default_sales_person"])
			self.assertNotIn(PERSON_B, [p["name"] for p in cache["sales_persons"]])
		finally:
			frappe.set_user("Administrator")
			frappe.db.set_value("Sales Person", PERSON_B, "enabled", 1)

	def test_off_sends_no_list(self) -> None:
		frappe.db.set_value("POS Profile", PROFILE, "pos0001_sales_person_mode", "Off")
		settings = frappe.db.get_value("POS Settings", {"pos_profile": PROFILE}, ["name", "enable_sales_persons"])
		frappe.db.set_value("POS Settings", settings[0], "enable_sales_persons", "Disabled")
		try:
			cache = api.get_sales_person_cache(PROFILE)
			self.assertEqual(cache["mode"], "Off")
			self.assertEqual(cache["sales_persons"], [])
		finally:
			frappe.db.set_value("POS Settings", settings[0], "enable_sales_persons", settings[1])

	def test_find_by_barcode(self) -> None:
		frappe.set_user(CASHIER)
		self.assertEqual(api.find_by_barcode(BARCODES[PERSON_C], PROFILE)["name"], PERSON_C)
		self.assertIsNone(api.find_by_barcode("NO-SUCH-BADGE", PROFILE))

	def test_access_checks(self) -> None:
		frappe.set_user(_ensure_outsider())
		with self.assertRaises(frappe.PermissionError):
			api.get_sales_person_cache(PROFILE)
		with self.assertRaises(frappe.PermissionError):
			api.find_by_barcode(BARCODES[PERSON_A], PROFILE)
		frappe.set_user("Guest")
		with self.assertRaises(frappe.PermissionError):
			api.get_sales_person_cache(PROFILE)


class TestCommissionReport(FrappeTestCase):
	"""Two sales, one credit note; the report must match the Sales Team rows."""

	@classmethod
	def setUpClass(cls) -> None:
		super().setUpClass()
		frappe.set_user("Administrator")
		_ensure_people()
		cls.before = {row["sales_person"]: row for row in cls._rows()}

		first = _payload()
		first["sales_team"] = _team((PERSON_A, 60), (PERSON_B, 40))
		second = _payload()
		second["sales_team"] = _team((PERSON_A, 100))
		cls.invoices = []
		for payload in (first, second):
			result = sync.submit_offline_invoice(json.dumps(payload), _device_id())
			assert result["status"] == "Synced", result
			cls.invoices.append(frappe.get_doc("Sales Invoice", result["invoice_name"]))

		from erpnext.accounts.doctype.sales_invoice.sales_invoice import make_sales_return

		credit_note = make_sales_return(cls.invoices[1].name)
		credit_note.insert(ignore_permissions=True)
		credit_note.submit()
		cls.credit_note = credit_note
		cls.after = {row["sales_person"]: row for row in cls._rows()}

	@staticmethod
	def _rows() -> list[dict]:
		return report.get_rows(from_date=nowdate(), to_date=nowdate(), pos_profile=PROFILE)

	def _delta(self, person: str, field: str) -> float:
		return flt(self.after[person][field]) - flt((self.before.get(person) or {}).get(field))

	def test_credit_note_keeps_sales_team(self) -> None:
		self.assertEqual([row.sales_person for row in self.credit_note.sales_team], [PERSON_A])
		self.assertLess(flt(self.credit_note.sales_team[0].allocated_amount), 0)

	def test_totals_match_sales_team_rows(self) -> None:
		first, second = self.invoices
		share = {
			PERSON_A: [first.sales_team[0], second.sales_team[0]],
			PERSON_B: [first.sales_team[1]],
		}
		credit = self.credit_note.sales_team[0]

		self.assertEqual(self._delta(PERSON_A, "invoices"), 2)
		self.assertEqual(self._delta(PERSON_B, "invoices"), 1)
		self.assertEqual(self._delta(PERSON_A, "return_count"), 1)
		self.assertEqual(self._delta(PERSON_B, "return_count"), 0)

		self.assertAlmostEqual(
			self._delta(PERSON_A, "net_sales"), sum(flt(r.allocated_amount) for r in share[PERSON_A]), delta=0.01
		)
		self.assertAlmostEqual(self._delta(PERSON_A, "returns"), flt(credit.allocated_amount), delta=0.01)
		self.assertAlmostEqual(
			self._delta(PERSON_A, "net_after_returns"),
			sum(flt(r.allocated_amount) for r in share[PERSON_A]) + flt(credit.allocated_amount),
			delta=0.01,
		)
		self.assertAlmostEqual(
			self._delta(PERSON_A, "commission"),
			sum(flt(r.incentives) for r in share[PERSON_A]) + flt(credit.incentives),
			delta=0.01,
		)
		self.assertAlmostEqual(
			self._delta(PERSON_B, "commission"), flt(share[PERSON_B][0].incentives), delta=0.01
		)
		# Commission = net after returns x rate when the rate did not change in the period.
		self.assertAlmostEqual(
			self._delta(PERSON_A, "commission"),
			self._delta(PERSON_A, "net_after_returns") * RATES[PERSON_A] / 100,
			delta=0.02,
		)
		self.assertEqual(self.after[PERSON_A]["commission_rate"], RATES[PERSON_A])

	def test_filters(self) -> None:
		rows = report.get_rows(nowdate(), nowdate(), pos_profile=PROFILE, sales_person=PERSON_B)
		self.assertEqual([row["sales_person"] for row in rows], [PERSON_B])
		self.assertEqual(report.get_rows(nowdate(), nowdate(), pos_profile="Express Till", sales_person=PERSON_B), [])
		self.assertEqual(report.get_rows("2000-01-01", "2000-01-31", pos_profile=PROFILE), [])
		with self.assertRaises(frappe.ValidationError):
			report.get_rows("2000-02-01", "2000-01-01")

	def test_script_report_execute(self) -> None:
		columns, rows = report.execute({"from_date": nowdate(), "to_date": nowdate(), "pos_profile": PROFILE})
		self.assertIn("commission", [c["fieldname"] for c in columns])
		self.assertIn(PERSON_A, [row["sales_person"] for row in rows])

	def test_endpoint_access(self) -> None:
		frappe.set_user(CASHIER)
		try:
			rows = reports.sales_person_commission(nowdate(), nowdate(), PROFILE)
			self.assertIn(PERSON_A, [row["sales_person"] for row in rows])
			frappe.set_user(_ensure_outsider())
			with self.assertRaises(frappe.PermissionError):
				reports.sales_person_commission(nowdate(), nowdate(), PROFILE)
			# No profile given: only profiles the user is on (none for the outsider).
			self.assertEqual(reports.sales_person_commission(nowdate(), nowdate()), [])
		finally:
			frappe.set_user("Administrator")
