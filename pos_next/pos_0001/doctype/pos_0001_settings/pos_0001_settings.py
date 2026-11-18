# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt

from __future__ import annotations

import frappe
from frappe.model.document import Document

DOCTYPE = "POS 0001 Settings"

DEFAULTS: dict[str, object] = {
	"offline_negative_stock": "Warn",
	"cache_refresh_minutes": 5,
	"held_cart_retention_days": 3,
	"default_cash_rounding": "None",
	"about_source_url": "https://github.com/yousefpahang/pos_0001",
}


class POS0001Settings(Document):
	def validate(self) -> None:
		if (self.cache_refresh_minutes or 0) < 1:
			self.cache_refresh_minutes = 1


def get_settings() -> dict[str, object]:
	"""Return settings as a plain dict, falling back to defaults for empty values."""
	doc = frappe.get_cached_doc(DOCTYPE)
	return {key: (doc.get(key) if doc.get(key) not in (None, "") else default) for key, default in DEFAULTS.items()}
