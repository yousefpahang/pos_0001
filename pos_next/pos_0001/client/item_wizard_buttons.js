// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// "Edit packaging" on the Item form (SPEC F13 "Also"): opens the POS Item Wizard on steps 3-6
// for this item. Nothing is deleted there; removed units only lose their price and barcode.

frappe.ui.form.on("Item", {
	refresh(frm) {
		if (frm.is_new() || frm.doc.has_variants) return
		if (!frappe.user.has_role("POS Item Wizard") && frappe.session.user !== "Administrator") return
		frm.add_custom_button(__("Edit packaging"), () => {
			window.open(`/pos/items/edit?item=${encodeURIComponent(frm.doc.name)}`, "_blank")
		})
	},
})
