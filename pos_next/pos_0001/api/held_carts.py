# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Held (parked) carts on the server (SPEC F7, DECISIONS.md item 6).

A held cart is a draft Sales Invoice (``docstatus = 0``) with ``pos0001_held = 1``. It is built by
POS Next's own ``update_invoice()`` from the same payload the till uses for drafts, so ERPNext
computes its totals. The exact cart (lines, offers, sales persons) is kept as JSON in
``pos0001_held_cart`` so the till restores it as it was.

- Any till of the same POS Profile lists and resumes it. Resuming claims the cart: the draft is
  deleted in the same transaction, under a row lock, so two tills cannot resume the same cart.
- ``pos0001_hold_id`` (from the till, ``HOLD-<uuid>``) is also the draft's name, so held carts never
  use a number of the Sales Invoice naming series (no gaps in tax invoice numbers). It makes uploads
  idempotent: a cart held offline and uploaded twice gives one draft, and a cart already resumed
  (its Deleted Document exists) is not created again.
- Held drafts never get ``posa_pos_opening_shift``, so POS Next's shift close does not delete
  them; ``cleanup_held_carts`` (daily) deletes those older than the retention days.
"""

from __future__ import annotations

import json
import re
from typing import Any

import frappe
from frappe import _
from frappe.utils import add_days, cint, get_datetime, now_datetime

from pos_next.pos_0001.permissions import check_pos_profile_access

SI = "Sales Invoice"
DEVICE = "POS Device"
SAVEPOINT = "pos0001_hold_cart"
HOLD_ID_RE = re.compile(r"^HOLD-[A-Za-z0-9-]{8,59}$")
MAX_NOTE_LENGTH = 500
MAX_CART_BYTES = 2 * 1024 * 1024
DEFAULT_RETENTION_DAYS = 3
# Fields of the till's draft payload that must not be stored on a held draft.
DROPPED_FIELDS = (
	"name",
	"payments",
	"posa_pos_opening_shift",
	"offline_id",
	"docstatus",
	"amended_from",
	"pos0001_held",
	"pos0001_hold_id",
	"pos0001_held_cart",
	"pos0001_held_at",
	"pos0001_held_by",
	"pos0001_hold_note",
)


def _parse(value: Any) -> Any:
	if isinstance(value, str):
		return json.loads(value) if value else None
	return value


def retention_days() -> int:
	value = frappe.db.get_single_value("POS 0001 Settings", "held_cart_retention_days")
	return DEFAULT_RETENTION_DAYS if value is None else cint(value)


def _check_hold_id(hold_id: str | None) -> str:
	hold_id = (hold_id or "").strip()
	if not HOLD_ID_RE.match(hold_id):
		frappe.throw(_("The held cart has no valid id. Update the POS and try again."))
	return hold_id


def _held_at(value: Any) -> Any:
	"""The till's hold time (offline carts keep the time they were parked), never in the future."""
	now = now_datetime()
	if not value:
		return now
	try:
		when = get_datetime(value)
	except Exception:
		return now
	if when.tzinfo is not None:
		# The till sends UTC ISO strings; store system-local naive time like Frappe does.
		from frappe.utils import convert_utc_to_system_timezone

		when = convert_utc_to_system_timezone(when).replace(tzinfo=None)
	return min(when, now)


def _device(device_id: str | None) -> str | None:
	if device_id and frappe.db.exists(DEVICE, device_id):
		return device_id
	return None


def _summary(name: str) -> dict:
	row = _held_query(names=[name])
	return row[0] if row else {}


def _held_query(pos_profile: str | None = None, names: list[str] | None = None) -> list[dict]:
	si = frappe.qb.DocType(SI)
	user = frappe.qb.DocType("User")
	device = frappe.qb.DocType(DEVICE)
	query = (
		frappe.qb.from_(si)
		.left_join(user)
		.on(user.name == si.pos0001_held_by)
		.left_join(device)
		.on(device.name == si.pos_device)
		.select(
			si.name,
			si.pos0001_hold_id.as_("hold_id"),
			si.pos_profile,
			si.customer,
			si.customer_name,
			si.grand_total,
			si.rounded_total,
			si.currency,
			si.total_qty,
			si.pos0001_held_at.as_("held_at"),
			si.pos0001_held_by.as_("held_by"),
			user.full_name.as_("held_by_name"),
			si.pos0001_hold_note.as_("note"),
			si.pos_device,
			device.device_name.as_("device_name"),
		)
		.where((si.pos0001_held == 1) & (si.docstatus == 0))
		.orderby(si.pos0001_held_at, order=frappe.qb.desc)
	)
	if pos_profile:
		query = query.where(si.pos_profile == pos_profile)
	if names:
		query = query.where(si.name.isin(names))
	rows = query.run(as_dict=True)
	_attach_lines(rows)
	return rows


