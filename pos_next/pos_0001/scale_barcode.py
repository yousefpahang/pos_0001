# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Scale barcode logic (SPEC F5), server copy of POS/src/plus/core/scaleBarcode.js and ean.js.

Pure Python, no database access: the POS parses labels in the browser, and the server
runs the same rules again when the invoice arrives. Keep both copies in step.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

MIN_LENGTH = 8
MAX_LENGTH = 20


def is_digits(value: Any) -> bool:
	return isinstance(value, str) and value.isascii() and value.isdigit()


def gs1_check_digit(body: str) -> int:
	"""GS1 mod-10 check digit for a code body (weights 3,1,3,1... from the right)."""
	if not is_digits(body):
		raise ValueError(f"Not a digit string: {body!r}")
	total = 0
	for i, ch in enumerate(reversed(body)):
		total += int(ch) * (3 if i % 2 == 0 else 1)
	return (10 - total % 10) % 10


def has_valid_check_digit(code: str) -> bool:
	if not is_digits(code) or len(code) < 2:
		return False
	return gs1_check_digit(code[:-1]) == int(code[-1])


def round_to(value: float | Decimal, decimals: int) -> float:
	"""Round half away from zero without float surprises (0.8325 -> 0.833)."""
	quantum = Decimal(1).scaleb(-decimals)
	d = Decimal(str(value)).quantize(quantum, rounding=ROUND_HALF_UP)
	return float(d)


@dataclass(frozen=True)
class ScaleRule:
	name: str
	prefix: str
	total_length: int
	item_code_start: int
	item_code_length: int
	item_match: str  # "Scale PLU" | "Item Barcode"
	value_type: str  # "Weight" | "Price"
	value_start: int
	value_length: int
	decimals: int
	uom: str
	check_digit_mode: str  # "Validate" | "Ignore"
	priority: int

	@classmethod
	def from_dict(cls, raw: Any) -> ScaleRule:
		get = raw.get if hasattr(raw, "get") else lambda k, d=None: getattr(raw, k, d)
		return cls(
			name=str(get("name") or ""),
			prefix=str(get("prefix") or "").strip(),
			total_length=int(get("total_length") or 0),
			item_code_start=int(get("item_code_start") or 0),
			item_code_length=int(get("item_code_length") or 0),
			item_match="Item Barcode" if get("item_match") == "Item Barcode" else "Scale PLU",
			value_type="Price" if get("value_type") == "Price" else "Weight",
			value_start=int(get("value_start") or 0),
			value_length=int(get("value_length") or 0),
			decimals=int(get("decimals") or 0),
			uom=str(get("uom") or ""),
			check_digit_mode="Ignore" if get("check_digit_mode") == "Ignore" else "Validate",
			priority=int(get("priority") if get("priority") is not None else 10),
		)


def rule_errors(rule: ScaleRule) -> list[str]:
	"""Layout problems as short codes (same codes as ruleErrors in scaleBarcode.js)."""
	errors: list[str] = []
	n = rule.total_length
	if n < MIN_LENGTH or n > MAX_LENGTH:
		errors.append("total_length")
	if not (is_digits(rule.prefix) and 1 <= len(rule.prefix) <= 3):
		errors.append("prefix")
	segments = [
		("prefix", 1, len(rule.prefix)),
		("item_code", rule.item_code_start, rule.item_code_length),
		("value", rule.value_start, rule.value_length),
	]
	ranges = []
	for name, start, length in segments:
		if start < 1 or length < 1:
			errors.append(name)
			continue
		if start + length - 1 > n - 1:
			errors.append(f"{name}_past_check_digit")
		ranges.append((name, start, start + length - 1))
	for i in range(len(ranges)):
		for j in range(i + 1, len(ranges)):
			a, b = ranges[i], ranges[j]
			if a[1] <= b[2] and b[1] <= a[2]:
				errors.append(f"overlap_{a[0]}_{b[0]}")
	if rule.decimals < 0 or rule.decimals > 6:
		errors.append("decimals")
	return errors


def usable_rules(rules: list[Any]) -> list[ScaleRule]:
	out = []
	for raw in rules or []:
		try:
			rule = raw if isinstance(raw, ScaleRule) else ScaleRule.from_dict(raw)
		except (TypeError, ValueError):
			continue
		if not rule_errors(rule):
			out.append(rule)
	return sorted(out, key=lambda r: (r.priority, r.name))


