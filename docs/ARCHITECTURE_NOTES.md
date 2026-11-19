# Architecture notes (Phase 0)

How POS Next (the base) and POS Awesome (the reference) actually work, checked against
`docs/SPEC.md`. Written 2026-11-19 from:

- POS Next `version-15` at `4314b03` (app 1.17.0, frontend package 1.16.0), fork `yousefpahang/pos_0001`.
- POS Awesome V15 at `caba6f84` in `~/reference/posawesome` (read-only).
- Bench `~/projects/pos/frappe-bench`: Frappe 15.127.1, ERPNext 15.125.0, Python 3.11.13, Node 20.20.2.

Paths below are relative to the app repo root (`apps/pos_next`) unless they start with `~`.

## 0. Spec "to confirm" values

| Spec placeholder | Real value |
| --- | --- |
| Python package (`pos_next/` "name to confirm") | `pos_next` (app name and package). Module "POS Next" lives at `pos_next/pos_next/`. New code goes in `pos_next/pos_0001/`. |
| App name for `install-app` | `pos_next` |
| Frontend root (`POS/src/` "path to confirm") | `POS/src/`. New frontend code goes in `POS/src/plus/`. |
| `<package>` in CLAUDE.md | `pos_next` |
| `<frontend>` in CLAUDE.md | `POS` |
| Build | `bench build --app pos_next` runs `yarn build` in the app root, which runs `cd POS && vite build --base=/assets/pos_next/pos/`. |
| How assets reach `/assets` | Vite writes to `pos_next/public/pos/`; bench symlinks `sites/assets/pos_next -> apps/pos_next/pos_next/public`. The HTML entry is written to `pos_next/www/pos.html` (served at `/pos`, deep links via `website_route_rules` `/pos/<path>`). |
| Invoice doctype | **Sales Invoice** with `is_pos = 1` (not POS Invoice). |
| Frontend tests | `cd POS && yarn test` (Vitest 2, jsdom) is wired but **there are no test files** yet. No Playwright config; root `package.json` lists `playwright` as a dependency only. |
| `GitHub org YOUR_ORG` | `yousefpahang` (fork `yousefpahang/pos_0001`). |

## 1. Environment notes

- Bench: `~/projects/pos/frappe-bench`, site `pos.test` (default site, `developer_mode: 1`),
  admin password `admin`. URL `http://localhost:8001/pos` (no `/etc/hosts` entry; `serve_default_site` is on).
- Ports moved off the defaults because `~/frappe-bench` already uses 8000/9000/11000/13000:
  web 8001, socketio 9001, redis queue 11001, redis cache 13001, file watcher 6788.
- **Node:** `bench get-app` failed at `yarn install --check-files`: `POS/` has no committed lockfile, so
  yarn resolves the newest packages and `nopt@10.0.1` (transitive) needs Node `^22.22.2 || ^24.15.0`.
  Worked around with `yarn install --ignore-engines` in the app root and in `POS/`, and by appending
  `pos_next` to `sites/apps.txt` manually. No repo file changed. `POS/yarn.lock` and the root `yarn.lock`
  are git-ignored. Decide in Phase 1: commit a lockfile, or move the bench to Node 22.
- Remotes: `origin` = `yousefpahang/pos_0001`, `upstream` = `BrainWise-DEV/POSNext`
  (bench had named the fork `upstream`; renamed).
- Upstream already has a `Feat/RTL` branch; check it before Phase 7.

### Seed data

