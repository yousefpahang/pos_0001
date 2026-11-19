# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Sales person rules (SPEC F6), pure Python.

Mirrors POS/src/plus/core/salesPerson.js so the browser (offline) and the server agree on
the mode and on how a sale is split between several sales persons.
"""

from __future__ import annotations

from dataclasses import dataclass

MODES = ("Off", "Optional", "Mandatory")
PERCENT_DECIMALS = 2
# A split whose total is this close to 100 % is treated as rounding drift and fixed.
DRIFT_TOLERANCE = 0.05


@dataclass(frozen=True)
class SalesPersonMode:
	mode: str  # Off / Optional / Mandatory (effective)
	multiple: bool

	@property
	def enabled(self) -> bool:
		return self.mode != "Off"

	@property
	def required(self) -> bool:
		return self.mode == "Mandatory"

	def as_dict(self) -> dict:
		return {
			"mode": self.mode,
			"multiple": self.multiple,
			"enabled": self.enabled,
			"required": self.required,
		}


def resolve_mode(profile_mode: str | None, pos_next_mode: str | None) -> SalesPersonMode:
	"""Effective mode from POS Profile ``pos0001_sales_person_mode`` and POS Next's setting.

	- Optional / Mandatory on the POS Profile decide.
	- Off (or empty) keeps POS Next's behaviour: POS Settings ``enable_sales_persons``
	  Disabled means off; Single or Multiple means mandatory.
	- Several sales persons per sale only when POS Next's setting is Multiple.
	"""
	pos_next_mode = pos_next_mode or "Disabled"
	multiple = pos_next_mode == "Multiple"
	if profile_mode in ("Optional", "Mandatory"):
		return SalesPersonMode(profile_mode, multiple)
	if pos_next_mode in ("Single", "Multiple"):
		return SalesPersonMode("Mandatory", multiple)
	return SalesPersonMode("Off", False)


def _round(value: float, decimals: int = PERCENT_DECIMALS) -> float:
	# Half-up on a scaled integer; avoids binary float surprises like 33.335.
	factor = 10**decimals
	return int(abs(value) * factor + 0.5 + 1e-9) / factor * (1 if value >= 0 else -1)


def split_evenly(count: int, decimals: int = PERCENT_DECIMALS) -> list[float]:
	"""Split 100 % into ``count`` shares with ``decimals`` places that add up to exactly 100.

	The first rows take the leftover hundredths: 3 -> [33.34, 33.33, 33.33].
	"""
	if count <= 0:
		return []
	units = 100 * 10**decimals
	base, extra = divmod(units, count)
	return [(base + (1 if i < extra else 0)) / 10**decimals for i in range(count)]


def normalize_allocation(percentages: list[float], decimals: int = PERCENT_DECIMALS) -> list[float]:
	"""Round each share and put any rounding drift (within DRIFT_TOLERANCE) on the last row.

	Splits that are really off (for example 50 + 30) are returned rounded but not forced
	to 100, so ERPNext still rejects them.
	"""
	if not percentages:
		return []
	rounded = [_round(float(p or 0), decimals) for p in percentages]
	drift = _round(100 - sum(rounded), decimals)
	if drift and abs(drift) <= DRIFT_TOLERANCE:
		rounded[-1] = _round(rounded[-1] + drift, decimals)
	return rounded


def allocation_total(percentages: list[float], decimals: int = PERCENT_DECIMALS) -> float:
	return _round(sum(float(p or 0) for p in percentages), decimals)
