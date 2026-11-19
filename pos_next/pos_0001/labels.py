# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt
"""Barcode label rendering (SPEC F4), server copy of POS/src/plus/core/labels.js.

A POS Label Template has a Jinja body. The POS renders labels in the browser (offline), so
the body is limited to a small part of Jinja that the browser renders the same way:

- ``{{ name }}``: a label value (item_name, price_label, ...), escaped for the language.
- ``{{ helper(arg, ...) }}``: ``draw_barcode``, ``draw_arabic`` or ``fit``; args are
  numbers, quoted strings or value names.
- ``{% if name %}``, ``{% if not name %}``, ``{% elif ... %}``, ``{% else %}``, ``{% endif %}``.

Rendering uses Jinja's sandbox with ``trim_blocks`` and ``lstrip_blocks``. Pure Python apart
from the Arabic bitmap (Pillow), no database access. Label command layout (``^BY``/``^BC``/
``^BE``, EPL ``B``, ``mm_to_dots``, ZPL escaping) is adapted from POS Awesome's
``useZplGenerator.ts`` (GPL-3.0, see NOTICE.md).
"""

from __future__ import annotations

import base64
import html
import math
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pos_next.pos_0001.barcodes import code128_modules, ean13_modules, is_ean13

LANGUAGES = ("ZPL", "EPL", "TSPL", "PDF")
RAW_LANGUAGES = ("ZPL", "EPL", "TSPL")
BARCODE_TYPES = ("Code128", "EAN13")
NEWLINE = {"ZPL": "\n", "EPL": "\n", "TSPL": "\r\n", "PDF": "\n"}

VARIABLES = frozenset(
	{
		"item_code",
		"item_name",
		"item_name_ar",
		"barcode",
		"barcode_type",
		"uom",
		"price",
		"price_label",
		"currency",
		"company",
		"date",
		"weight",
		"qty",
		"width_mm",
		"height_mm",
		"width_dots",
		"height_dots",
		"gap_mm",
		"gap_dots",
		"dpi",
	}
)
FUNCTIONS = frozenset({"draw_barcode", "draw_arabic", "fit"})

MAX_ROWS = 500
MAX_QTY = 999
MAX_LABELS = 2000
A4_WIDTH_MM = 210
A4_HEIGHT_MM = 297
FONT_STACK = "'DejaVu Sans', 'Noto Sans', Arial, sans-serif"

_IDENT = r"[A-Za-z_][A-Za-z0-9_]*"
_ARG = rf"(?:-?\d+(?:\.\d+)?|'[^'\\]*'|\"[^\"\\]*\"|{_IDENT})"
EXPR_RE = re.compile(rf"^\s*({_IDENT})\s*(?:\(\s*((?:{_ARG})(?:\s*,\s*{_ARG})*)?\s*\))?\s*$")
ARG_RE = re.compile(rf"\s*({_ARG})\s*(?:,|$)")
COND_RE = re.compile(rf"^\s*(not\s+)?({_IDENT})\s*$")
TAG_RE = re.compile(r"\{\{(.*?)\}\}|\{%(.*?)%\}|\{#", re.S)
QTY_RE = re.compile(r"\bqty\b")


class LabelTemplateError(ValueError):
	"""A template body outside the supported Jinja subset (message is for managers)."""


# ---------------------------------------------------------------------------
# Small helpers shared with the browser copy
# ---------------------------------------------------------------------------


def fmt_number(value: float) -> str:
	"""Up to 3 decimals, no trailing zeros (38 -> "38", 37.125 -> "37.125")."""
	s = f"{float(value):.3f}"
	s = s.rstrip("0").rstrip(".")
	return "0" if s in ("", "-0") else s


def mm_to_dots(mm: float, dpi: int) -> int:
	return round(float(mm) * int(dpi) / 25.4)


def _strip_controls(value: str) -> str:
	return re.sub(r"[\x00-\x1f\x7f]", " ", value)


