# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""UAE tax invoice helpers (SPEC section 7).

Mirrors ``POS/src/plus/core/receiptLabels.js`` and ``money.js``, so the till receipt and the
server print format "UAE Tax Invoice 80mm" show the same title, wording and amounts. The
Arabic wording comes from ``pos_next/translations/ar.csv`` (the browser copy is checked
against the same CSV by Vitest).
"""

from __future__ import annotations

import json
from typing import Any

import frappe
from frappe import _
from frappe.utils import cint, flt

AED_ARABIC = "د.إ"
SYMBOL_MODES = ("By language", "AED", AED_ARABIC)
TITLE_MODES = ("Tax Invoice", "Simplified Tax Invoice", "Auto")
PRINT_FORMAT = "UAE Tax Invoice 80mm"

# English wording of the receipt; Arabic through _(text, "ar").
LABELS = {
	"tax_invoice": "Tax Invoice",
	"simplified_tax_invoice": "Simplified Tax Invoice",
	"tax_credit_note": "Tax Credit Note",
	"trn": "TRN",
	"invoice_no": "Invoice No.",
	"credit_note_no": "Credit Note No.",
	"original_invoice": "Original invoice",
	"date": "Date",
	"till": "Till",
	"cashier": "Cashier",
	"sales_person": "Sales person",
	"customer": "Customer",
	"customer_trn": "Customer TRN",
	"net": "Total excl. VAT",
	"discount": "Discount",
	"vat": "VAT",
	"rounding": "Rounding",
	"total": "Total incl. VAT",
	"payments": "Payments",
	"change": "Change",
	"balance_due": "Balance due",
	"thank_you": "Thank you",
}


def base_lang(lang: str | None) -> str:
	return (lang or "en").lower().replace("_", "-").split("-")[0]


def currency_symbol(currency: str | None, lang: str | None = None, mode: str | None = None) -> str:
	"""AED -> "AED" or "د.إ" by setting (By language: Arabic -> "د.إ"). Others keep their code."""
	code = (currency or "").upper()
	if code != "AED":
		return code
	if mode in ("AED", AED_ARABIC):
		return mode
	return AED_ARABIC if base_lang(lang) == "ar" else "AED"


def amount2(value: Any) -> str:
	"""2 decimals, half away from zero, Western digits (same as money.js amount2)."""
	n = flt(value)
	sign = -1 if n < 0 else 1
	v = sign * int(abs(n) * 100 + 0.5 + 1e-9) / 100
	return f"{0 if v == 0 else v:.2f}"


def format_money(value: Any, currency: str | None, lang: str | None = None, mode: str | None = None) -> str:
	number = amount2(value)
	symbol = currency_symbol(currency, lang, mode)
	if not symbol:
		return number
	return f"{number} {symbol}" if symbol == AED_ARABIC else f"{symbol} {number}"


def receipt_title(is_return: Any, customer_tax_id: str | None, mode: str | None) -> str:
	"""English title. Returns are tax credit notes; Auto: full tax invoice only with a customer TRN."""
	if cint(is_return):
		return LABELS["tax_credit_note"]
	if mode == "Simplified Tax Invoice":
		return LABELS["simplified_tax_invoice"]
	if mode == "Auto":
		return LABELS["tax_invoice"] if (customer_tax_id or "").strip() else LABELS["simplified_tax_invoice"]
	return LABELS["tax_invoice"]


def bilingual(text: str) -> dict[str, str]:
	return {"en": text, "ar": _(text, "ar")}


def rate_text(rate: Any) -> str:
	value = round(flt(rate), 2)
	return f"{value:g}"


def vat_label(rate: Any) -> dict[str, str]:
	"""{"en": "VAT 5%", "ar": "ضريبة القيمة المضافة 5%"}"""
	text = rate_text(rate)
	return {"en": "VAT {0}%".replace("{0}", text), "ar": _("VAT {0}%", "ar").replace("{0}", text)}


def line_vat_rates(doc: Any) -> list[float | None]:
	"""VAT % of each item line: the item's own Item Tax Template rate for the invoice's
	"On Net Total" tax accounts, else the tax row's rate. None when the invoice has no
	such tax rows."""
	rows = [t for t in (doc.get("taxes") or []) if t.charge_type == "On Net Total"]
	if not rows:
		return [None for _row in doc.get("items") or []]
	rates = []
	for item in doc.get("items") or []:
		item_rates = {}
		if item.get("item_tax_rate"):
			try:
				item_rates = json.loads(item.item_tax_rate) or {}
			except (TypeError, ValueError):
				item_rates = {}
		total = 0.0
		for row in rows:
			total += flt(item_rates[row.account_head]) if row.account_head in item_rates else flt(row.rate)
		rates.append(round(total, 2))
	return rates


def settings_symbol_mode() -> str:
	mode = frappe.db.get_single_value("POS 0001 Settings", "currency_symbol")
	return mode if mode in SYMBOL_MODES else "By language"


def uae_receipt(doc: Any, lang: str | None = None) -> dict:
	"""Everything the "UAE Tax Invoice 80mm" print format shows, worked out once in Python."""
	lang = lang or frappe.local.lang
	profile = (
		frappe.db.get_value(
			"POS Profile",
			doc.pos_profile,
			["pos0001_invoice_title", "pos0001_receipt_footer", "pos0001_receipt_logo"],
			as_dict=True,
		)
		if doc.get("pos_profile")
		else None
	) or frappe._dict()
	mode = settings_symbol_mode()
	currency = doc.currency

	def money(value: Any) -> str:
		return format_money(value, currency, lang, mode)

	from pos_next.pos_0001.api.printing import company_details

	company = company_details(doc.company)
	rates = line_vat_rates(doc)
	distinct = {r for r in rates if r is not None}
	codes = list({row.item_code for row in doc.items if row.item_code})
	arabic = {}
	if codes and frappe.db.has_column("Item", "item_name_ar"):
		arabic = dict(
			frappe.get_all("Item", filters={"name": ["in", codes]}, fields=["name", "item_name_ar"], as_list=True)
		)
	lines = []
	for row, rate in zip(doc.items, rates, strict=False):
		lines.append(
			{
				"name": row.item_name or row.item_code,
				"name_ar": arabic.get(row.item_code) or "",
				"qty": f"{round(flt(row.qty), 3):g}",
				"uom": row.uom or "",
				"rate": amount2(row.rate),
				"amount": amount2(row.amount),
				"vat": vat_label(rate)["en"] if len(distinct) > 1 and rate is not None else "",
			}
		)
	taxes = []
	for tax in doc.get("taxes") or []:
		value = flt(tax.tax_amount_after_discount_amount or tax.tax_amount)
		if not value:
			continue
		label = vat_label(tax.rate) if tax.charge_type == "On Net Total" else {"en": tax.description, "ar": ""}
		taxes.append({"label": label, "amount": money(value)})
	mode_types = {}
	modes = [p.mode_of_payment for p in doc.get("payments") or []]
	if modes:
		mode_types = dict(
			frappe.get_all("Mode of Payment", filters={"name": ["in", modes]}, fields=["name", "type"], as_list=True)
		)
	rounded = 0 if cint(doc.get("disable_rounded_total")) else flt(doc.rounded_total)
	total = rounded or flt(doc.grand_total)
	customer_tax_id = doc.get("tax_id") or ""
	title = receipt_title(doc.is_return, customer_tax_id, profile.pos0001_invoice_title)
	sales_persons = [row.sales_person for row in doc.get("sales_team") or [] if row.sales_person]
	labels = {key: bilingual(text) for key, text in LABELS.items()}
	return {
		"labels": labels,
		"title": bilingual(title),
		"is_return": cint(doc.is_return),
		"company": company,
		"symbol": currency_symbol(currency, lang, mode),
		"cashier": frappe.utils.get_fullname(doc.owner),
		"sales_persons": ", ".join(sales_persons),
		"customer_tax_id": customer_tax_id,
		"time": str(doc.posting_time or "")[:5],
		"lines": lines,
		"net": money(doc.net_total),
		"discount": amount2(doc.discount_amount) if flt(doc.discount_amount) else "",
		"taxes": taxes,
		"tax_total": money(doc.total_taxes_and_charges),
		"rounding": amount2(doc.rounding_adjustment) if rounded and flt(doc.rounding_adjustment) else "",
		"total": money(total),
		"payments": [
			{"mode": p.mode_of_payment, "amount": amount2(p.amount), "is_cash": mode_types.get(p.mode_of_payment) == "Cash"}
			for p in doc.get("payments") or []
			if flt(p.amount)
		],
		"change": money(doc.change_amount) if flt(doc.get("change_amount")) else "",
		"outstanding": money(doc.outstanding_amount) if flt(doc.get("outstanding_amount")) > 0.004 else "",
		"footer": profile.pos0001_receipt_footer or "",
		"logo": profile.pos0001_receipt_logo or "",
	}
