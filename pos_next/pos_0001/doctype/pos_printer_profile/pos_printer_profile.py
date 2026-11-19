# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt

from __future__ import annotations

import re

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint

HOST_PATTERN = re.compile(r"^[A-Za-z0-9.\-]{1,253}$")
PRINT_MODES = ("raster", "escpos_text", "qz_html", "browser")


class POSPrinterProfile(Document):
	def validate(self) -> None:
		if self.print_mode and self.print_mode not in PRINT_MODES:
			frappe.throw(_("Print Mode must be one of: {0}.").format(", ".join(PRINT_MODES)))
		if not self.print_mode:
			self.print_mode = "raster"
		copies = cint(self.copies) or 1
		if copies < 1 or copies > 3:
			frappe.throw(_("Copies must be between 1 and 3."))
		self.copies = copies
		if self.connection == "Network":
			host = (self.network_host or "").strip()
			if not HOST_PATTERN.match(host):
				frappe.throw(_("Enter the printer's IP address or host name, for example 192.168.1.50."))
			self.network_host = host
			port = cint(self.network_port) or 9100
			if port < 1 or port > 65535:
				frappe.throw(_("Port must be between 1 and 65535."))
			self.network_port = port
		cpl = cint(self.characters_per_line)
		if cpl and (cpl < 24 or cpl > 64):
			frappe.throw(_("Characters per Line must be 0 (automatic) or between 24 and 64."))