def escape_for(language: str, value: Any) -> str:
	"""Make a value safe inside the template's language."""
	text = "" if value is None else str(value)
	if language == "PDF":
		return html.escape(text, quote=True)
	text = _strip_controls(text)
	if language == "ZPL":
		return text.replace("^", " ").replace("~", " ")
	if language == "EPL":
		text = "".join(c if 32 <= ord(c) < 127 else "?" for c in text)
		return text.replace("\\", "\\\\").replace('"', '\\"')
	if language == "TSPL":
		return text.replace('"', '\\["]')
	return text


def fit_text(value: Any, length: Any) -> str:
	text = "" if value is None else str(value)
	n = max(int(float(length or 0)), 0)
	return text[:n]


# ---------------------------------------------------------------------------
# Template subset: validation (same rules as the browser renderer)
# ---------------------------------------------------------------------------


def _check_expr(expr: str) -> None:
	m = EXPR_RE.match(expr)
	if not m:
		raise LabelTemplateError(f"Unsupported expression: {{{{{expr}}}}}")
	name, args = m.group(1), m.group(2)
	is_call = "(" in expr
	if is_call:
		if name not in FUNCTIONS:
			raise LabelTemplateError(f"Unknown helper {name}(). Use draw_barcode(), draw_arabic() or fit().")
		for arg in ARG_RE.findall(args or ""):
			if re.fullmatch(_IDENT, arg) and arg not in VARIABLES:
				raise LabelTemplateError(f"Unknown value {arg} in {name}().")
	elif name not in VARIABLES:
		raise LabelTemplateError(f"Unknown value {{{{ {name} }}}}.")


def validate_body(body: str) -> None:
	"""Raise LabelTemplateError unless the body is in the supported Jinja subset."""
	depth = 0
	for m in TAG_RE.finditer(body or ""):
		token = m.group(0)
		if token == "{#":
			raise LabelTemplateError("Comments ({# #}) are not supported in label templates.")
		inner = m.group(1) if m.group(1) is not None else m.group(2)
		if inner.startswith(("-", "+")) or inner.endswith(("-", "+")):
			raise LabelTemplateError("Whitespace control (- or +) is not supported in label templates.")
		if m.group(1) is not None:
			_check_expr(inner)
			continue
		words = inner.split()
		keyword = words[0] if words else ""
		if keyword in ("if", "elif"):
			if keyword == "elif" and depth == 0:
				raise LabelTemplateError("{% elif %} without {% if %}.")
			if not COND_RE.match(inner.strip()[len(keyword) :]):
				raise LabelTemplateError(f"Unsupported condition: {{% {inner.strip()} %}}")
			cond = COND_RE.match(inner.strip()[len(keyword) :]).group(2)
			if cond not in VARIABLES:
				raise LabelTemplateError(f"Unknown value {cond} in {{% {keyword} %}}.")
			if keyword == "if":
				depth += 1
		elif keyword == "else" and len(words) == 1:
			if depth == 0:
				raise LabelTemplateError("{% else %} without {% if %}.")
		elif keyword == "endif" and len(words) == 1:
			if depth == 0:
				raise LabelTemplateError("{% endif %} without {% if %}.")
			depth -= 1
		else:
			raise LabelTemplateError(f"Unsupported tag: {{% {inner.strip()} %}}")
	if depth:
		raise LabelTemplateError("{% if %} without {% endif %}.")
	rest = TAG_RE.sub("", body or "")
	if "{{" in rest or "{%" in rest or "}}" in rest or "%}" in rest:
		raise LabelTemplateError("Unclosed {{ or {% in the template.")


def uses_qty(body: str) -> bool:
	"""Templates that print their own copies ({{ qty }}) are rendered once per row."""
	for m in TAG_RE.finditer(body or ""):
		inner = m.group(1) if m.group(1) is not None else (m.group(2) or "")
		if QTY_RE.search(inner):
			return True
	return False


# ---------------------------------------------------------------------------
# Bitmaps (Arabic text on thermal labels)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Bitmap:
	width: int
	height: int
	bytes_per_row: int
	data: bytes  # bit-packed rows, MSB first, 1 = black


BitmapRenderer = Callable[[str, int, int], Bitmap]


def pack_bits(width: int, height: int, is_black: Callable[[int, int], bool]) -> Bitmap:
	bpr = (width + 7) // 8
	out = bytearray(bpr * height)
	for y in range(height):
		for x in range(width):
			if is_black(x, y):
				out[y * bpr + (x >> 3)] |= 0x80 >> (x & 7)
	return Bitmap(width, height, bpr, bytes(out))