`pos_next/pos_0001/demo/seed.py`, run with
`bench --site pos.test execute pos_next.pos_0001.demo.seed.run` (optional `--kwargs "{'item_count': 500}"`).
Idempotent. Creates: setup wizard (company **Demo Trading LLC**, abbr `DTL`, UAE, AED, Asia/Dubai),
`UAE VAT 5% - DTL` (created by ERPNext's UAE setup), modes Cash / Card / Bank Transfer, POS Profiles
**Main Till** and **Express Till** with POS Next `POS Settings` rows, 20,000 items `ITM-00001..20000`
with EAN-13 barcodes (prefix 629), 50 weighed items `PLU-12345..12394` (UOM Kg), 5 sales persons,
3 customers (2 with credit limits), opening stock by Stock Reconciliation, user `cashier@pos.test` / `cashier`.

Deviation: the spec lists **Credit** as a payment mode. POS Next does credit sales through
`POS Settings.allow_credit_sale` / `allow_partial_payment` (submit with no payment row, `is_credit_sale=1`),
not a Mode of Payment, so the seed enables those flags instead.

## 2. POS Next

### 2.1 Layout

```text
pos_next/hooks.py                 doc_events, override_doctype_class, fixtures, scheduler
pos_next/api/                     whitelisted endpoints (invoices.py 3000+ lines, items.py, pos_profile.py, qz.py, ...)
pos_next/overrides/sales_invoice.py   CustomSalesInvoice (override_doctype_class)
pos_next/services/barcode.py      optional bridge to the external barcode_resolver app
pos_next/pos_next/doctype/        POS Next doctypes (list in 2.11)
pos_next/pos_next/print_format/   pos_next_receipt (Jinja, Sales Invoice), pos_next_eod_report
pos_next/translations/ar.csv      Frappe CSV translations (1,567 lines)
POS/src/                          Vue 3 SPA (JavaScript, not TypeScript; no tsconfig; only utils/translation.ts is TS)
  pages/POSSale.vue               main till screen (3,000 lines)
  stores/                         Pinia: posCart, itemSearch, posSync, posSettings, posDrafts, posEvents, ...
  utils/offline/                  Dexie DB, sync queue, cache
  workers/offline.worker.js       Web Worker that owns IndexedDB reads/writes for search and cache
```

Frontend stack: Vue 3.5, Pinia 3, frappe-ui 0.1.x, Tailwind 3, Dexie 4, `qz-tray` 2.2, vite-plugin-pwa, Biome.

### 2.2 Invoice creation and submit

Two steps, both in `pos_next/api/invoices.py`:

1. `update_invoice(data)` (line ~699) builds/saves the Sales Invoice as a draft (`is_pos = 1`).
2. `submit_invoice(invoice=None, data=None)` (line ~1240) dedups by `offline_id`, calls `update_invoice`
   if needed, sets sales team / payments / credit-sale flags, then `invoice_doc.save()` and `invoice_doc.submit()`
   (line ~1465). Returns `{name, status, grand_total, ...}` plus `offline_id`.

Hooks on Sales Invoice (`hooks.py`): `validate` → `api.sales_invoice_hooks.validate`, `api.wallet.validate_wallet_payment`;
`on_submit` → realtime stock event, loyalty-to-wallet, one-time offer usage; class override
`overrides.sales_invoice.CustomSalesInvoice`.

This is the single service path the spec asks for (section 7, e-invoicing hook): live and offline sales both call
`submit_invoice`.

**Access checks:** `submit_invoice` and `update_invoice` do **not** check that the user may use the POS Profile
in the payload. Only a few read endpoints check (`get_invoices` line ~1648, `credit_sales`). New pos_0001 endpoints
must add their own check (CLAUDE.md rule).

### 2.3 Offline layer

- **IndexedDB** `pos_next_offline` (Dexie), schema in `POS/src/utils/offline/db.js`. Version auto-increments when
  the schema hash changes (stored in `localStorage` `pos_next_schema_hash` / `pos_next_schema_version`).

  | Store | Key / indexes |
  | --- | --- |
  | `settings` | `&key` |
  | `invoice_queue` | `++id, &offline_id, timestamp, synced` |
  | `items` | `&item_code, item_name, item_group, variant_of, has_variants, brand, *barcodes` |
  | `customers` | `&name, customer_name, mobile_no, email_id` |
  | `item_prices` | `&[price_list+item_code], price_list, item_code` |
  | `stock` | `&[item_code+warehouse], item_code, warehouse` |
  | `payment_methods` | `&mode_of_payment, pos_profile` |
  | `sales_persons` | `&name, pos_profile` |
  | `payment_queue` | `++id, timestamp, synced` |
  | `drafts` | `++id, draft_id, timestamp` (unused; drafts use a separate DB, see 2.6) |
  | `translations` | `&locale, timestamp` |
  | `offers` | `&name, pos_profile, apply_on, valid_upto` |
  | `invoice_history` | `&name, pos_profile, posting_date, customer` |
  | `unpaid_invoices` | `&name, pos_profile, outstanding_amount, customer` |
  | `one_time_redemptions` | `&customer` |

- **Cached on login** (`POS/src/stores/posSync.js`, `utils/offline/cache.js`, `stores/bootstrap.js`):
  `api.bootstrap.get_initial_data`, items (`api.items.get_items`, with barcodes and prices), customers
  (`api.customers.get_customers`), payment methods (`api.pos_profile.get_payment_methods`), sales persons
  (`api.pos_profile.get_sales_persons`), offers, translations, stock (worker `START_STOCK_SYNC`).
  Not cached today: barcode rules, printer profiles, label templates, print-format data.
- **Queue:** `saveOfflineInvoice()` in `utils/offline/sync.js` writes to `invoice_queue` with a client UUID
  `offline_id` (`utils/offline/uuid.js`, created at **save** time, not cart creation).
- **Sync:** `syncOfflineInvoices()` (same file) runs under a mutex, one invoice at a time (no batching):
  pre-check `api.invoices.check_offline_invoice_synced`, then `api.invoices.submit_invoice`. Triggers:
  offline→online transition (`posSync.js` line ~80, `composables/useOffline.js` line ~118) and manual.
  Connectivity polling in `utils/offline/offlineState.js`: 30 s online, 10 s offline with backoff, 5 s unstable,
  60 s hidden tab. No exponential backoff per invoice; `MAX_RETRY_COUNT = 3` then `sync_failed = true` with
  `error` stored locally. Synced rows are deleted after 7 days.
- **Duplicate prevention (server):** doctype **Offline Invoice Sync** (`offline_id` Data unique, `sales_invoice`,
  `status` Pending/Synced/Failed, `pos_profile`, `customer`, `synced_at`). `_ensure_offline_uniqueness()`
  (invoices.py ~1046) takes `SELECT ... FOR UPDATE` on the row, returns the existing invoice if Synced,
  throws `SYNC_IN_PROGRESS` if Pending and younger than `PENDING_TIMEOUT_MINUTES`, reuses Failed rows.
  On submit failure `_cleanup_failed_sync()` marks the row Failed. Client treats `DUPLICATE_OFFLINE_INVOICE`
  / "already been synced" errors as synced.
- **Failure handling:** a rejected invoice is **not** saved on the server as a Draft; the request raises and is
  rolled back. It stays in the browser queue with `sync_failed` and is shown in
  `components/sale/OfflineInvoicesDialog.vue`. Spec F1 (Draft + POS Sync Log) is new work.

Implication for Phase 1: idempotency already exists under the name `offline_id` and doctype Offline Invoice Sync.
The spec's `offline_uuid` custom field and POS Sync Log overlap with it. Decide whether to reuse `offline_id`
(recommended: map spec `offline_uuid` = POS Next `offline_id`, add a unique `offline_id` custom field on
Sales Invoice if needed) instead of adding a second UUID.

### 2.4 Barcode flow

1. Input: the search box in `components/sale/ItemsSelector.vue` with `composables/useSearchInput.js`.
   A scanner toggle (`scannerEnabled`) and auto-add toggle exist; there is **no global key capture** and the
   old scanner-speed detection was removed ("Dead scanner-speed-detection code removed", line ~89).
2. `processBarcodeScan()` queues scans through a `QueuedMutex` and calls `itemStore.searchByBarcode()`
   (`stores/itemSearch.js` line ~1759).
3. `searchByBarcode()` calls **`pos_next.api.items.search_by_barcode` on the server only**. There is no offline
   fallback in the scan path, even though the cached `items` store has a `*barcodes` index and the worker's
   text search (`workers/offline.worker.js` line ~536) tries that index first. **Scanning does not work offline
   today**; typing a barcode in search does.
4. Server `search_by_barcode` (`api/items.py` ~304): `services.barcode.resolve_barcode()` first, then
   `Item Barcode.barcode` → item (with barcode UOM), else `Item.name`; then `get_item_detail` and UOM prices.
5. **Scale barcodes:** `services/barcode.py` only works when the external **`barcode_resolver`** app is installed
   (not installed here, not in POS Next). The rules live in that app's `Barcode Rule` doctype. POS Next's
   **`POS Barcode Rules`** is a child table of `POS Settings` with only `barcode_rule` (Data, reqd) and `disable`
   (Check): a list of rule names per profile. Evaluation is **server only**.

Implication for Phase 2: the spec's fields (prefix, lengths, value type, decimals, check digit, priority, UOM)
do not exist anywhere in POS Next. Adding them to `POS Barcode Rules` changes a POS Next doctype (ask first);
the alternative is a new pos_0001 doctype linked from `POS Barcode Rules.barcode_rule`.

**After Phase 2** (DECISIONS items 3-4): `searchByBarcode()` goes through `POS/src/plus/scan/scanner.js`, which
runs `plus/core/scanResolve.js`: (1) `uom_barcodes` map, then the Dexie `items.barcodes` index; (2) our
**POS Scale Barcode Rule** doctype (`plus/core/scaleBarcode.js`), PLU looked up in `plu_map` (Item `scale_plu`)
or the barcode index; (3) POS Next's `search_by_barcode` (and `pos_0001.api.barcode.resolve_scale_barcode`) only
when online. Rules, PLU map and UOM barcodes come from `pos_0001.api.barcode.get_scan_cache`, stored in the Dexie
`settings` store under `pos0001_scan_cache::<profile>`. Scale lines carry `pos0001_scale_barcode` to
Sales Invoice Item, where a `validate` hook re-checks item, weight or amount (`pos_0001/scale_barcode.py`).
`barcode_resolver` and `POS Barcode Rules` are untouched. Note: POS Next caches an item's barcodes as one
comma-joined string without UOMs (`get_items` `GROUP_CONCAT`), which is why the UOM barcode map exists.
ERPNext's `before_tests` hook deletes every Item Price on the site; re-run
`bench --site pos.test execute pos_next.pos_0001.demo.seed.ensure_item_prices` after `run-tests`.

### 2.5 Sales person

- Mode: `POS Settings.enable_sales_persons` = Disabled / Single / Multiple (`stores/posSettings.js` line ~172).
  When enabled it is **always mandatory** (`PaymentDialog.vue` `canComplete` → `isSalesPersonValid`, line ~2853).
  No "Optional" mode.
- Picker: **payment dialog only** (`components/sale/PaymentDialog.vue` lines ~59–300). Not in the cart header.
  `composables/useSalesPersons.js` exists but is not imported anywhere.
- List: `api.pos_profile.get_sales_persons` (enabled, non-group Sales Persons; filters by company only if a
  `company` column exists). Cached in IndexedDB `sales_persons`; dialog falls back to cache offline (line ~2552).
- Allocation: Single → 100 %; Multiple → even split. Sent as `sales_team` and written to the Sales Team child
  table in `submit_invoice` (invoices.py ~1367, `sales_person`, `allocated_percentage`).
- No default per user, no barcode scan.

**After Phase 3** (DECISIONS item 5): the effective mode comes from POS Profile `pos0001_sales_person_mode`
(Optional / Mandatory decide; Off keeps POS Next's rule: `enable_sales_persons` Disabled = off, Single or Multiple =
mandatory); several sales persons only when POS Settings says Multiple. Logic in `plus/core/salesPerson.js`, mirrored in
`pos_0001/sales_person.py`. `pos_0001.api.sales_person.get_sales_person_cache` sends mode, the user's
`pos0001_default_sales_person` and the list with `sales_person_barcode`; the browser keeps it in the Dexie `settings` store
under `pos0001_sales_person_cache::<profile>` (`plus/salesPerson/salesPersonStore.js`, loaded by the sync log store). The
store holds the current cart's selection, resets to the default when the cart empties, and is shared by the cart header
picker (`plus/components/SalesPersonPicker.vue`) and the payment dialog. Server side, Sales Invoice `before_validate`
(and an explicit call in `update_invoice()`, because `calculate_taxes_and_totals()` checks the split early) fills Sales
Team `commission_rate` from Sales Person (POS Next left it empty, so incentives were 0) and moves rounding drift to the
last row; `validate` rejects online POS sales without a sales person when the profile says Mandatory (offline queued
invoices are flagged by `pos_0001.api.sync` and never rejected for it). Script Report **Sales Person Commission**
(`pos_0001/report/sales_person_commission/`) and `pos_0001.api.reports.sales_person_commission`.

### 2.6 Hold / drafts

- Drafts are **local only**: IndexedDB database `pos_next_drafts`, store `invoices`
  (`utils/draftManager.js`), driven by `stores/posDrafts.js` and `components/sale/DraftInvoicesDialog.vue`.
  They are **not** resumable on another till. (Spec F7 says "POS Next behaviour" is server drafts; it is not.)
- Server-side draft endpoints exist but the SPA does not call them: `api.invoices.get_draft_invoices`
  (by opening shift), `delete_invoice`, `cleanup_old_drafts(max_age_hours=48)` (no scheduler entry).

**After Phase 6** (SPEC F7, DECISIONS item 6): a held cart is a **draft Sales Invoice** with `pos0001_held = 1`, built
by POS Next's `update_invoice()` from the till's draft payload. Payments, the opening shift and the `offline_id` are
removed first. With no `posa_pos_opening_shift`, POS Next's shift close does not delete it. The draft is **named by its
hold id** (`HOLD-<uuid>`, Sales Invoice `before_insert` hook), so held carts never use invoice series numbers. The exact
cart (lines, offers, sales persons) is in `pos0001_held_cart` (JSON). Endpoints in `pos_0001/api/held_carts.py`:
`hold_cart` (idempotent per hold id; a Deleted Document of that name means "already resumed"), `list_held_carts`,
`resume_held_cart` (row lock, returns the cart and deletes the draft: a claim), `delete_held_cart`, daily
`cleanup_held_carts` (`held_cart_retention_days`). In the browser, POS Next's `stores/posDrafts.js` keeps its API but
delegates to `plus/heldCarts/heldCartStore.js`. A cart is always saved first in POS Next's `pos_next_drafts` database
and removed only after the server confirms it (or answers "Resumed"). While offline, or when the server refuses it,
the cart stays local, shows "On this till" or "Not uploaded", and is uploaded on reconnect.
`plus/components/HeldCartsDialog.vue` replaces `DraftInvoicesDialog`; `HoldCartDialog.vue` asks for the note.

### 2.7 Payment dialog

- `components/sale/PaymentDialog.vue` (3,500 lines). Emits `update:modelValue`, `payment-completed`,
  `update-additional-discount`, `show-offers`, `show-coupon`. `POSSale.vue` handles `payment-completed`
  (line ~2037) and builds the invoice (`sales_team`, payments).
- Modes from `api.pos_profile.get_payment_methods` (POS Profile `payments` table, cash modes from
  `posa_cash_mode_of_payment`), cached offline. Quick amounts: `composables/useQuickAmounts.js`; numpad:
  `usePaymentNumpad.js`; totals: `usePaymentCalculations.js`.
- Credit / partial: `POS Settings.allow_credit_sale`, `allow_partial_payment`; `api/credit_sales.py`,
  `api/partial_payments.py`, `components/partials/PartialPayments.vue`.

### 2.8 Printing

- **QZ Tray silent print**: `POS/src/utils/qzTray.js` (connect, certificate + SHA512 signature promises,
  `printHTML()` using QZ **pixel/HTML** printing, 80 mm width, saved printer name in localStorage) and
  `composables/useQzTray.js`. Enabled by `POS Settings.silent_print`.
- Server signing: `pos_next/api/qz.py` — `setup_qz_certificate` (System Manager) generates a self-signed cert;
  `get_certificate`, `get_certificate_download`, `sign_message(message)` (RSA PKCS1v15 SHA512).
  Key and cert are files in `sites/pos.test/private/qz/` (`private-key.pem`, `digital-certificate.crt`),
  **not** site config / a Password field. `sign_message` has no role check or rate limit beyond login.
  Spec `printing.sign_qz` duplicates this endpoint; reuse or wrap it.
- `POS/src/utils/printInvoice.js`: `printWithSilentFallback()` → `silentPrintInvoiceFromDoc()` (HTML built
  locally by `buildReceiptHTML()`, works for offline invoices) or `silentPrintDoc()` (server
  `frappe.www.printview.get_html_and_style`); browser fallback opens `/printview` in a popup; last resort a
  hard-coded receipt with `window.print()`.
- Print format: **`POS Next Receipt`** (Jinja, Sales Invoice, `pos_next/pos_next/print_format/pos_next_receipt/`),
  `DEFAULT_PRINT_FORMAT` in printInvoice.js. There is no ESC/POS raw printing, no drawer kick, no auto-cut.

**After Phase 4** (SPEC F9, DECISIONS item 7): a till prints through pos_0001 when it has a **POS Printer Profile**
(POS Device `receipt_printer`, else POS Profile `pos0001_receipt_printer`); otherwise POS Next's path above is
unchanged. `POSSale.vue` `handlePrintInvoice(doc, { reason })` hands receipts to `plus/printing/printingStore.js`,
which keeps `pos_0001.api.printing.get_printing_cache` (printer, company header, footer, logo as data URL, cash modes,
No Sale permission) in the Dexie `settings` store (`pos0001_printing_cache::<profile>`), builds one receipt model
(`plus/core/receipt.js`) from the offline doc, or from `pos_0001.api.printing.get_receipt_data` for server invoices,
and prints in the profile's mode: `raster` (draw ops painted on an OffscreenCanvas in `plus/printing/raster.worker.js`,
1-bit, `GS v 0` bands from `plus/core/raster.js`), `escpos_text` (`plus/core/escpos.js`), `qz_html` (POS Next's
`silentPrint*` with the profile's printer) or `browser` (POS Next's browser print). Raw jobs go through
`plus/printing/qz.js`, which reuses POS Next's QZ connection and signing (`utils/qzTray.js`, `api/qz.py`, key files in
`private/qz/`) and adds `{host, port}` network printers. QZ modes fall back to the browser when QZ is down (red
`PrinterBadge`). Drawer kick after cash sales (`shouldKickDrawer`), copies, cut, F9 reprint (last receipt stored
in `pos0001_last_receipt::<profile>`), receipt barcode (Code128, or QR from `plus/core/qr.js` when too long). No Sale
events (`POS Drawer Event`) queue in `pos0001_drawer_events` and upload through `printing.log_drawer_events`.
Setup steps in `docs/HARDWARE.md`.

