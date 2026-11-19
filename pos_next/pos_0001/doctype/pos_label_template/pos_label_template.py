# Copyright (c) 2026, pos_0001 contributors
# License: AGPL-3.0. See license.txt

from __future__ import annotations

import frappe
from frappe import _
from frappe.model.document import Document
from frappe.utils import cint, flt

from pos_next.pos_0001 import labels

SAMPLE_ROW = {
	"item_code": "SAMPLE-001",
	"item_name": "Sample item",
	"item_name_ar": "منتج تجريبي",
	"barcode": "6291234567894",
	"barcode_type": "EAN13",
	"uom": "Nos",
	"price_text": "12.50",
	"price_label": "AED 12.50",
	"weight_label": "",
	"qty": 1,
}


class POSLabelTemplate(Document):
	def validate(self) -> None:
		if self.language not in labels.LANGUAGES:
			frappe.throw(_("Language must be one of: {0}.").format(", ".join(labels.LANGUAGES)))
		if self.barcode_type not in labels.BARCODE_TYPES:
			self.barcode_type = "Code128"
		if flt(self.width_mm) <= 0 or flt(self.height_mm) <= 0:
			frappe.throw(_("Width and height must be more than 0 mm."))
		if flt(self.width_mm) > 300 or flt(self.height_mm) > 300:
			frappe.throw(_("Width and height must be at most 300 mm."))
		if flt(self.gap_mm) < 0:
			frappe.throw(_("Gap cannot be negative."))
		if flt(self.margins_mm) < 0:
			frappe.throw(_("Label margin cannot be negative."))
		template = labels.Template.from_dict(self.as_dict())
		try:
			labels.validate_body(self.body or "")
			if self.language == "PDF":
				labels.grid_layout(template)
				labels.render_pdf_html(template, [SAMPLE_ROW], {"currency": "AED", "company": "", "date": ""})
			else:
				labels.render_raw(
					template, [SAMPLE_ROW], {"currency": "AED", "company": "", "date": ""}, labels.fake_bitmap
				)
		except labels.LabelTemplateError as error:
			frappe.throw(_("The template cannot be used: {0}").format(str(error)), title=_("Label Template"))
		except Exception as error:
			frappe.throw(_("The template cannot be rendered: {0}").format(str(error)), title=_("Label Template"))

	def on_update(self) -> None:
		if cint(self.is_default):
			others = frappe.get_all(
				"POS Label Template",
				filters={"language": self.language, "is_default": 1, "name": ["!=", self.name]},
				pluck="name",
			)
			for name in others:
				frappe.db.set_value("POS Label Template", name, "is_default", 0)