def fake_bitmap(text: str, height: int, max_width: int) -> Bitmap:
	"""Deterministic stand-in used by tests in both languages."""
	width = max(1, min(int(max_width), 4 * len(text)))
	h = max(1, min(int(height), 6))
	return pack_bits(width, h, lambda x, y: (x + y) % 3 == 0)


def bitmap_command(language: str, x: int, y: int, bitmap: Bitmap) -> bytes:
	"""ZPL ^GFA (1 = black, hex) or EPL GW / TSPL BITMAP (binary, 0 = black)."""
	if language == "ZPL":
		total = len(bitmap.data)
		hexdata = bitmap.data.hex().upper()
		return f"^FO{x},{y}^GFA,{total},{total},{bitmap.bytes_per_row},{hexdata}^FS".encode()
	inverted = bytes(b ^ 0xFF for b in bitmap.data)
	if language == "EPL":
		return f"GW{x},{y},{bitmap.bytes_per_row},{bitmap.height},".encode() + inverted
	if language == "TSPL":
		return f"BITMAP {x},{y},{bitmap.bytes_per_row},{bitmap.height},0,".encode() + inverted
	raise ValueError(language)


# ---------------------------------------------------------------------------
# Barcodes
# ---------------------------------------------------------------------------


def barcode_command(language: str, value: str, kind: str, x: int, y: int, height: int, module: int) -> str:
	ean = kind == "EAN13"
	data = value[:12] if ean else value
	if language == "ZPL":
		data = data.replace("^", " ").replace("~", " ")
		if ean:
			return f"^FO{x},{y}^BY{module},3,{height}^BEN,{height},Y,N^FD{data}^FS"
		data = data.replace(">", "><")
		return f"^FO{x},{y}^BY{module},3,{height}^BCN,{height},Y,N,N^FD{data}^FS"
	if language == "EPL":
		data = data.replace("\\", "\\\\").replace('"', '\\"')
		return f'B{x},{y},0,{"E30" if ean else "1"},{module},{module},{height},B,"{data}"'
	if language == "TSPL":
		data = data.replace('"', '\\["]')
		return f'BARCODE {x},{y},"{"EAN13" if ean else "128"}",{height},1,0,{module},{module},"{data}"'
	raise ValueError(language)


def barcode_svg(value: str, kind: str, height_mm: float) -> str:
	"""Inline SVG barcode for the A4 sheet, with the digits under it."""
	modules = ean13_modules(value) if kind == "EAN13" else code128_modules(value)
	quiet = 10
	total = len(modules) + 2 * quiet
	rects = []
	i = 0
	while i < len(modules):
		if modules[i] == "1":
			j = i
			while j < len(modules) and modules[j] == "1":
				j += 1
			rects.append(f'<rect x="{i + quiet}" y="0" width="{j - i}" height="1"/>')
			i = j
		else:
			i += 1
	return (
		f'<svg class="bc" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {total} 1" '
		f'preserveAspectRatio="none" style="height:{fmt_number(height_mm)}mm">'
		f'{"".join(rects)}</svg><div class="bc-text">{html.escape(value)}</div>'
	)


def effective_barcode_type(preferred: str, value: str) -> str:
	"""EAN-13 only when the template wants it and the value is a valid EAN-13."""
	return "EAN13" if preferred == "EAN13" and is_ean13(value) else "Code128"


def code128_safe(value: str, fallback: str) -> str:
	text = "".join(c for c in str(value or "") if 32 <= ord(c) <= 126)
	if text:
		return text
	return "".join(c for c in str(fallback or "") if 32 <= ord(c) <= 126) or "0"


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


