// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// "Print Labels" on Purchase Receipt and Stock Entry (SPEC F4): opens the POS Labels page
// pre-filled with the received items and quantities.

function pos0001AddPrintLabels(frm) {
	if (frm.is_new() || frm.doc.docstatus === 2) return
	if (frm.doctype === "Stock Entry" && !(frm.doc.items || []).some((row) => row.t_warehouse)) return
	frm.add_custom_button(__("Print Labels"), () => {
		frappe.route_options = { doctype: frm.doctype, name: frm.doc.name }
		frappe.set_route("pos-labels")
	})
}

frappe.ui.form.on("Purchase Receipt", { refresh: pos0001AddPrintLabels })
frappe.ui.form.on("Stock Entry", { refresh: pos0001AddPrintLabels })