def _attach_lines(rows: list[dict]) -> None:
	"""Short line list per held cart (name, qty, rate, amount) for the held list."""
	if not rows:
		return
	item = frappe.qb.DocType("Sales Invoice Item")
	lines = (
		frappe.qb.from_(item)
		.select(item.parent, item.item_code, item.item_name, item.qty, item.uom, item.rate, item.amount)
		.where(item.parent.isin([r.name for r in rows]))
		.orderby(item.idx)
		.run(as_dict=True)
	)
	by_parent: dict[str, list[dict]] = {}
	for line in lines:
		parent = line.pop("parent")
		by_parent.setdefault(parent, []).append(line)
	for row in rows:
		row["items"] = by_parent.get(row.name, [])
		row["item_count"] = len(row["items"])
		row["held_at_utc"] = _utc_iso(row.get("held_at"))


def _utc_iso(value: Any) -> str | None:
	"""Server time (system time zone, naive) as UTC ISO, so every till shows its own local time."""
	if not value:
		return None
	from zoneinfo import ZoneInfo

	from frappe.utils import get_system_timezone

	when = get_datetime(value).replace(tzinfo=ZoneInfo(get_system_timezone()))
	return when.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_draft_payload(invoice: dict | None, cart: dict, pos_profile: str) -> dict:
	"""Invoice dict for POS Next's ``update_invoice()``: the till's payload without payments,
	shift or offline id, plus the held-cart fields set by ``hold_cart``."""
	data = {k: v for k, v in (invoice or {}).items() if k not in DROPPED_FIELDS}
	data["doctype"] = SI
	data["is_pos"] = 1
	data["pos_profile"] = pos_profile
	if not data.get("customer"):
		customer = cart.get("customer")
		data["customer"] = customer.get("name") if isinstance(customer, dict) else customer
	if not data.get("items"):
		frappe.throw(_("Cannot hold an empty cart."))
	return data


# ---------------------------------------------------------------------------
# whitelisted endpoints
# ---------------------------------------------------------------------------


@frappe.whitelist(methods=["POST"])
def hold_cart(
	pos_profile: str,
	hold_id: str,
	cart: str | dict,
	invoice: str | dict | None = None,
	note: str | None = None,
	device_id: str | None = None,
	held_at: str | None = None,
) -> dict:
	"""Store a parked cart as a held draft Sales Invoice.

	Returns ``{"status": "Held", "held": {...}}``, or ``{"status": "Failed", "error": ...}`` when
	ERPNext rejects the draft (the till then keeps its local copy and shows the reason), or
	``{"status": "Resumed"}`` when this cart was already resumed on a till.
	"""
	check_pos_profile_access(pos_profile)
	hold_id = _check_hold_id(hold_id)
	cart = _parse(cart) or {}
	invoice = _parse(invoice) or {}
	if not isinstance(cart, dict) or not isinstance(invoice, dict):
		frappe.throw(_("The held cart data is not valid."))
	cart_json = json.dumps(cart, separators=(",", ":"), default=str)
	if len(cart_json.encode()) > MAX_CART_BYTES:
		frappe.throw(_("This cart is too large to hold. Split it into smaller carts."))

	existing = frappe.db.get_value(SI, {"pos0001_hold_id": hold_id}, ["name", "docstatus"], as_dict=True)
	if existing:
		return {"status": "Held", "held": _summary(existing.name)}
	if frappe.db.exists("Deleted Document", {"deleted_doctype": SI, "deleted_name": hold_id}):
		return {"status": "Resumed"}

	data = build_draft_payload(invoice, cart, pos_profile)
	data.update(
		{
			"pos0001_held": 1,
			"pos0001_hold_id": hold_id,
			"pos0001_held_cart": cart_json,
			"pos0001_held_at": _held_at(held_at),
			"pos0001_held_by": frappe.session.user,
			"pos0001_hold_note": (note or "").strip()[:MAX_NOTE_LENGTH] or None,
			"pos_device": _device(device_id),
		}
	)

	from pos_next.api.invoices import update_invoice
	from pos_next.pos_0001.api.sync import error_text

	frappe.db.savepoint(SAVEPOINT)
	try:
		doc = update_invoice(data)
	except frappe.DuplicateEntryError:
		frappe.db.rollback(save_point=SAVEPOINT)
		frappe.clear_messages()
		name = frappe.db.get_value(SI, {"pos0001_hold_id": hold_id}, "name")
		if name:
			return {"status": "Held", "held": _summary(name)}
		raise
	except (frappe.ValidationError, frappe.PermissionError) as exc:
		frappe.db.rollback(save_point=SAVEPOINT)
		message = error_text(exc)
		frappe.clear_messages()
		return {"status": "Failed", "error": message}
	return {"status": "Held", "held": _summary(doc.get("name"))}