@dataclass
class Template:
	name: str
	language: str
	width_mm: float
	height_mm: float
	dpi: int = 203
	gap_mm: float = 2
	barcode_type: str = "Code128"
	body: str = ""
	a4_columns: int = 3
	a4_rows: int = 8
	margins_mm: float = 2

	@classmethod
	def from_dict(cls, raw: Any) -> Template:
		get = raw.get if hasattr(raw, "get") else lambda k, d=None: getattr(raw, k, d)
		return cls(
			name=str(get("name") or get("template_name") or ""),
			language=str(get("language") or "ZPL"),
			width_mm=float(get("width_mm") or 0),
			height_mm=float(get("height_mm") or 0),
			dpi=int(get("dpi") or 203),
			gap_mm=float(get("gap_mm") if get("gap_mm") not in (None, "") else 2),
			barcode_type=str(get("barcode_type") or "Code128"),
			body=str(get("body") or ""),
			a4_columns=int(get("a4_columns") or 0),
			a4_rows=int(get("a4_rows") or 0),
			margins_mm=float(get("margins_mm") or 0),
		)


class _Safe(str):
	"""Helper output: inserted as is (not escaped)."""


def _environment(language: str):
	from jinja2.sandbox import SandboxedEnvironment

	def finalize(value: Any) -> str:
		if value is None:
			return ""
		if isinstance(value, _Safe):
			return value
		from jinja2 import Undefined

		if isinstance(value, Undefined):
			return ""
		return escape_for(language, value)

	return SandboxedEnvironment(
		trim_blocks=True, lstrip_blocks=True, keep_trailing_newline=False, finalize=finalize, autoescape=False
	)


def label_context(template: Template, row: dict, base: dict) -> dict:
	"""Every value a template can use, as strings (ints for qty and sizes)."""
	dpi = int(template.dpi or 203)
	return {
		"item_code": row.get("item_code") or "",
		"item_name": row.get("item_name") or "",
		"item_name_ar": row.get("item_name_ar") or "",
		"barcode": row.get("barcode") or "",
		"barcode_type": row.get("barcode_type") or "Code128",
		"uom": row.get("uom") or "",
		"price": row.get("price_text") or "",
		"price_label": row.get("price_label") or "",
		"currency": base.get("currency") or "",
		"company": base.get("company") or "",
		"date": base.get("date") or "",
		"weight": row.get("weight_label") or "",
		"qty": int(row.get("qty") or 1),
		"width_mm": fmt_number(template.width_mm),
		"height_mm": fmt_number(template.height_mm),
		"width_dots": mm_to_dots(template.width_mm, dpi),
		"height_dots": mm_to_dots(template.height_mm, dpi),
		"gap_mm": fmt_number(template.gap_mm),
		"gap_dots": mm_to_dots(template.gap_mm, dpi),
		"dpi": dpi,
	}


def _num(value: Any, default: int = 0) -> int:
	"""Round half up, like Math.round in the browser copy."""
	try:
		return math.floor(float(value) + 0.5)
	except (TypeError, ValueError):
		return default


def render_label(
	template: Template, row: dict, base: dict, bitmap: BitmapRenderer | None = None
) -> tuple[str, list[bytes]]:
	"""One label: text with \\x00n\\x00 placeholders, plus the binary parts they stand for."""
	validate_body(template.body)
	language = template.language
	ctx = label_context(template, row, base)
	parts: list[bytes] = []

	def placeholder(data: bytes) -> _Safe:
		parts.append(data)
		return _Safe(f"\x00{len(parts) - 1}\x00")

	def barcode(*args: Any) -> _Safe:
		value = ctx["barcode"] or ctx["item_code"]
		if not value:
			return _Safe("")
		kind = ctx["barcode_type"]
		if kind != "EAN13":
			value = code128_safe(value, ctx["item_code"])
		if language == "PDF":
			height = float(args[0]) if args else 10
			return _Safe(barcode_svg(value, kind, height))
		x, y = _num(args[0] if len(args) > 0 else 0), _num(args[1] if len(args) > 1 else 0)
		height = _num(args[2] if len(args) > 2 else 50, 50)
		module = max(_num(args[3] if len(args) > 3 else 2, 2), 1)
		return _Safe(barcode_command(language, value, kind, x, y, height, module))

	def arabic(text: Any = "", *args: Any) -> _Safe:
		text = "" if text is None else str(text)
		if not text.strip():
			return _Safe("")
		if language == "PDF":
			return _Safe(f'<span class="ar" dir="rtl" lang="ar">{html.escape(text)}</span>')
		x, y = _num(args[0] if len(args) > 0 else 0), _num(args[1] if len(args) > 1 else 0)
		height = max(_num(args[2] if len(args) > 2 else 24, 24), 8)
		max_width = max(_num(args[3] if len(args) > 3 else ctx["width_dots"], ctx["width_dots"]), 8)
		render = bitmap or pillow_bitmap
		return placeholder(bitmap_command(language, x, y, render(text, height, max_width)))

	def fit(value: Any = "", length: Any = 0) -> _Safe:
		return _Safe(escape_for(language, fit_text(value, length)))

	env = _environment(language)
	out = env.from_string(template.body).render(**ctx, draw_barcode=barcode, draw_arabic=arabic, fit=fit)
	if NEWLINE[language] != "\n":
		out = out.replace("\n", NEWLINE[language])
	return out, parts


