// POS 0001 workspace hero: translated texts and live counts (respects the user's permissions).
root_element.querySelectorAll("[data-t]").forEach((el) => {
	el.textContent = __(el.dataset.t);
});

const today = frappe.datetime.get_today();
const setValue = (key, value) => {
	const el = root_element.querySelector(`[data-kpi="${key}"] .kpi-value`);
	if (el) el.textContent = value;
	return el;
};
const count = (doctype, filters) =>
	frappe.xcall("frappe.client.get_count", { doctype, filters }).catch(() => null);

const todayFilters = { is_pos: 1, docstatus: 1, posting_date: today };
root_element.querySelector('[data-kpi="sales"]').href += `&posting_date=${today}`;
root_element.querySelector('[data-kpi="invoices"]').href += `&posting_date=${today}`;

frappe
	.xcall("frappe.client.get_list", {
		doctype: "Sales Invoice",
		filters: todayFilters,
		fields: ["sum(grand_total) as total", "count(name) as invoices"],
		limit_page_length: 1,
	})
	.then((rows) => {
		const row = (rows && rows[0]) || {};
		const currency = frappe.defaults.get_default("currency");
		setValue("sales", format_currency(row.total || 0, currency, 0));
		setValue("invoices", String(row.invoices || 0));
	})
	.catch(() => {
		setValue("sales", "–");
		setValue("invoices", "–");
	});

count("POS Opening Shift", { status: "Open", docstatus: 1 }).then((n) => setValue("shifts", n ?? "–"));
count("Sales Invoice", { pos0001_held: 1, docstatus: 0 }).then((n) => setValue("held", n ?? "–"));
count("Offline Invoice Sync", { status: "Failed" }).then((n) => {
	setValue("failed", n ?? "–");
	if (n > 0) root_element.querySelector('[data-kpi="failed"]').classList.add("alert");
});