**After Phase 5** (SPEC F4 labels): doctype **POS Label Template** (ZPL / EPL / TSPL / PDF, size, DPI, gap, barcode
type, A4 columns / rows / label margin, Jinja `body`); defaults in `pos_0001/default_label_templates.json`, created by
`pos_0001/install.py` on install and migrate. The body is a Jinja subset (values, `draw_barcode`, `draw_arabic`,
`fit`, `if/elif/else`) rendered by Jinja on the server (`pos_0001/labels.py`, sandbox, `trim_blocks` + `lstrip_blocks`)
and by `plus/core/labelTemplate.js` in the browser; `plus/core/labels.js` builds rows (barcode and price incl. VAT per
UOM, scale labels via `generateScaleBarcode`), raw jobs (`zpl.js`, `epl.js`, `tspl.js`) and the A4 HTML. Both copies
are checked against one byte snapshot, `pos_0001/tests/label_snapshots.json`. Arabic is a 1-bit bitmap (browser canvas,
`plus/labels/textBitmap.js`; server Pillow + libraqm). `pos_0001.api.labels` gives the label cache (Dexie `settings`
key `pos0001_label_cache::<profile>`: templates, label printer from POS Device or POS Profile `pos0001_label_printer`,
VAT, item VAT overrides, Arabic names), `resolve_rows`, `search_items`, `items_from_document` (Purchase Receipt, Stock
Entry) and `render` (raw base64 or a private PDF made with WeasyPrint; wkhtmltopdf 0.12.6 without patched Qt scales
mm layouts). UI: `plus/components/LabelPrintPanel.vue` in the header `LabelButton` dialog and in
`plus/pages/LabelsPage.vue` (`/pos/labels`), which the desk page `pos-labels` shows in an iframe. Raw jobs use
`plus/printing/qz.js` `sendRaw`. Access: POS role, profile access, POS Profile `pos0001_label_role` (empty = managers).

