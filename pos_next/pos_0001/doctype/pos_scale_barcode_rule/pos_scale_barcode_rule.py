# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document

from pos_next.pos_0001.scale_barcode import ScaleRule, generate_scale_barcode, rule_errors


def _messages() -> dict[str, str]:
	return {
		"total_length": _("Total Length must be between 8 and 20 digits."),
		"prefix": _("Prefix must be 1 to 3 digits."),
		"item_code": _("Item Code Start and Item Code Length must be 1 or more."),
		"value": _("Value Start and Value Length must be 1 or more."),
		"prefix_past_check_digit": _("The prefix runs into the check digit (the last digit)."),
		"item_code_past_check_digit": _(
			"The item code runs into the check digit (the last digit). Shorten it or move it left."
		),
		"value_past_check_digit": _(
			"The value runs into the check digit (the last digit). Shorten it or move it left."
		),
		"overlap_prefix_item_code": _("The item code overlaps the prefix. Item Code Start must come after it."),
		"overlap_prefix_value": _("The value overlaps the prefix."),
		"overlap_item_code_value": _("The item code and the value overlap."),
		"decimals": _("Decimals must be between 0 and 6."),
	}


class POSScaleBarcodeRule(Document):
	@property
	def example(self) -> str:
		try:
			sample = 1.25 if self.value_type == "Weight" else 9.99
			code = generate_scale_barcode(ScaleRule.from_dict(self), "1" * (self.item_code_length or 1), sample)
		except (TypeError, ValueError):
			return ""
		label = _("weight {0}").format(sample) if self.value_type == "Weight" else _("price {0}").format(sample)
		return f"{code} ({label})"

	def validate(self) -> None:
		self.prefix = (self.prefix or "").strip()
		messages = _messages()
		errors = rule_errors(ScaleRule.from_dict(self))
		if errors:
			frappe.throw("<br>".join(messages.get(e, e) for e in errors), title=_("Invalid barcode layout"))
		if self.value_type == "Weight" and not self.uom:
			frappe.throw(_("Set the UOM for weight rules (for example Kg)."))
		self._check_profiles_company()

	def _check_profiles_company(self) -> None:
		for row in self.pos_profiles or []:
			company = frappe.db.get_value("POS Profile", row.pos_profile, "company")
			if company and company != self.company:
				frappe.throw(
					_("POS Profile {0} belongs to company {1}, not {2}.").format(
						row.pos_profile, company, self.company
					)
				)