@frappe.whitelist()
def list_held_carts(pos_profile: str) -> dict:
	"""Held carts of a POS Profile, newest first, for the held list on any of its tills."""
	check_pos_profile_access(pos_profile)
	return {"held": _held_query(pos_profile=pos_profile), "retention_days": retention_days()}


def _lock_held(name: str | None, hold_id: str | None) -> dict | None:
	si = frappe.qb.DocType(SI)
	query = (
		frappe.qb.from_(si)
		.select(si.name, si.pos_profile, si.docstatus, si.pos0001_held, si.pos0001_hold_id, si.pos0001_held_cart)
		.for_update()
	)
	if name:
		query = query.where(si.name == name)
	else:
		query = query.where(si.pos0001_hold_id == hold_id)
	rows = query.run(as_dict=True)
	row = rows[0] if rows else None
	if not row or not cint(row.pos0001_held) or cint(row.docstatus) != 0:
		return None
	return row


def _gone() -> None:
	frappe.throw(
		_("This held cart was already resumed on another till or removed. Refresh the held list."),
		frappe.DoesNotExistError,
	)


def _delete_held(row: dict) -> None:
	# Not permanent: the Deleted Document is the audit trail and stops a late re-upload.
	frappe.delete_doc(SI, row.name, force=True, ignore_permissions=True)


def before_insert(doc, method: str | None = None) -> None:
	"""Sales Invoice before_insert: a held draft is named by its hold id, not the naming series."""
	if cint(doc.get("pos0001_held")) and doc.get("pos0001_hold_id") and HOLD_ID_RE.match(doc.pos0001_hold_id):
		doc.name = doc.pos0001_hold_id
		doc.flags.name_set = True


@frappe.whitelist(methods=["POST"])
def resume_held_cart(pos_profile: str, name: str | None = None, hold_id: str | None = None) -> dict:
	"""Claim a held cart: returns the cart and deletes the held draft in one transaction."""
	check_pos_profile_access(pos_profile)
	if not name and not hold_id:
		frappe.throw(_("Choose a held cart to resume."))
	row = _lock_held(name, hold_id)
	if not row:
		_gone()
	if row.pos_profile != pos_profile:
		frappe.throw(
			_("This cart was held on POS Profile {0}. Open that profile to resume it.").format(row.pos_profile),
			frappe.PermissionError,
		)
	summary = _summary(row.name)
	cart = json.loads(row.pos0001_held_cart or "{}")
	_delete_held(row)
	return {"cart": cart, "held": summary}


@frappe.whitelist(methods=["POST"])
def delete_held_cart(pos_profile: str, name: str | None = None, hold_id: str | None = None) -> dict:
	"""Remove a held cart without resuming it."""
	check_pos_profile_access(pos_profile)
	row = _lock_held(name, hold_id)
	if not row:
		_gone()
	if row.pos_profile != pos_profile:
		frappe.throw(_("This cart belongs to POS Profile {0}.").format(row.pos_profile), frappe.PermissionError)
	_delete_held(row)
	return {"status": "Deleted", "name": row.name}


# ---------------------------------------------------------------------------
# scheduler
# ---------------------------------------------------------------------------


def cleanup_held_carts(days: int | None = None) -> int:
	"""Delete held drafts older than ``held_cart_retention_days`` (0 = keep them). Daily job."""
	days = retention_days() if days is None else cint(days)
	if days <= 0:
		return 0
	cutoff = add_days(now_datetime(), -days)
	si = frappe.qb.DocType(SI)
	names = (
		frappe.qb.from_(si)
		.select(si.name)
		.where((si.pos0001_held == 1) & (si.docstatus == 0) & (si.pos0001_held_at < cutoff))
		.run(pluck=True)
	)
	deleted = 0
	for name in names:
		try:
			frappe.delete_doc(SI, name, force=True, ignore_permissions=True)
			deleted += 1
		except Exception:
			frappe.log_error(frappe.get_traceback(), f"Held cart cleanup failed: {name}")
	if deleted:
		frappe.db.commit()
	return deleted