### 2.9 i18n and RTL

- Strings: `__()` from `POS/src/utils/translation.ts` (Vue plugin). Messages loaded from
  `api.localization.get_app_translations` (Frappe translation system), cached in IndexedDB `translations`.
  Source of Arabic: `pos_next/translations/ar.csv` (Frappe CSV), **not** a JSON file. Spec/CLAUDE.md say
  `src/plus/i18n/ar.json`; either add a loader for it or put new strings in a pos_0001 CSV. Decide in Phase 1.
- Allowed languages per profile: `POS Settings.allowed_locales` (`POS Allowed Locale`),
  `api.localization.get_allowed_locales`, `change_user_language`; UI `components/common/LanguageSwitcher.vue`.
- RTL: partial. `composables/useLocale.js` (locale config `dir: "rtl"`, lines ~44, ~197) sets the document
  direction; `POS/src/index.css` has `[dir="rtl"]`
  overrides for absolute icons/padding; `Toast.vue` and `ReturnInvoiceDialog.vue` check RTL. Upstream branch
  `Feat/RTL` has more work.

### 2.10 Extension points

- **Event bus:** `stores/posEvents.js` + `composables/usePOSEvents.js` (`on`, `emit`, `settings:*`,
  `sync:stock-updated`, wildcard `*`). Window events: `offlineInvoicesSynced`.
