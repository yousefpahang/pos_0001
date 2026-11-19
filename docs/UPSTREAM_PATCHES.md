# Upstream patches

Every edit to a file that comes from POS Next (BrainWise) is listed here so upstream merges stay easy.
New files under `pos_next/pos_0001/` and `POS/src/plus/` are ours and are not listed.

| # | Phase | File | Reason | What changed |
| --- | --- | --- | --- | --- |
| 1 | 1 | `.gitignore` | DECISIONS.md item 11: commit lockfiles | Removed `yarn.lock` from the ignore list; ignore Playwright output folders |
| 2 | 1 | `POS/package.json` | Phase 1: Playwright for e2e tests | Added dev dependency `@playwright/test` (Vitest was already present) |
| 3 | 1 | `pos_next/api/invoices.py` | DECISIONS.md item 10: `submit_invoice` did not check POS Profile access | Added `_check_submit_pos_profile_access()` and one call at the top of `submit_invoice`. Users must be listed in the profile's POS Profile User table; Administrator, System Manager and Nexus POS Manager pass. Own commit, can be sent upstream as is |
| 4 | 1 | `pos_next/modules.txt` | Register our module so its doctypes and `custom/*.json` sync on migrate | Added the line `POS 0001` (folder `pos_next/pos_0001/`) |
| 5 | 1 | `pos_next/hooks.py` | Desk Retry button on Offline Invoice Sync | `doctype_js` now also maps `Offline Invoice Sync` to `pos_0001/client/offline_invoice_sync.js` |
| 6 | 1 | `pos_next/api/pos_profile.py` | Upstream bug: `get_receivable_accounts` used `cint` without importing it (HTTP 500 and console errors on every till load with credit sales on) | Added `from frappe.utils import cint`. Own commit, can be sent upstream |
| 7 | 1 | `POS/src/utils/offline/sync.js` | F1: rejected invoices must be stored on the server, never dropped | `syncInvoiceToServer()` calls `pos_0001.api.sync.submit_offline_invoice` (via `plus/sync/syncClient.js`) instead of `submit_invoice`, and uses `plus/core/syncOutcome.js` to mark the queue row: Synced, or Failed-and-stored (`synced: true`, `server_status: "Failed"`). Anything else stays queued. The sync loop counts stored failures as failed |
| 8 | 1 | `POS/src/components/pos/POSHeader.vue` | F12 sync badge | One import and `<SyncBadge />` after the Wi-Fi button |
| 9 | 1 | `POS/package.json` | Playwright e2e | Added the `e2e` script (`playwright test`) |
| 10 | 1 | `README.md` | DECISIONS.md item 11 | Prerequisites list Node.js 22 |
| 11 | 2 | `pos_next/hooks.py` | F5: the server re-validates lines scanned from scale labels | `doc_events["Sales Invoice"]["validate"]` also runs `pos_next.pos_0001.api.barcode.validate_sales_invoice` |
| 12 | 2 | `POS/src/stores/itemSearch.js` | DECISIONS.md items 3-4: scans must resolve in the browser first and work offline | One import; `searchByBarcode()` calls `plus/scan/scanner.js` `resolveScannedBarcode()` (cached barcodes, then scale rules, then POS Next's `search_by_barcode` only when online). Errors meant for the cashier are not logged as errors |
| 13 | 2 | `POS/src/composables/useSearchInput.js` | F5: a label that was read but cannot be sold (wrong check digit, item not sold in Kg) must say why | `processBarcodeScan()` shows `error.userMessage` as a warning when present, instead of "Item Not Found" |
| 14 | 2 | `POS/src/pages/POSSale.vue` | F5: scale labels add with no keystroke at the label's price; scale lines are removed one by one | `handleItemSelected()` treats items with `pos0001_scale_barcode` as auto-add and uses `pos0001_scale_rate` when set; the cart's `remove-item` handler passes a third argument (line id) to `cartStore.removeItem` |
| 15 | 2 | `POS/src/composables/useInvoice.js` | F5 rule 5: the same scale label scanned twice gives two lines; the server needs the label | `addItem()` never merges a scale line (or into one) and keeps `pos0001_scale_barcode` / `pos0001_line_id` on the line; `removeItem(itemCode, uom, lineId)` removes only that line when a line id is given; `formatItemsForSubmission()` sends `pos0001_scale_barcode` |
| 16 | 2 | `POS/src/components/sale/InvoiceCart.vue` | F5 rule 5 (two identical lines) and e2e tests | Row `:key` includes `pos0001_line_id`; the remove button emits the line id; `data-testid="invoice-cart-lines"` / `"cart-line"` on the list and rows |