def assemble(text: str, parts: list[bytes]) -> bytes:
	"""Text (UTF-8) with each placeholder replaced by its binary part."""
	out = bytearray()
	for k, piece in enumerate(text.split("\x00")):
		if k % 2 == 0:
			out += piece.encode("utf-8")
		else:
			out += parts[int(piece)]
	return bytes(out)


def check_rows(rows: list[dict]) -> int:
	if len(rows) > MAX_ROWS:
		raise LabelTemplateError(f"At most {MAX_ROWS} rows per print.")
	total = 0
	for row in rows:
		qty = int(row.get("qty") or 1)
		if qty < 1 or qty > MAX_QTY:
			raise LabelTemplateError(f"Label quantity must be between 1 and {MAX_QTY}.")
		total += qty
	if total > MAX_LABELS:
		raise LabelTemplateError(f"At most {MAX_LABELS} labels per print.")
	return total


def render_raw(template: Template, rows: list[dict], base: dict, bitmap: BitmapRenderer | None = None) -> bytes:
	"""Raw printer job (ZPL / EPL / TSPL) for all rows."""
	if template.language not in RAW_LANGUAGES:
		raise LabelTemplateError("Use render_pdf_html for PDF templates.")
	check_rows(rows)
	nl = NEWLINE[template.language]
	own_qty = uses_qty(template.body)
	job = bytearray()
	for row in rows:
		text, parts = render_label(template, row, base, bitmap)
		label = assemble(text, parts) + nl.encode()
		job += label * (1 if own_qty else int(row.get("qty") or 1))
	return bytes(job)


def grid_layout(template: Template) -> dict:
	"""Cell size and position of an A4 sheet: the grid is centred on the page."""
	cols, rows = int(template.a4_columns or 0), int(template.a4_rows or 0)
	width, height = float(template.width_mm or 0), float(template.height_mm or 0)
	if cols < 1 or rows < 1:
		raise LabelTemplateError("A4 Columns and A4 Rows must be at least 1.")
	if width <= 0 or height <= 0:
		raise LabelTemplateError("Label width and height must be more than 0.")
	if cols * width > A4_WIDTH_MM + 0.001 or rows * height > A4_HEIGHT_MM + 0.001:
		raise LabelTemplateError("The grid does not fit on an A4 sheet (210 x 297 mm).")
	return {
		"cols": cols,
		"rows": rows,
		"width": width,
		"height": height,
		"left": (A4_WIDTH_MM - cols * width) / 2,
		"top": (A4_HEIGHT_MM - rows * height) / 2,
		"padding": max(float(template.margins_mm or 0), 0),
	}


