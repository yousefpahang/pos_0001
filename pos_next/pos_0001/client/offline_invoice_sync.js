// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
// Desk "Retry" button for Offline Invoice Sync records stored with status Failed.

frappe.ui.form.on("Offline Invoice Sync", {
	refresh(frm) {
		if (frm.doc.status !== "Failed" || !frm.doc.payload) return;

		frm.dashboard.set_headline_alert(
			`<div>${__("This invoice failed to sync: {0}", [frappe.utils.escape_html(frm.doc.error || "")])}</div>`,
			"red",
		);

		frm.add_custom_button(__("Retry"), () => {
			frappe.call({
				method: "pos_next.pos_0001.api.sync.retry_failed",
				args: { offline_ids: [frm.doc.offline_id] },
				freeze: true,
				freeze_message: __("Retrying sync..."),
				callback(r) {
					const result = (r.message || [])[0] || {};
					if (result.status === "Synced") {
						frappe.show_alert({
							message: __("Synced as {0}", [result.invoice_name]),
							indicator: "green",
						});
					} else {
						frappe.msgprint({
							title: __("Retry failed"),
							message: frappe.utils.escape_html(result.error || __("Unknown error")),
							indicator: "red",
						});
					}
					frm.reload_doc();
				},
			});
		}).addClass("btn-primary");
	},
});
