# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt

from __future__ import annotations

import re

import frappe
from frappe import _
from frappe.model.document import Document

DEVICE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{8,64}$")


class POSDevice(Document):
	def validate(self) -> None:
		if not DEVICE_ID_PATTERN.match(self.device_id or ""):
			frappe.throw(_("Device ID must be 8 to 64 letters, digits, '-' or '_'."))
		if not self.device_name:
			self.device_name = self.device_id[:8]
