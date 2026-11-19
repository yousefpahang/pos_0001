# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document


class POSItemWizardPreset(Document):
	def validate(self) -> None:
		from pos_next.pos_0001.item_wizard import preset_errors

		errors = preset_errors(self.as_dict())
		if errors:
			frappe.throw("<br>".join(errors), title=_("Item Wizard Preset"))
