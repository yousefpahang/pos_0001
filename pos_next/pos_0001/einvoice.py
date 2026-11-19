# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Hook point for UAE e-invoicing (SPEC section 7). Nothing is sent today.

Every POS sale reaches ERPNext through one service function, POS Next's
``pos_next.api.invoices.submit_invoice``: live sales, background-submitted sales
(DECISIONS item 13), the offline queue (single and batch, ``pos_0001.api.sync``) and Retry of a
Failed record. Right after ``invoice_doc.submit()`` it calls :func:`after_pos_invoice_submit`,
which runs the handlers other apps list in their ``hooks.py``::

	pos0001_after_invoice_submit = ["my_einvoice_app.api.queue_invoice"]

A handler gets the submitted Sales Invoice and runs inside the submit transaction. It must be
quick and must not raise: queue the real work (``frappe.enqueue``) and keep its own retries.
An exception is logged and the sale still goes through, so a down e-invoicing service never
stops the till or loses an offline invoice. With no handler registered this is a no-op.
"""

from __future__ import annotations

from typing import Any

import frappe

HOOK = "pos0001_after_invoice_submit"
SAVEPOINT = "pos0001_einvoice"


def after_pos_invoice_submit(doc: Any) -> list[str]:
	"""Run the registered e-invoicing handlers for a submitted POS invoice.

	Returns the handlers that ran without error (used by tests)."""
	done = []
	for path in frappe.get_hooks(HOOK) or []:
		# A failing handler's own writes are undone; the invoice is kept.
		frappe.db.savepoint(SAVEPOINT)
		try:
			frappe.get_attr(path)(doc)
			done.append(path)
		except Exception:
			frappe.db.rollback(save_point=SAVEPOINT)
			frappe.log_error(title=f"POS e-invoicing hook failed: {doc.name}", message=frappe.get_traceback())
	return done
