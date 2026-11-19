// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Desk page "POS Labels" (SPEC F4). Shows the POS label screen (/pos/labels, Vue +
// Tailwind, the same screen the till uses), so labels are built and sent to the label
// printer through QZ Tray in the browser, and A4 sheets print from the same code.
// Opened from the Print Labels button of Purchase Receipt and Stock Entry with
// route options { doctype, name }.

frappe.pages["pos-labels"].on_page_load = (wrapper) => {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("POS Labels"),
		single_column: true,
	})
	const $body = $(page.body)
	$body.css({ padding: 0 })
	wrapper.pos0001_frame = $(
		'<iframe class="pos0001-labels-frame" title="POS Labels" style="width:100%;border:0;min-height:calc(100vh - 140px);background:#fff"></iframe>',
	).appendTo($body)
	page.set_secondary_action(__("Open in POS"), () => {
		window.open(wrapper.pos0001_src || "/pos/labels", "_blank")
	})
}

frappe.pages["pos-labels"].on_page_show = (wrapper) => {
	const options = frappe.route_options || {}
	frappe.route_options = null
	const params = new URLSearchParams({ embedded: "1" })
	if (options.doctype && options.name) {
		params.set("doctype", options.doctype)
		params.set("name", options.name)
	}
	const src = `/pos/labels?${params.toString()}`
	if (wrapper.pos0001_src !== src) {
		wrapper.pos0001_src = src
		wrapper.pos0001_frame.attr("src", src)
	}
}
