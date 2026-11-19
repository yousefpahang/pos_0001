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
