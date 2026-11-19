# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Barcode bar patterns for labels drawn as images or SVG (SPEC F4).

Same logic as POS/src/plus/core/code128.js and ean.js, so the A4 sheet made on the server
matches the one the POS prints offline.
"""

from __future__ import annotations

from pos_next.pos_0001.scale_barcode import has_valid_check_digit, is_digits

# Bar/space widths of the 107 Code128 symbols (values 0-105 and Stop).
PATTERNS = (
	"212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
	"221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
	"221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
	"212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
	"231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
	"231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
	"314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
	"112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
	"111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
	"214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
	"114131", "311141", "411131", "211412", "211214", "211232", "2331112",
)  # fmt: skip

START_B = 104
START_C = 105
CODE_B = 100
CODE_C = 99
STOP = 106

# EAN-13 digit patterns (7 modules each) and the parity of the left half per first digit.
EAN_L = ("0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011")
EAN_G = ("0100111", "0110011", "0011011", "0100001", "0011101", "0111001", "0000101", "0010001", "0001001", "0010111")
EAN_R = ("1110010", "1100110", "1101100", "1000010", "1011100", "1001110", "1010000", "1000100", "1001000", "1110100")
EAN_PARITY = ("LLLLLL", "LLGLGG", "LLGGLG", "LLGGGL", "LGLLGG", "LGGLLG", "LGGGLL", "LGLGLG", "LGLGGL", "LGGLGL")


def _digit_run(s: str, i: int) -> int:
	n = 0
	while i + n < len(s) and "0" <= s[i + n] <= "9":
		n += 1
	return n


def encode_code128(text: str) -> list[int]:
	"""Symbol values (start, data, checksum, stop): set B, set C for digit runs."""
	s = str(text or "")
	if not s:
		raise ValueError("Code128 needs a value")
	if any(ord(c) < 32 or ord(c) > 126 for c in s):
		raise ValueError("Code128 value must be printable ASCII")
	values: list[int] = []
	if _digit_run(s, 0) == len(s) and len(s) >= 2 and len(s) % 2 == 0:
		values.append(START_C)
		code_set = "C"
	else:
		values.append(START_B)
		code_set = "B"
	i = 0
	while i < len(s):
		run = _digit_run(s, i)
		if code_set == "C":
			if run >= 2:
				values.append(int(s[i : i + 2]))
				i += 2
				continue
			values.append(CODE_B)
			code_set = "B"
			continue
		at_end = i + run == len(s)
		if (at_end and run >= 4) or run >= 6:
			if run % 2 == 1:
				values.append(ord(s[i]) - 32)
				i += 1
			values.append(CODE_C)
			code_set = "C"
			continue
		values.append(ord(s[i]) - 32)
		i += 1
	total = values[0] + sum(v * k for k, v in enumerate(values[1:], start=1))
	values.extend([total % 103, STOP])
	return values


def code128_modules(text: str) -> str:
	"""'1' (bar) / '0' (space) per module, stop pattern included, no quiet zones."""
	out = []
	for value in encode_code128(text):
		for k, width in enumerate(PATTERNS[value]):
			out.append(("1" if k % 2 == 0 else "0") * int(width))
	return "".join(out)


def ean13_modules(code: str) -> str:
	"""95 modules of a valid EAN-13."""
	digits = str(code or "")
	if not is_ean13(digits):
		raise ValueError("Not a valid EAN-13")
	parity = EAN_PARITY[int(digits[0])]
	left = "".join((EAN_L if parity[i] == "L" else EAN_G)[int(d)] for i, d in enumerate(digits[1:7]))
	right = "".join(EAN_R[int(d)] for d in digits[7:13])
	return "101" + left + "01010" + right + "101"


def is_ean13(code: str) -> bool:
	"""13 digits with a valid check digit (anything else prints as Code128)."""
	code = str(code or "")
	return is_digits(code) and len(code) == 13 and has_valid_check_digit(code)
