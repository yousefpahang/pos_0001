# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Reference QR matrices from pyqrcode (a Frappe dependency) for the browser encoder test.

Regenerate POS/src/plus/core/qr.reference.json with:
    bench --site pos.test execute pos_next.pos_0001.tests.qr_reference.dump
"""

from __future__ import annotations

import json
import os

import frappe

SAMPLES = [
	"ACC-SINV-2026-00012",
	"pos_offline_3f2b8c1e-9a4d-4c7e-b2a1-5d6e7f8091a2",
	"https://example.com/source?invoice=ACC-SINV-2026-00012&till=Main%20Till",
	"x" * 150,
]


def matrices() -> dict:
	import pyqrcode

	out = {}
	for text in SAMPLES:
		q = pyqrcode.create(text, error="M", mode="binary")
		out[text] = {"version": q.version, "rows": ["".join(str(c) for c in row) for row in q.code]}
	return out


def dump() -> str:
	path = os.path.join(
		frappe.get_app_path("pos_next"), "..", "POS", "src", "plus", "core", "qr.reference.json"
	)
	path = os.path.abspath(path)
	with open(path, "w") as f:
		json.dump(matrices(), f, indent=1)
		f.write("\n")
	return path
