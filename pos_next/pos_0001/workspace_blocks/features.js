// POS 0001 workspace feature tiles. Texts are translated with __() (Arabic in ar.csv).
const ICONS = {
	cloud: '<path d="M17.5 19a4.5 4.5 0 1 0-1.4-8.8A6 6 0 0 0 4.5 12.5 3.5 3.5 0 0 0 6 19z"/><path d="m9 15 2 2 4-4"/>',
	search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
	scale: '<path d="M12 3v18M5 21h14M5 8l-3 7a4 4 0 0 0 6 0zM19 8l-3 7a4 4 0 0 0 6 0zM5 8h14"/>',
	users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>',
	pause: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M10 8v8M14 8v8"/>',
	receipt: '<path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/>',
	tag: '<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
	device: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
};

const FEATURES = [
	{ icon: "cloud", color: "#0d9488", name: "Offline selling and sync log", href: "/app/offline-invoice-sync",
		desc: "Sell with no network. Invoices queue on the till and sync when it is back; failed ones can be retried." },
	{ icon: "search", color: "#2563eb", name: "Fast search and scanning", href: "/pos",
		desc: "Instant search over large catalogues, Arabic names too. Scans work with no field selected. Press ? for shortcuts." },
	{ icon: "scale", color: "#ea580c", name: "Scale barcodes", href: "/app/pos-scale-barcode-rule", tag: "New",
		desc: "Weight or price inside the barcode from a weighing scale. Set the layout here and the Scale PLU on each Item." },
	{ icon: "users", color: "#db2777", name: "Sales persons", href: "/app/query-report/Sales Person Commission",
		desc: "Off, Optional or Mandatory per POS Profile, badge scanning and split commission." },
	{ icon: "pause", color: "#ca8a04", name: "Held carts", href: "/app/sales-invoice?pos0001_held=1",
		desc: "Hold a cart with F8 and resume it on any till. Old held carts are removed automatically." },
	{ icon: "receipt", color: "#7c3aed", name: "Receipts and cash drawer", href: "/app/pos-printer-profile",
		desc: "One-click receipts through QZ Tray or the browser, Arabic supported, F9 reprint and logged No Sale openings." },
	{ icon: "tag", color: "#16a34a", name: "Barcode labels", href: "/app/pos-labels", tag: "New",
		desc: "Shelf and product labels for ZPL, EPL and TSPL printers or A4 sheets, from the till or a Purchase Receipt." },
	{ icon: "device", color: "#0284c7", name: "Tills and devices", href: "/app/pos-device",
		desc: "Each browser till registers itself. Give it its own receipt and label printers." },
];

root_element.querySelectorAll("[data-t]").forEach((el) => {
	el.textContent = __(el.dataset.t);
});

const grid = root_element.querySelector(".grid");
const esc = (s) => frappe.utils.escape_html(s);
const arrow = document.documentElement.dir === "rtl" ? "←" : "→";
grid.innerHTML = FEATURES.map(
	(f) => `
	<a class="tile" href="${encodeURI(f.href)}" style="--c:${f.color}">
		${f.tag ? `<span class="tag">${esc(__(f.tag))}</span>` : ""}
		<span class="ficon"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[f.icon]}</svg></span>
		<span class="name">${esc(__(f.name))}</span>
		<span class="desc">${esc(__(f.desc))}</span>
		<span class="go">${esc(__("Open"))} ${arrow}</span>
	</a>`
).join("");