- **Slots:** `components/pos/POSHeader.vue` `menu-items`, `additional-actions`;
  `components/common/UserMenu.vue` same names. Good mount points for the sync badge and label button.
- **Server hooks:** standard Frappe `doc_events` on Sales Invoice from our own `hooks.py` entries;
  `override_doctype_class` is already used by POS Next for Sales Invoice (we must not add a second one —
  subclass `CustomSalesInvoice` if needed).
- **Router:** `POS/src/router.js` has `/`, `/account/login`, catch-all. Plus pages need a route entry (small patch).
- No plugin/registry mechanism; any UI insertion means a small edit to a POS Next component (record in
  UPSTREAM_PATCHES.md).

### 2.11 Doctypes and customizations

POS Next doctypes: Bank Deposits, BrainWise Branding, District, Governorate, Offline Invoice Sync,
One Time Customer Offer Usage, POS Allowed Locale, POS Barcode Rules, POS Brands Detail, POS Closing Shift (+ Detail,
Taxes), POS Coupon (+ Detail), POS Offer (+ Detail), POS Opening Shift (+ Detail), POS Payment Entry Reference,
**POS Settings**, Referral Code, Sales Invoice Reference, Wallet, Wallet Transaction.

- **POS Settings name clash:** ERPNext ships a Single `POS Settings`; POS Next ships a non-Single one keyed by
  `pos_profile`. `install.reclaim_pos_settings_doctype()` runs on `after_migrate` and, if ERPNext's version won,
  **drops `tabPOS Settings`** and reloads POS Next's. If that ever fires on a live site, per-profile settings rows
  are lost. Keep this in mind for v16 testing.
