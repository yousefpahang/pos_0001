# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Hide POS Next's "POSNext" workspace on existing sites; "POS 0001" replaces it."""

from pos_next.pos_0001.install import hide_upstream_workspace


def execute() -> None:
	hide_upstream_workspace()
