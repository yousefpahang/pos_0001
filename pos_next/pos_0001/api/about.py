# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""About / Source code (SPEC section 2, license obligations).

AGPL-3.0 section 13: users of a hosted install must be offered the source code of the version
they use. The till shows a menu link to POS 0001 Settings `about_source_url`.
"""

from __future__ import annotations

import frappe

from pos_next import __version__ as pos_next_version
from pos_next.pos_0001 import __version__ as pos0001_version
from pos_next.pos_0001.doctype.pos_0001_settings.pos_0001_settings import get_settings
from pos_next.pos_0001.permissions import require_pos_user

LICENSE = "AGPL-3.0"


@frappe.whitelist()
def get_about() -> dict[str, str]:
	"""Version, license and source code link for the till's About entry.

	No POS Profile is involved (the data is the same for every till), so only the POS role is checked.
	"""
	require_pos_user()
	return {
		"version": pos0001_version,
		"pos_next_version": pos_next_version,
		"license": LICENSE,
		"source_url": str(get_settings()["about_source_url"]),
	}