- Custom fields: POS Profile `custom_brands_table`, `posa_block_sale_beyond_available_qty`, `posa_allow_delete`,
  `posa_cash_mode_of_payment`; Sales Invoice `pos_applied_one_time_rules`, `posa_is_printed`,
  `posa_pos_opening_shift` (from `pos_next/pos_next/custom/`).
- Roles: `POSNext Cashier`, `Nexus POS Manager` (fixtures), plus ERPNext `POS User`.
- Scheduler: hourly/daily branding monitor (`tasks/branding_monitor.py`), daily promotion cleanup.

### 2.12 Search and performance today

- Item grid uses **pagination** (`ItemsSelector.vue`, `currentPage` / `itemsPerPage`), not virtual scrolling.
- Offline search runs in the worker over Dexie indexes (barcode index, then name/code), with a small query cache
  and metrics (`GET_METRICS`). No dedicated search index, no Arabic name field.
- `utils/lowEndOptimizations.js`, `utils/performanceConfig.js` tune limits per device.

**After Phase 6** (SPEC section 6, numbers in `docs/PERFORMANCE.md`):
- Search: `plus/search/searchIndex.worker.js` builds rows (`plus/core/searchIndex.js`: name, code, barcodes, Arabic
  name) from the `pos_next_offline.items` store, reading it only, and keeps them in the IndexedDB database
  `pos0001_search`. `searchItems()` gets the first 60 results from it without the debounce; the debounced step gets
  the full list from it too, falling back to POS Next's worker search. `plus/search/startSearchIndex.js`, started by
  the sync log store, loads the index on start and rebuilds it after a catalogue sync. `window.pos0001Search.status()`
  shows its state.