def render_pdf_html(template: Template, rows: list[dict], base: dict) -> str:
	"""HTML of the A4 sheets (wkhtmltopdf on the server, print window in the POS)."""
	if template.language != "PDF":
		raise LabelTemplateError("Only PDF templates print on A4 sheets.")
	check_rows(rows)
	g = grid_layout(template)
	cells: list[str] = []
	for row in rows:
		text, _parts = render_label(template, row, base)
		cells.extend([text] * int(row.get("qty") or 1))
	per_page = g["cols"] * g["rows"]
	pages = []
	for start in range(0, max(len(cells), 1), per_page):
		chunk = []
		for k, body in enumerate(cells[start : start + per_page]):
			left = g["left"] + (k % g["cols"]) * g["width"]
			top = g["top"] + (k // g["cols"]) * g["height"]
			chunk.append(
				f'<div class="cell" style="left:{fmt_number(left)}mm;top:{fmt_number(top)}mm">{body}</div>'
			)
		pages.append(f'<div class="page">{"".join(chunk)}</div>')
	css = (
		"@page{size:A4;margin:0}"
		"html,body{margin:0;padding:0}"
		f"body{{font-family:{FONT_STACK};color:#000}}"
		f".page{{position:relative;width:{A4_WIDTH_MM}mm;height:296mm;overflow:hidden;page-break-after:always}}"
		".page:last-child{page-break-after:auto}"
		f".cell{{position:absolute;box-sizing:border-box;width:{fmt_number(g['width'])}mm;"
		f"height:{fmt_number(g['height'])}mm;padding:{fmt_number(g['padding'])}mm;overflow:hidden;font-size:9pt;line-height:1.2}}"
		".name{font-weight:bold;white-space:nowrap;overflow:hidden}"
		".ar{display:block;direction:rtl;text-align:right;white-space:nowrap;overflow:hidden}"
		".price{font-size:13pt;font-weight:bold}"
		".small{font-size:7pt}"
		".bc{display:block;width:100%}"
		".bc-text{font-size:7pt;text-align:center;letter-spacing:1px}"
	)
	return (
		'<!DOCTYPE html><html dir="ltr"><head><meta charset="utf-8">'
		f"<title>{html.escape(template.name)}</title><style>{css}</style></head>"
		f"<body>{''.join(pages)}</body></html>"
	)


# ---------------------------------------------------------------------------
# Arabic bitmap with Pillow (shaping needs libraqm)
# ---------------------------------------------------------------------------

_FONT_CACHE: dict[str, str | None] = {}
FONT_CANDIDATES = (
	"/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf",
	"/usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf",
	"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
	"/usr/share/fonts/TTF/DejaVuSans.ttf",
	"/Library/Fonts/Arial Unicode.ttf",
)


def arabic_font() -> str | None:
	if "path" in _FONT_CACHE:
		return _FONT_CACHE["path"]
	import os
	import shutil
	import subprocess

	path = None
	if shutil.which("fc-match"):
		try:
			found = subprocess.run(
				["fc-match", "-f", "%{file}", ":lang=ar"], capture_output=True, text=True, timeout=5
			).stdout.strip()
			if found and os.path.exists(found):
				path = found
		except Exception:
			path = None
	if not path:
		path = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)
	_FONT_CACHE["path"] = path
	return path


class ArabicBitmapUnavailable(RuntimeError):
	pass


def pillow_bitmap(text: str, height: int, max_width: int) -> Bitmap:
	"""Shape and draw right-to-left text with Pillow + libraqm, then 1-bit."""
	from PIL import Image, ImageDraw, ImageFont, features

	if not features.check("raqm"):
		raise ArabicBitmapUnavailable("raqm")
	font_path = arabic_font()
	if not font_path:
		raise ArabicBitmapUnavailable("font")
	size = max(int(height), 8)
	opts = {"direction": "rtl", "language": "ar"}
	font = ImageFont.truetype(font_path, size, layout_engine=ImageFont.Layout.RAQM)
	box = font.getbbox(text, **opts)
	width = box[2] - box[0]
	if width > max_width:
		size = max(8, math.floor(size * max_width / width))
		font = ImageFont.truetype(font_path, size, layout_engine=ImageFont.Layout.RAQM)
		box = font.getbbox(text, **opts)
		width = box[2] - box[0]
	width = max(1, min(int(width), int(max_width)))
	img = Image.new("L", (width, int(height)), 255)
	draw = ImageDraw.Draw(img)
	text_height = box[3] - box[1]
	draw.text((-box[0], (int(height) - text_height) // 2 - box[1]), text, font=font, fill=0, **opts)
	pixels = img.load()
	return pack_bits(width, int(height), lambda x, y: pixels[x, y] < 128)


def to_base64(data: bytes) -> str:
	return base64.b64encode(data).decode("ascii")
