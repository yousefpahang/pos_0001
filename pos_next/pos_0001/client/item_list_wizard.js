// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// "Create with Wizard" on the Item list (SPEC F13): opens the POS Item Wizard at /pos/items/new.
// Extends ERPNext's own list settings instead of replacing them.

;(() => {
	const settings = (frappe.listview_settings.Item = frappe.listview_settings.Item || {})
	const previous = settings.onload
	settings.onload = function (listview) {
		if (previous) previous.call(this, listview)
		if (!frappe.user.has_role("POS Item Wizard") && frappe.session.user !== "Administrator") return
		listview.page.add_inner_button(__("Create with Wizard"), () => {
			window.open("/pos/items/new", "_blank")
		})
	}
})()