- Grid and list: `plus/perf/useVirtualGrid.js` renders only the rows in view. Pagination (100 per page) is unchanged.
- Reopen: the cached first page shows at once. A server refresh runs afterwards only when the last item sync is
  older than `cache_refresh_minutes` (stored in localStorage by the scan cache).
- Favourites: `pos_0001.api.favourites.get_favourites` (top 30 by quantity, 90 days). Stored in the Dexie
  `settings` store under `pos0001_favourites::<profile>`.
- Scanner: `plus/scan/globalScanner.js` (installed by `useSearchInput`) catches scans when no text field has focus.
- Shortcuts: `plus/core/shortcuts.js` (map), `plus/shortcuts/useShortcuts.js` (used in `POSSale.vue`),
  `plus/components/ShortcutsOverlay.vue` (`?`).

## 3. POS Awesome (reference only)

Frontend is Vue 3 + Vuetify + TypeScript in `~/reference/posawesome/frontend/src/posapp/`; backend
`~/reference/posawesome/posawesome/posawesome/`. GPL-3.0.

### 3.1 Barcode / label printing

- UI: `components/pos/shell/BarcodePrinting.vue` (1,629 lines), `LabelDesigner.vue`, `LabelDesignerPanel.vue`.
- Logic: `composables/pos/items/useBarcodePrintQueue.ts` (rows/qty), `useBarcodePrintOutput.ts` (EAN-13/UPC-A/
  EAN-8 check digits, GS1 barcode sizing per DPI, template variables, `PAGE_FORMAT_PRESETS` incl. **A4 3×7**
  grid and thermal sizes 25×25 … 100×200 mm; output contexts `browser`, `qz_html`, `qz_raw_zpl`, `qz_raw_epl`),
  `useZplGenerator.ts` (`generateZpl` `^XA…^XZ` with `^BEN` EAN-13 / `^BCN` Code128, `generateEpl`, RFID EPC
  header, `mmToDots`, `escapeZpl`), `useLabelDesigner.ts`.
