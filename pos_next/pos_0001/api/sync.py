# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Offline invoice sync: failed-sync storage, Retry, sync status and device registration.

Duplicate protection stays in POS Next (`offline_id` + Offline Invoice Sync, see
`pos_next.api.invoices._ensure_offline_uniqueness`). This module wraps POS Next's
`submit_invoice` so that a rejected invoice is not lost: the failed attempt is rolled back
to a savepoint and the full payload plus the error are stored on the Offline Invoice Sync
record with status Failed. The browser removes an invoice from its queue only when this
endpoint answers ``Synced`` or ``Failed`` with ``stored: True`` (DECISIONS.md item 2).
"""

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.query_builder.functions import Count
from frappe.utils import cint, flt, now_datetime, strip_html

from pos_next.pos_0001.permissions import (
	allowed_pos_profiles,
	check_pos_profile_access,
	require_pos_user,
)

OIS = "Offline Invoice Sync"
DEVICE = "POS Device"
SAVEPOINT = "pos0001_offline_submit"
MAX_ERROR_LENGTH = 2000
MAX_BATCH = 25
BATCH_SAVEPOINT = "pos0001_offline_batch"
IN_PROGRESS_MARKERS = ("SYNC_IN_PROGRESS", "currently being processed")
TRANSIENT_ERRORS: tuple[type[Exception], ...] = (
	frappe.QueryDeadlockError,
	frappe.QueryTimeoutError,
)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _parse_json(value: Any) -> Any:
	if isinstance(value, str):
		return json.loads(value) if value else None
	return value


def error_text(exc: BaseException) -> str:
	"""Turn an exception into a short plain-text message for the cashier and desk."""
	message = strip_html(str(exc) or "").strip()
	if not message:
		messages = []
		for entry in frappe.local.message_log or []:
			if isinstance(entry, str):
				try:
					entry = json.loads(entry)
				except ValueError:
					entry = {"message": entry}
			messages.append(strip_html(str((entry or {}).get("message") or "")))
		message = " ".join(m for m in messages if m).strip()
	if not message:
		message = exc.__class__.__name__
	return message[:MAX_ERROR_LENGTH]


def _clear_messages() -> None:
	"""Drop msgprint messages raised by the failed attempt so the POS does not show popups."""
	frappe.clear_messages()


def _upsert_device(
	device_id: str | None,
	pos_profile: str | None = None,
	device_name: str | None = None,
	app_version: str | None = None,
	user_agent: str | None = None,
) -> str | None:
	"""Create or refresh a POS Device. Returns its name, or None when no id was given."""
	if not device_id:
		return None
	values: dict[str, Any] = {"last_seen": now_datetime(), "last_user": frappe.session.user}
	if pos_profile:
		values["pos_profile"] = pos_profile
	if device_name:
		values["device_name"] = device_name
	if app_version:
		values["app_version"] = app_version
	if user_agent:
		values["user_agent"] = user_agent[:500]

	if frappe.db.exists(DEVICE, device_id):
		if cint(frappe.db.get_value(DEVICE, device_id, "disabled")):
			frappe.throw(_("This till (device {0}) is disabled. Ask a manager to enable it.").format(device_id))
		values.pop("device_name", None)  # keep a name a manager gave the till
		frappe.db.set_value(DEVICE, device_id, values, update_modified=False)
		return device_id

	doc = frappe.get_doc({"doctype": DEVICE, "device_id": device_id, **values})
	doc.flags.ignore_permissions = True
	try:
		doc.insert()
	except frappe.DuplicateEntryError:
		pass
	return device_id


def _pending_is_active(offline_id: str) -> bool:
	from pos_next.api.invoices import _is_pending_expired

	row = frappe.db.get_value(OIS, {"offline_id": offline_id}, ["status", "modified"], as_dict=True)
	return bool(row and row.status == "Pending" and not _is_pending_expired(row.modified))


def store_failure(invoice: dict, error: str, device: str | None) -> str:
	"""Write the payload and error on the Offline Invoice Sync row (create it if missing)."""
	offline_id = invoice["offline_id"]
	values = {
		"status": "Failed",
		"sales_invoice": "",
		"error": error,
		"payload": json.dumps(invoice, default=str, ensure_ascii=False),
		"last_attempt_at": now_datetime(),
		"grand_total": flt(invoice.get("grand_total") or invoice.get("rounded_total")),
		"pos_profile": invoice.get("pos_profile"),
		"customer": invoice.get("customer"),
	}
	if device:
		values["pos_device"] = device

	name = frappe.db.get_value(OIS, {"offline_id": offline_id}, "name", for_update=True)
	if name:
		doc = frappe.get_doc(OIS, name)
		doc.update(values)
		doc.retry_count = cint(doc.retry_count) + 1
		doc.flags.ignore_permissions = True
		doc.save()
		return doc.name

	doc = frappe.get_doc({"doctype": OIS, "offline_id": offline_id, "retry_count": 1, **values})
	doc.flags.ignore_permissions = True
	doc.insert()
	return doc.name


def _record_success(invoice: dict, invoice_name: str, device: str | None) -> None:
	offline_id = invoice["offline_id"]
	name = frappe.db.get_value(OIS, {"offline_id": offline_id}, "name")
	if name:
		values: dict[str, Any] = {
			"error": "",
			"last_attempt_at": now_datetime(),
			"grand_total": flt(frappe.db.get_value("Sales Invoice", invoice_name, "grand_total")),
		}
		if device:
			values["pos_device"] = device
		frappe.db.set_value(OIS, name, values, update_modified=False)
	if device:
		frappe.db.set_value("Sales Invoice", invoice_name, "pos_device", device, update_modified=False)


def process_offline_invoice(invoice: dict, device_id: str | None = None) -> dict:
	"""Submit one queued invoice; on rejection store it as Failed instead of raising.

	Returns ``{offline_id, status, invoice_name, error, stored}`` where status is
	``Synced``, ``Failed`` (stored on the server) or ``Pending`` (another request is
	processing it; the browser keeps it and tries again).
	"""
	from pos_next.api.invoices import submit_invoice

	if not isinstance(invoice, dict):
		frappe.throw(_("Invalid invoice format"))
	offline_id = invoice.get("offline_id")
	if not offline_id:
		frappe.throw(_("The invoice has no offline ID, so it cannot be synced safely."))

	pos_profile = invoice.get("pos_profile")
	check_pos_profile_access(pos_profile)
	invoice.pop("pos_device", None)
	device = _upsert_device(device_id, pos_profile)

	base = {"offline_id": offline_id, "invoice_name": None, "error": None, "stored": False}
	if _pending_is_active(offline_id):
		return {**base, "status": "Pending"}

	frappe.db.savepoint(SAVEPOINT)
	# Hooks can tell a queued offline sale from a live one (sales person check, Phase 3).
	frappe.flags.pos0001_offline_submit = True
	try:
		# submit_invoice changes the dict it gets; keep the original payload for storage.
		result = submit_invoice(invoice=json.loads(json.dumps(invoice, default=str)), data={})
	except TRANSIENT_ERRORS:
		raise
	except Exception as exc:
		message = error_text(exc)
		traceback = frappe.get_traceback()
		try:
			frappe.db.rollback(save_point=SAVEPOINT)
		except Exception:
			frappe.db.rollback()
		_clear_messages()
		if any(marker in message for marker in IN_PROGRESS_MARKERS):
			return {**base, "status": "Pending", "error": message}
		store_failure(invoice, message, device)
		frappe.log_error(title=f"POS offline sync failed: {offline_id}", message=traceback)
		return {**base, "status": "Failed", "error": message, "stored": True}
	finally:
		frappe.flags.pos0001_offline_submit = False

	invoice_name = (result or {}).get("name")
	if not invoice_name:
		frappe.db.rollback(save_point=SAVEPOINT)
		store_failure(invoice, _("Server returned no invoice name."), device)
		return {**base, "status": "Failed", "error": _("Server returned no invoice name."), "stored": True}

	_record_success(invoice, invoice_name, device)
	return {
		**base,
		"status": "Synced",
		"invoice_name": invoice_name,
		"duplicate_prevented": bool(result.get("duplicate_prevented")),
		"grand_total": result.get("grand_total"),
	}


# ---------------------------------------------------------------------------
# whitelisted endpoints
# ---------------------------------------------------------------------------


@frappe.whitelist(methods=["POST"])
def submit_offline_invoice(invoice: str | dict, device_id: str | None = None) -> dict:
	"""Browser sync queue entry point (replaces a direct call to POS Next's submit_invoice)."""
	payload = _parse_json(invoice)
	return process_offline_invoice(payload, device_id)


@frappe.whitelist(methods=["POST"])
def submit_offline_invoices(invoices: str | list, device_id: str | None = None) -> list[dict]:
	"""Submit several queued invoices in one request (SPEC section 6: sync 500 in < 5 min).

	Each invoice is processed like ``submit_offline_invoice`` and committed on its own,
	so a confirmed ``Synced`` or ``Failed`` (stored) answer is durable even if a later
	invoice of the batch breaks. An invoice that cannot be processed now (lock timeout,
	access error, bad payload) answers ``Error`` with ``stored: False``: the browser keeps
	it and sends it again on its own. Answers keep the order of the request.
	"""
	require_pos_user()
	rows = _parse_json(invoices)
	if not isinstance(rows, list):
		frappe.throw(_("Invoices must be a list."))
	if len(rows) > MAX_BATCH:
		frappe.throw(_("Send at most {0} invoices at a time.").format(MAX_BATCH))

	results: list[dict] = []
	for invoice in rows:
		offline_id = invoice.get("offline_id") if isinstance(invoice, dict) else None
		frappe.db.savepoint(BATCH_SAVEPOINT)
		try:
			outcome = process_offline_invoice(invoice, device_id)
			if not frappe.flags.in_test:
				frappe.db.commit()  # nosemgrep: each answer must be durable before the next invoice
		except Exception as exc:
			message = error_text(exc)
			try:
				frappe.db.rollback(save_point=BATCH_SAVEPOINT)
			except Exception:
				frappe.db.rollback()
			_clear_messages()
			outcome = {
				"offline_id": offline_id,
				"status": "Error",
				"invoice_name": None,
				"error": message,
				"stored": False,
			}
		results.append(outcome)
	return results


@frappe.whitelist(methods=["POST"])
def retry_failed(offline_ids: str | list[str]) -> list[dict]:
	"""Re-submit stored payloads of Failed Offline Invoice Sync records."""
	require_pos_user()
	ids = _parse_json(offline_ids) or []
	if isinstance(ids, str):
		ids = [ids]
	results: list[dict] = []
	for offline_id in ids:
		row = frappe.db.get_value(
			OIS,
			{"offline_id": offline_id},
			["name", "status", "payload", "pos_profile", "pos_device", "sales_invoice"],
			as_dict=True,
		)
		if not row:
			results.append(_retry_result(offline_id, "Not Found", error=_("No sync record for this invoice.")))
			continue
		check_pos_profile_access(row.pos_profile)
		if row.status == "Synced":
			results.append(_retry_result(offline_id, "Synced", invoice_name=row.sales_invoice))
			continue
		if row.status != "Failed" or not row.payload:
			results.append(
				_retry_result(offline_id, row.status, error=_("Only failed invoices with a stored payload can be retried."))
			)
			continue
		payload = json.loads(row.payload)
		payload["offline_id"] = offline_id
		outcome = process_offline_invoice(payload, row.pos_device)
		results.append(_retry_result(offline_id, outcome["status"], outcome.get("invoice_name"), outcome.get("error")))
	return results


def _retry_result(offline_id: str, status: str, invoice_name: str | None = None, error: str | None = None) -> dict:
	return {"offline_id": offline_id, "status": status, "invoice_name": invoice_name, "error": error}


@frappe.whitelist()
def get_sync_status(device_id: str | None = None, limit: int = 50) -> dict:
	"""Offline Invoice Sync rows for this device (sync panel)."""
	require_pos_user()
	limit = max(1, min(cint(limit) or 50, 500))
	table = frappe.qb.DocType(OIS)
	query = (
		frappe.qb.from_(table)
		.select(
			table.offline_id,
			table.status,
			table.sales_invoice,
			table.error,
			table.grand_total,
			table.retry_count,
			table.last_attempt_at,
			table.creation,
			table.pos_profile,
			table.customer,
			table.pos_device,
		)
		.orderby(table.modified, order=frappe.qb.desc)
		.limit(limit)
	)
	if device_id:
		query = query.where(table.pos_device == device_id)
	profiles = allowed_pos_profiles()
	if profiles is not None:
		if not profiles:
			return {"rows": [], "failed_count": 0}
		query = query.where(table.pos_profile.isin(profiles))
	rows = query.run(as_dict=True)

	count_query = frappe.qb.from_(table).select(Count("*")).where(table.status == "Failed")
	if device_id:
		count_query = count_query.where(table.pos_device == device_id)
	if profiles is not None:
		count_query = count_query.where(table.pos_profile.isin(profiles))
	failed_count = cint(count_query.run()[0][0])
	return {"rows": rows, "failed_count": failed_count}


@frappe.whitelist(methods=["POST"])
def register_device(
	device_id: str,
	device_name: str | None = None,
	pos_profile: str | None = None,
	app_version: str | None = None,
) -> dict:
	"""Register this browser as a POS Device (called on login per browser)."""
	if pos_profile:
		check_pos_profile_access(pos_profile)
	else:
		require_pos_user()
	if not device_id:
		frappe.throw(_("Device ID is required"))
	user_agent = frappe.get_request_header("User-Agent") if frappe.request else None
	name = _upsert_device(device_id, pos_profile, device_name, app_version, user_agent)
	device = frappe.db.get_value(
		DEVICE, name, ["device_id", "device_name", "pos_profile", "last_seen"], as_dict=True
	)
	from pos_next.pos_0001.api.printing import resolve_printers

	printers = resolve_printers(pos_profile or device.pos_profile, device_id)
	return {**device, "printer_profiles": [p for p in (printers["receipt"], printers["label"]) if p]}