@dataclass(frozen=True)
class ParsedBarcode:
	ok: bool
	barcode: str
	rule: ScaleRule
	plu: str = ""
	value: float = 0.0
	error: str | None = None

	@property
	def value_type(self) -> str:
		return self.rule.value_type


def parse_scale_barcode(barcode: str, rules: list[Any]) -> ParsedBarcode | None:
	"""Parse with the first rule (by priority) whose prefix and length match; None if none."""
	code = str(barcode or "").strip()
	if not is_digits(code):
		return None
	for rule in usable_rules(rules):
		if len(code) != rule.total_length or not code.startswith(rule.prefix):
			continue
		if rule.check_digit_mode == "Validate" and not has_valid_check_digit(code):
			return ParsedBarcode(ok=False, barcode=code, rule=rule, error="check_digit")
		plu = code[rule.item_code_start - 1 : rule.item_code_start - 1 + rule.item_code_length]
		digits = code[rule.value_start - 1 : rule.value_start - 1 + rule.value_length]
		value = float(Decimal(int(digits)).scaleb(-rule.decimals))
		return ParsedBarcode(ok=True, barcode=code, rule=rule, plu=plu, value=value)
	return None


def plu_candidates(plu: str) -> list[str]:
	stripped = plu.lstrip("0") or "0"
	return [plu] if stripped == plu else [plu, stripped]


def price_line(
	price: float, unit_rate: float, qty_decimals: int = 3, rate_decimals: int = 2, amount_decimals: int = 2
) -> dict | None:
	"""qty and rate for a price label so that round(qty * rate) is exactly the printed price.

	Same search as priceLine() in scaleBarcode.js: smallest change to the list rate,
	then the qty closest to price / rate.
	"""
	if not unit_rate or unit_rate <= 0 or not price or price <= 0:
		return None
	target = round_to(price, amount_decimals)
	step = 10.0**-qty_decimals
	rate_step = 10.0**-rate_decimals
	half = 5 * 10.0 ** -(amount_decimals + 1)
	ru = round_to(unit_rate, rate_decimals)
	q0 = max(round_to(target / unit_rate, qty_decimals), step)
	best = None
	for k in range(0, 501):
		for sign in [1] if k == 0 else [-1, 1]:
			qty = round_to(q0 + sign * k * step, qty_decimals)
			if qty <= 0:
				continue
			lo = round_to((target - half) / qty, rate_decimals)
			hi = round_to((target + half) / qty, rate_decimals)
			for raw in (ru, lo - rate_step, lo, lo + rate_step, hi - rate_step, hi, hi + rate_step):
				rate = round_to(raw, rate_decimals)
				if rate <= 0 or round_to(qty * rate, amount_decimals) != target:
					continue
				dev = abs(rate - unit_rate)
				if best is None or dev < best["dev"] - 1e-9:
					best = {"qty": qty, "rate": rate, "dev": dev}
		if best and k >= 1 and best["dev"] <= rate_step + 1e-9:
			break
	if best:
		return {"qty": best["qty"], "rate": best["rate"], "amount": target, "exact": True}
	rate = round_to(target / q0, rate_decimals)
	return {"qty": q0, "rate": rate, "amount": round_to(q0 * rate, amount_decimals), "exact": False}


def generate_scale_barcode(raw_rule: Any, plu: str, value: float) -> str:
	"""Barcode for a label: prefix, zero-padded PLU and value, valid check digit last."""
	rule = raw_rule if isinstance(raw_rule, ScaleRule) else ScaleRule.from_dict(raw_rule)
	if rule_errors(rule):
		raise ValueError("invalid_rule")
	plu = str(plu or "")
	if not is_digits(plu) or len(plu) > rule.item_code_length:
		raise ValueError("plu_length")
	if value is None or float(value) < 0:
		raise ValueError("value")
	scaled = str(int(Decimal(str(value)).scaleb(rule.decimals).quantize(Decimal(1), rounding=ROUND_HALF_UP)))
	if len(scaled) > rule.value_length:
		raise ValueError("value_length")
	digits = ["0"] * (rule.total_length - 1)

	def put(start: int, text: str) -> None:
		for i, ch in enumerate(text):
			digits[start - 1 + i] = ch

	put(1, rule.prefix)
	put(rule.item_code_start, plu.rjust(rule.item_code_length, "0"))
	put(rule.value_start, scaled.rjust(rule.value_length, "0"))
	body = "".join(digits)
	return body + str(gs1_check_digit(body))