- A4 output is **browser/QZ HTML** printing of a grid, not a server PDF.
- No TSPL builder; no Arabic-as-bitmap (`^GF`) handling found.
- Doctypes: `Barcode Label Template` (`title`, `label_size` select, `layout_json` JSON from the designer,
  `thumbnail`) — a visual layout, **not** a Jinja body as the spec describes. `Barcode Print Log`.
  APIs: `api/label_templates.py`, `api/label_data_sources.py` (items from documents), `api/barcode_print_log.py`.

### 3.2 Scale barcodes

- Single doctype `Scale Barcode Settings`: `prefix_included_or_not`, `no_of_prefix_characters`, `prefix`,
  `item_code_starting_digit/total_digits`, `weight_starting_digit/total_digits/decimals`,
  `price_included_in_barcode_or_not`, `price_starting_digit/total_digit/decimals`. One rule per site.
- Client `utils/scaleBarcode.ts` only normalises settings and checks the prefix; parsing is server side in
  `api/item_processing/barcode.py` (`_parse_scale_barcode_data`, `parse_scale_barcode`, `_calculate_ean13_check_digit`,
  `_encode_value_segments` for generating labels, `_find_item_scale_template` per item/UOM).
  Tests: `api/item_processing/test_barcode.py`.

### 3.3 QZ Tray raw printing

- `services/qzTray.ts`: connect with timeout, cert promise + `sign_message` signing
  (`posawesome.posawesome.api.qz.sign_message`), `printHtmlViaQz` (pixel/HTML), `sendRawToQz(data)`
  (`type: raw, format: command`), printer resolution from POS Profile.
- `services/rawDocumentPrint.ts`: **ESC/POS text builder** `buildEscPosDocument(doc, options)` (ESC/GS constants,
  42-column default, 32–64 range, `center`, `leftRight`, `wrap`, header/items/totals/payments/footer),
  `printRawDocumentViaQz`, `shouldUseRawDocumentPrinting(profile)`. No raster (`GS v 0`) mode, no Arabic shaping.
- Settings are custom fields on POS Profile (`fixtures/custom_field.json`, patches `add_raw_printing_pos_profile_settings.py`).

### 3.4 Virtual scrolling and catalog

- `components/pos/items/ItemsSelectorCards.vue` uses `RecycleScroller` from **vue-virtual-scroller** (grid mode:
  `grid-items`, `item-size`, `item-secondary-size`, `buffer`). Porting it means a **new npm dependency** (ask
  first) or a small in-house virtual grid.
- Barcode index: `composables/pos/items/useBarcodeIndexing.ts` (+ `tests/useBarcodeIndexing.spec.ts`).
  Local DB in `stores/offlineSyncStore.ts`, `posapp.ts`.

### 3.5 Keyboard shortcuts

`components/pos/invoice/invoiceShortcuts.ts` and `utils/invoiceShortcutListener.ts`,
`utils/counterGridPaymentShortcuts.ts`: F2, F4, F6, F7, F8, F9, F12, Alt-combos, arrow/Home/PageUp grid
navigation; tests in `frontend/tests/invoiceShortcuts.spec.ts`.

### 3.6 Failed offline submissions

The current fork no longer saves failed offline invoices "as Draft" as the spec states. It uses an outbox keyed by
`client_request_id` (`api/offline_sync/invoices.py` `submit_invoice_outbox_entry`, `reconcile_invoice_outbox_entry`)
and a submission ledger with states (`api/idempotency.py`, `api/invoice_processing/creation.py`
`_mark_ledger_failed`, `_repair_submitted_invoice_post_submit`). A response with `docstatus = 0` is returned as
`acknowledged: false`. Tests: `api/test_offline_sync_invoices.py`. Port the ledger idea, not the Draft rule, or
keep the spec's Draft rule as our own design.

## 4. Spec vs reality (for review before Phase 1)

1. Idempotency already exists (`offline_id` + Offline Invoice Sync). Spec's `offline_uuid` + POS Sync Log would duplicate it.
2. Failed sync never reaches the server as Draft today.
3. Scale barcodes need the external `barcode_resolver` app; nothing runs offline; `POS Barcode Rules` has no rule fields.
4. Barcode scan path is online only.
5. Sales person: no Optional mode, picker only in payment dialog, no default per user.
6. Held carts are local-only, not cross-till.
7. QZ signing exists with file-based keys; spec wants keys in settings and a new `sign_qz`.
8. Translations are Frappe CSV, not `ar.json`.
9. Frontend is JavaScript; `plus/core` in TypeScript works with Vite/Vitest but there is no `tsc` type check.
10. `submit_invoice` has no POS Profile access check.
11. POS Next `version-15` needs `--ignore-engines` on Node 20, or Node 22.
