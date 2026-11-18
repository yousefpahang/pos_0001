# ERPNext POS Build Spec (POS Next + POS Awesome)

Nov 19, 2026 · @Yousef

## 1. Overview

We are building a branded ERPNext point of sale for UAE retail clients by forking POS Next (BrainWise) and porting the printing features of POS Awesome (defendicon fork). Target is Frappe/ERPNext v15 (branch `version-15`), kept compatible with v16.

This document is written to be handed to Claude Code. Each section is a requirement set; section 11 holds copy-paste prompts, one per build phase; section 12 is the `CLAUDE.md` to commit in the repo.

**Names:** app name `pos_0001` (used throughout). Still to replace: your GitHub org `YOUR_ORG`, test site `pos.test`.

### Must-have features

| # | Feature | Comes from | Status in base |
| --- | --- | --- | --- |
| F1 | Offline selling with automatic sync | POS Next | Exists, harden |
| F2 | Fast search and scan on large catalogs | POS Next + POS Awesome techniques | Exists, optimise |
| F3 | Barcode scanning | POS Next | Exists |
| F4 | Barcode label printing (thermal + A4) | POS Awesome | Port |
| F5 | Scale barcodes with embedded weight or price | POS Next (POS Barcode Rules) | Exists, extend + test |
| F6 | Sales person selection (optional or mandatory) | POS Next + LumenPOS idea | Exists, extend |
| F7 | Hold / park and resume sales | POS Next | Exists |
| F8 | Split, partial and credit payments | POS Next | Exists |
| F9 | One-click receipt printing, cash drawer | POS Next (QZ silent) + POS Awesome (raw ESC/POS) | Port + extend |
| F10 | Modern, touch-friendly UI in English and Arabic | POS Next | Exists, add RTL checks |
| F11 | UAE VAT tax invoice receipt | New | Build |
| F12 | Cashier-visible sync log | LumenPOS idea | Build |

### Non-goals (first release)

- Restaurant features (tables, kitchen display, modifiers).
- Native Android/iOS apps; the POS stays a PWA.
- New payment-gateway integrations; card terminals are recorded as a payment mode with a reference number.
- Rewriting loyalty, promotions or pricing rules; use ERPNext's own.

## 2. Architecture decision

Fork POS Next as the base, keep every new feature in its own folders, and treat POS Awesome as a read-only reference to port from. This keeps merges from upstream POS Next cheap.

### Sources

| Repo | Role | License | Branch |
| --- | --- | --- | --- |
| [BrainWise-DEV/POSNext](https://github.com/BrainWise-DEV/POSNext) | Base: fork it | AGPL-3.0 | `version-15` (stable), `develop` |
| [defendicon/POS-Awesome-V15](https://github.com/defendicon/POS-Awesome-V15) | Reference: port label printing, raw ESC/POS, virtual scroll, shortcuts | GPL-3.0 | default |
| LumenPOS | Ideas only (sync log, mandatory sales person, commission report) — do not copy code, license not stated | Unknown | — |

### Rules for the codebase

1. **Isolation:** all new backend code lives in a `pos_0001/` sub-package inside the POS Next Python package; all new frontend code in a `plus/` folder beside the existing frontend `src/`. Edits to POS Next's own files are kept small (hooks, imports, a slot or event) and each is listed in `docs/UPSTREAM_PATCHES.md`.
2. **Remotes:** `origin` = `YOUR_ORG/pos_0001` (your fork); `upstream` = BrainWise-DEV/POSNext. Merge `upstream/version-15` monthly.
3. **POS Awesome is never a dependency.** Clone it to `~/reference/posawesome` and port logic by rewriting it: its UI is Vuetify, ours is Tailwind, so components are rebuilt, not copied. Python and pure-JS logic (ZPL/EPL builders, QZ calls, barcode templates) may be adapted with attribution.
4. **Shared parsing logic:** anything the POS must do offline (barcode parsing, totals, tax, rounding) is written once in TypeScript under `plus/core/` with no UI imports, and mirrored in Python only where the server must validate.
5. **Hardware:** printers are reached through [QZ Tray](https://qz.io) on each till; network ESC/POS printers may also be reached through QZ. No other local agent.

### Target repo layout (additions only)

```text
pos_next/                      # existing POS Next python package (name to confirm in Phase 0)
  pos_0001/
    api/            sync.py  labels.py  printing.py  barcode.py  reports.py
    doctype/        pos_0001_settings/  pos_printer_profile/  pos_label_template/
                    pos_sync_log/  pos_device/
    print_format/   uae_tax_invoice_80mm/
    report/         sales_person_commission/
    tests/
POS/src/                       # existing frontend (path to confirm)
  plus/
    core/           scaleBarcode.ts  ean.ts  escpos.ts  zpl.ts  tspl.ts  rounding.ts
    printing/       qz.ts  receipt.ts  labels.ts  raster.ts
    sync/           syncLog.ts
    components/     LabelPrintDialog.vue  SyncLogPanel.vue  SalesPersonPicker.vue
    i18n/           ar.json  en.json
docs/
  ARCHITECTURE_NOTES.md  UPSTREAM_PATCHES.md  HARDWARE.md  NOTICE.md
```

### License obligations

GPL-3.0 code may be combined with AGPL-3.0 code; the combined app is distributed under AGPL-3.0. Keep original copyright headers, credit both projects in `NOTICE.md`, and add an "About / Source code" link in the POS so users of a hosted install can get the source. You can still charge for setup, hosting, hardware and support. This is not legal advice; confirm with a lawyer before selling.

## 3. Phase 0: environment and repo exploration

Before writing any feature, Claude Code sets up a v15 bench and writes `docs/ARCHITECTURE_NOTES.md` describing how POS Next and POS Awesome actually work. Every path in this spec marked "to confirm" is checked here.

### Environment (v15)

- Ubuntu 22.04 or 24.04, Python 3.11, Node 18 LTS, Yarn, MariaDB 10.6+, Redis, wkhtmltopdf (patched Qt).
- For v16 testing later, use a second bench and check the current v16 Python/Node requirements in the Frappe docs first.

```bash
bench init frappe-bench --frappe-branch version-15 --python python3.11
cd frappe-bench
bench get-app erpnext --branch version-15
bench new-site pos.test --admin-password admin --mariadb-root-password <root>
bench --site pos.test install-app erpnext
bench get-app https://github.com/YOUR_ORG/pos_0001 --branch version-15
bench --site pos.test install-app pos_next   # app name to confirm
bench --site pos.test set-config developer_mode 1
bench --site pos.test migrate && bench build && bench start
cd apps/pos_next && git remote add upstream https://github.com/BrainWise-DEV/POSNext
git clone https://github.com/defendicon/POS-Awesome-V15 ~/reference/posawesome
```

Seed demo data: one company (AED, UAE), VAT 5% tax template, two POS Profiles, 20,000 items (script it), 50 weighed items with UOM Kg, 5 sales persons, payment modes Cash / Card / Bank Transfer / Credit.

### Exploration checklist (output goes in ARCHITECTURE\_NOTES.md)

POS Next:

- [ ] Python package name, frontend root, build command, how assets reach `/assets`.
- [ ] Which invoice doctype is created (Sales Invoice with `is_pos` or POS Invoice) and where it is submitted.
- [ ] Offline layer: IndexedDB database name, stores and their keys; what is cached on login; the sync queue and retry logic; how duplicates are prevented today.
- [ ] Barcode flow: scanner input → resolution → cart. Fields of the `POS Barcode Rules` doctype and where rules are evaluated (client, server or both).
- [ ] Sales person: where it is chosen, how it maps to the Sales Team child table, offline cache.
- [ ] Hold/draft: storage, resume across devices, auto-cleanup.
- [ ] Payment dialog: component, events, how modes come from the POS Profile.
- [ ] Printing: the QZ Tray silent print implementation (v1.16.0), print format used, 80mm format.
- [ ] i18n: how strings are translated; whether RTL layout is supported.
- [ ] Extension points: events, slots, hooks we can use without editing core files.

POS Awesome (reference):

- [ ] Barcode Printing module: files, UI flow, ZPL/EPL builders, A4 grid PDF.
- [ ] Scale barcode generation: settings and item/UOM templates.
- [ ] QZ Tray raw printing: connection, certificate/signing, ESC/POS builder.
- [ ] Virtual scrolling and local fast catalog.
- [ ] Keyboard shortcut map.
- [ ] Handling of failed offline submissions (saved as Draft).

## 4. Feature specs: selling

### F1 Offline selling and sync

A till that loses internet keeps selling with no visible change except a status badge, and every sale reaches ERPNext exactly once.

- **Cached on login and refreshed in the background (every 5 min, configurable):** items, item barcodes (incl. UOM barcodes), prices for the profile's price list, item tax templates, stock qty per warehouse (informational), customers, sales persons, payment modes, POS Profile, barcode rules, printer profiles, label templates, print-format data.
- **Idempotency:** each invoice gets a client UUID (`offline_uuid`) when the cart is created. The server rejects a second invoice with the same UUID and returns the existing one. Custom field is unique and indexed.
- **Queue:** invoices go to an IndexedDB queue; sync runs on reconnect, every 30 s while items are pending, and on demand. Batches of 20, exponential backoff on errors.
- **Failure handling (from POS Awesome):** an invoice the server rejects (validation error, closed period, missing item) is saved server-side as a Draft with the error, and shown in the sync log. It is never silently dropped.
- **Stock while offline:** setting `offline_negative_stock` = Allow / Warn / Block (default Warn).
- **Price changes while offline:** the sale keeps the price the cashier saw; server records `offline_price_mismatch = 1` for review.
- **Shift rules:** a shift opened online can continue offline; closing a shift requires the queue to be empty.
- **F12 Sync log panel (LumenPOS idea):** a badge (Online / Offline / n pending / n failed) opens a panel listing each queued invoice: time, total, status (Pending, Synced, Failed → Draft), error text in plain words, Retry button.

### F5 Scale barcodes (weight or price embedded)

Scanning a label printed by a shop scale adds the right item at the right weight and price, online or offline, with no keystroke.

Extend POS Next's `POS Barcode Rules` (add fields only if missing):

| Field | Example | Notes |
| --- | --- | --- |
| Prefix | `20`, `21`, `22` | 1–3 digits; most scales use 20–29 |
| Total length | 13 | EAN-13 (also allow 12/UPC-A, 18 custom) |
| Item code start / length | 3 / 5 | Matches Item Barcode or a `scale_plu` field on Item |
| Value type | Weight or Price | Price → qty = price ÷ rate |
| Value start / length | 8 / 5 |  |
| Decimals | 3 (weight) / 2 (price) | Weight in kg |
| Check digit | Validate / Ignore | Some scales print bad check digits |
| Priority | 10 | Lower runs first |

Rules:

1. Parse on the client in `plus/core/scaleBarcode.ts` so it works offline; the server re-validates on sync.
2. Normal item barcodes are checked first; scale rules run only if no exact barcode match.
3. Item UOM must be Kg (or the rule's UOM); if not, show an error naming the item.
4. Price-embedded: qty rounded to 3 decimals; line amount equals the printed price exactly (adjust rate rounding, not amount).
5. Same scale label scanned twice adds two lines, never merges.

Test vectors (valid EAN-13 check digits; rule A = prefix 20 weight, rule B = prefix 22 price; item PLU 12345):

| Barcode | Rule | Expected |
| --- | --- | --- |
| `2012345012509` | A | qty 1.250 kg |
| `2012345007505` | A | qty 0.750 kg |
| `2212345025008` | B | amount AED 25.00 |
| `2212345009992` | B | amount AED 9.99 |
| `2012345012508` | A | wrong check digit → error (if Validate) |

### F6 Sales person

- Picker in the cart header and in the payment dialog; search by name or scan the employee's barcode (new field `sales_person_barcode`).
- Settings per POS Profile: Off / Optional / Mandatory; default sales person per user.
- Several sales persons with allocation %, written to the invoice's Sales Team table so ERPNext commission reports work.
- Works offline from cache.
- New report **Sales Person Commission**: sales person, invoices, net sales, returns, commission rate, commission (AED), date range and POS Profile filters.

### F7 Hold / park

- Hold button (F8) parks the cart with an optional note; held list shows time, customer, total, cashier.
- Online: stored as draft invoices, resumable on any till (POS Next behaviour). Offline: stored locally and uploaded on reconnect.
- Held carts older than N days (setting, default 3) are deleted automatically.

### F8 Payments

- Modes from the POS Profile; split across any number of modes; quick-amount buttons in AED (exact, 50, 100, 200, 500).
- Change calculated for cash only; card and bank modes require a reference number field (configurable).
- Partial and credit sales for named customers, limited by credit limit, with POS Next's approval flow.
- Cash rounding configurable (none / 0.05 / 0.25 / 0.50 / 1.00 AED) using ERPNext rounding adjustment, never by editing line amounts.
- Returns: scan the receipt barcode or search by invoice number; refund to original mode by default.

## 5. Feature specs: printing

### F9 Receipt printing

The receipt prints automatically within 1 second of payment, with no browser dialog, and the cash drawer opens for cash sales.

Three print modes, chosen per Printer Profile:

| Mode | How | Use when |
| --- | --- | --- |
| `raster` (default) | Render the receipt HTML to a canvas, convert to 1-bit ESC/POS raster (`GS v 0`), send raw via QZ | Arabic text, logos, any printer. Avoids Arabic code-page problems on cheap printers |
| `escpos_text` | Build ESC/POS text commands (port POS Awesome's builder) | English-only receipts, fastest |
| `qz_html` | Existing POS Next QZ silent print of an ERPNext print format | Fallback; matches desk reprints |
| `browser` | `window.print()` | Last resort when QZ is not running |

Requirements:

- Paper 80 mm (576 dots) and 58 mm (384 dots); auto-cut (`GS V`) on/off; copies 1–3.
- Cash drawer kick (`ESC p 0 25 250`) after cash payments and from a No Sale button (permission-controlled, logged).
- Receipt includes a Code128 or QR barcode of the invoice number for fast returns.
- Printing works offline (receipt data built from the local invoice, not fetched).
- Reprint last receipt (F9) and reprint from the invoice list.
- **QZ signing:** server endpoint signs QZ requests with a private key stored in site config, so tills show no trust prompts. Document the certificate setup in `docs/HARDWARE.md`.
- If QZ is not connected, show a red printer badge and fall back to `browser` mode.

### F4 Barcode label printing (ported from POS Awesome)

Staff print shelf and product labels from the POS or the desk, on a thermal label printer or an A4 sheet.

- **Entry points:** (1) Label button in the POS item menu; (2) a desk page `pos-labels`; (3) "Print Labels" button on Purchase Receipt and Stock Entry, pre-filled with received quantities.
- **Rows:** item, UOM (uses that UOM's barcode and price), label qty, optional price override.
- **Label Template:** size in mm, DPI (203/300), language `ZPL` / `EPL` / `TSPL` / `PDF`, and a Jinja body with fields: item name (EN and AR), item code, barcode (Code128 or EAN-13), price incl. VAT, UOM, company name, date.
- **Output:** raw commands sent through QZ to the label printer; or a PDF A4 grid (columns × rows, margins) for office printers.
- **Arabic on thermal labels:** render Arabic text as a bitmap (`GRF` for ZPL, `BITMAP` for TSPL), since label printer fonts rarely support Arabic shaping.
- **Scale-barcode generation:** for goods weighed and packed in store, generate an EAN-13 from a barcode rule + PLU + weight or price, with a valid check digit, and print it on a label.
- Ship three default templates: 38×25 mm shelf label, 50×30 mm product label, A4 3×8 grid.

## 6. Performance and UI

Measured on a mid-range till (Intel i3/8 GB or a 2022 Android tablet, Chrome) with 20,000 items cached.

| Action | Target |
| --- | --- |
| Item search, first results | < 100 ms |
| Barcode scan to line in cart (incl. scale barcode) | < 150 ms |
| Pay → receipt starts printing | < 1 s |
| Submit invoice offline | instant (< 50 ms) |
| Reopen POS from installed PWA, cached | < 3 s |
| Initial full cache of 20,000 items | < 60 s, with progress bar |
| Sync 500 queued invoices | < 5 min, no duplicates |

Techniques: virtual scrolling for item grid and lists (port from POS Awesome); a pre-built search index in IndexedDB (lowercased name, code, barcodes, Arabic name); a "favourites" quick grid of top 30 sellers per profile; scanner input captured globally with a 30 ms inter-key threshold so scans work without focusing a field; heavy work (indexing, raster conversion) in a Web Worker.

UI rules:

- Keep POS Next's Vue 3 + Tailwind style; new components match its tokens.
- Touch targets at least 44 px; usable at 1024×768 and on 10-inch tablets.
- Light and dark themes; full RTL layout when Arabic is selected (mirrored layout, numbers stay LTR).
- Keyboard shortcuts (shown in a `?` overlay): F2 search, F3 customer, F4 pay, F6 sales person, F8 hold, F9 reprint, Ctrl+S save draft, Esc close dialog, Del remove line, +/- change qty.
- Every error message says what happened and what to do, in the cashier's language.

## 7. UAE localization

The default receipt is a bilingual (Arabic/English) VAT tax invoice in AED. Confirm the exact fields against current Federal Tax Authority guidance before go-live; the list below is the working requirement.

Receipt print format `UAE Tax Invoice 80mm` must show:

- Title "Tax Invoice / فاتورة ضريبية" (simplified tax invoice allowed for retail sales to non-registered customers; make the title configurable).
- Seller name, address and TRN (from Company).
- Invoice number, date and time, POS Profile/till, cashier, sales person.
- Customer name and TRN when the customer has one.
- Lines: item name (EN + AR), qty/weight, unit price, amount; VAT rate per line where rates differ.
- Totals: net amount, VAT 5% amount in AED, grand total, rounding adjustment, payments by mode, change.
- Return receipts titled as credit notes, referencing the original invoice.
- Footer text and logo per POS Profile.

Other:

- Item fields: `item_name_ar` (custom field) used on receipts, labels and search.
- Currency AED with 2 decimals; amounts printed with "AED" or "د.إ" per language setting.
- The UAE has announced a phased e-invoicing mandate. Do not build it now, but keep invoice creation in one service function so an e-invoicing hook can be added later. Check the current timeline before selling to large clients.

## 8. Data model

Five new doctypes and a set of custom fields (shipped as fixtures). Reuse POS Next's own doctypes wherever they already cover a need.

### New doctypes

| Doctype | Type | Key fields |
| --- | --- | --- |
| POS 0001 Settings | Single | `offline_negative_stock` (Allow/Warn/Block), `cache_refresh_minutes` (5), `held_cart_retention_days` (3), `sync_batch_size` (20), `qz_certificate` (Text), `qz_private_key` (Password), `default_cash_rounding`, `about_source_url` |
| POS Printer Profile | Master | `printer_name`, `purpose` (Receipt/Label), `connection` (QZ local name / Network IP:port), `print_mode` (raster/escpos\_text/qz\_html/browser), `paper_width_mm` (80/58), `dpi`, `auto_cut`, `copies`, `drawer_kick`, `label_language` (ZPL/EPL/TSPL) |
| POS Label Template | Master | `width_mm`, `height_mm`, `dpi`, `language` (ZPL/EPL/TSPL/PDF), `barcode_type` (Code128/EAN13), `body` (Code, Jinja), `a4_columns`, `a4_rows`, `margins_mm`, `is_default` |
| POS Device | Master | `device_id` (UUID from the browser), `device_name`, `pos_profile`, `receipt_printer`, `label_printer`, `last_seen`, `app_version` |
| POS Sync Log | Log | `device`, `offline_uuid`, `invoice` (Dynamic Link), `status` (Synced/Failed/Duplicate), `error`, `payload_hash`, `received_at`, `client_created_at` |

### Custom fields

| Doctype | Field | Type | Purpose |
| --- | --- | --- | --- |
| Sales Invoice / POS Invoice (whichever POS Next uses) | `offline_uuid` | Data, unique, read-only, indexed | Idempotent sync |
| same | `pos_device` | Link POS Device | Audit |
| same | `offline_price_mismatch` | Check | Review prices changed while offline |
| POS Profile | `plus_sales_person_mode` | Select Off/Optional/Mandatory | F6 |
| POS Profile | `plus_receipt_template`, `plus_default_label_template` | Links | Printing defaults |
| POS Profile | `plus_receipt_footer`, `plus_receipt_logo` | Text / Attach Image | Receipt branding |
| Item | `item_name_ar` | Data | Arabic name |
| Item | `scale_plu` | Data, indexed | Scale barcode item code |
| Sales Person | `sales_person_barcode` | Data, unique | Scan to select |
| User | `plus_default_sales_person` | Link Sales Person | Default per cashier |

Extend `POS Barcode Rules` with any of these missing fields: `value_type`, `decimals`, `check_digit_mode`, `priority`, `uom` (see F5).

Roles: reuse POS Next's cashier and manager roles; add permission `No Sale drawer open` and `Print labels` checks via role on POS Profile.

## 9. API endpoints

All new endpoints are `@frappe.whitelist()` methods under `<package>.pos_0001.api`, require a logged-in user with a POS role, and check POS Profile access server-side. Use existing POS Next endpoints where they already exist; do not duplicate them.

| Method | Input | Output | Notes |
| --- | --- | --- | --- |
| `sync.submit_offline_invoices` | `invoices[]` (each with `offline_uuid`, `device_id`, full invoice payload) | per invoice: `{offline_uuid, status, invoice_name, error}` | Idempotent; one DB transaction per invoice; failures saved as Draft + Sync Log |
| `sync.get_sync_log` | `device_id`, `limit` | log rows | For the sync panel |
| `sync.register_device` | `device_id`, `device_name`, `pos_profile` | POS Device + printer profiles | Called on first login per browser |
| `barcode.get_rules` | `pos_profile` | rules\[\] | Cached offline |
| `barcode.generate_scale_barcode` | `rule`, `item_code`, `value` | EAN-13 string | Valid check digit |
| `printing.sign_qz` | `request` (string) | signature | Signs with key from POS 0001 Settings; rate-limited |
| `printing.get_receipt_data` | `invoice` | receipt JSON | For reprints; live sales build receipts locally |
| `labels.items_from_document` | `doctype`, `name` | rows\[\] | Purchase Receipt, Stock Entry |
| `labels.render` | `template`, `rows[]` | raw string (ZPL/EPL/TSPL) or PDF file URL | Server-side render for desk page; POS renders locally |
| `reports.sales_person_commission` | `from_date`, `to_date`, `pos_profile?` | rows | Also exposed as a Script Report |

Conventions: type hints on every function, `frappe.throw` with translatable messages (`_()`), no raw SQL where the Query Builder works, and every endpoint has at least one test.

## 10. Testing and acceptance

A phase is done only when its automated tests pass and its acceptance checks below pass on the `pos.test` site.

### Automated tests

- **Python** (`bench --site pos.test run-tests --app <package>`): barcode parsing vectors (F5 table), idempotent sync (same UUID twice → one invoice), failed sync → Draft + log, sales-person allocation totals 100%, label rendering snapshots, commission report totals.
- **Frontend unit** (Vitest): `scaleBarcode.ts`, `ean.ts` check digits, totals/VAT/rounding, ESC/POS and ZPL/TSPL builders (byte snapshots), raster conversion of a fixed receipt.
- **End-to-end** (Playwright, Chromium): login → cache → go offline (`context.setOffline(true)`) → sell 10 invoices incl. scale items, split payment, held cart → go online → assert 10 invoices in ERPNext, no duplicates, GL and stock entries correct.
- **Load:** script 500 queued invoices from 5 devices syncing together; assert no duplicates and < 5 min.

### Acceptance checks (manual, with real hardware)

- [ ] Pull the network cable mid-sale; finish the sale, print, reconnect; invoice appears once.
- [ ] Scan 5 real labels from the client's scale (weight and price types); qty and amount match the printed label.
- [ ] Mandatory sales person blocks payment until chosen; commission report matches.
- [ ] Hold a cart on till 1, resume on till 2.
- [ ] Split AED 100 into cash 40 + card 60 with card reference; change correct on cash overpay.
- [ ] Receipt prints Arabic correctly in raster mode on the client's printer; drawer opens on cash only.
- [ ] Print 20 labels from a Purchase Receipt on the label printer and an A4 grid; barcodes scan back.
- [ ] 20,000-item search and scan meet section 6 targets.
- [ ] RTL layout has no overlapping or clipped text.

### Hardware test matrix (fill in with clients' models)

| Type | Models to test | Connection |
| --- | --- | --- |
| Receipt printer | Epson TM-T20/T82, Xprinter XP-80 series | USB, LAN |
| Label printer | Zebra (ZPL), TSC (TSPL), Xprinter label | USB, LAN |
| Scale (label printing) | CAS, DIGI, Mettler Toledo, Bizerba | prints EAN-13 labels |
| Scanner | Any HID keyboard-wedge 1D/2D | USB, Bluetooth |
| Cash drawer | RJ11 via receipt printer | printer kick |

## 11. Build phases and Claude Code prompts

Run one phase per Claude Code session, in order. Save this document as `docs/SPEC.md` in the repo first (export it as Markdown), so every prompt can point to it. Review and commit after each phase.

| Phase | Delivers | Depends on | Rough size |
| --- | --- | --- | --- |
| 0 | Bench, seed data, ARCHITECTURE\_NOTES.md | — | 1 day |
| 1 | Doctypes, custom fields, idempotent sync, sync log | 0 | 3–4 days |
| 2 | Scale barcodes | 1 | 2 days |
| 3 | Sales person + commission report | 1 | 2 days |
| 4 | Receipt printing (raster, ESC/POS, QZ signing, drawer) | 1 | 4–5 days |
| 5 | Label printing | 4 | 4 days |
| 6 | Performance + shortcuts | 2 | 3 days |
| 7 | UAE receipt, Arabic/RTL | 4 | 2–3 days |
| 8 | Hardening, e2e, docs, release | all | 3 days |

**Phase 0**

```text
Read docs/SPEC.md sections 1-3. Set up the v15 bench and test site exactly as in section 3, clone POS Awesome to ~/reference/posawesome, and write a seed script (bench execute) for the demo data in section 3. Then work through every item of the exploration checklist and write docs/ARCHITECTURE_NOTES.md with file paths, function names and short code excerpts. List every "to confirm" path from the spec with its real value. Do not change any POS Next code in this phase.
```

**Phase 1**

```text
Read docs/SPEC.md sections 2, 4 (F1, F12), 8, 9 and docs/ARCHITECTURE_NOTES.md. Create the pos_0001 sub-package, the five doctypes and the custom fields as fixtures. Make offline invoice sync idempotent using offline_uuid, save rejected invoices as Draft with a POS Sync Log row, register devices, and build the sync badge + SyncLogPanel. Keep edits to POS Next files minimal and record each in docs/UPSTREAM_PATCHES.md. Write the Python and Playwright tests from section 10 for F1. Run them and fix until green.
```

**Phase 2**

```text
Read docs/SPEC.md F5 and the barcode notes in ARCHITECTURE_NOTES.md. Extend POS Barcode Rules with the missing fields, implement plus/core/scaleBarcode.ts and ean.ts (client, offline) and the server re-validation, wire them into POS Next's barcode flow after exact-match lookup, and add barcode.get_rules to the offline cache. All five test vectors in F5 must pass in Vitest and in Python tests.
```

**Phase 3**

```text
Read docs/SPEC.md F6. Add the Off/Optional/Mandatory mode on POS Profile, default sales person per user, barcode scan to select, multi-person allocation to the Sales Team table, offline cache, and the Sales Person Commission script report. Add tests for allocation and the report.
```

**Phase 4**

```text
Read docs/SPEC.md F9 and ARCHITECTURE_NOTES.md (POS Next QZ silent print and POS Awesome raw printing). Implement Printer Profiles, QZ request signing (printing.sign_qz), and the four print modes. raster mode renders the receipt HTML to a canvas in a Web Worker, converts to 1-bit and sends GS v 0 via QZ. Add auto-cut, copies, drawer kick, No Sale with permission, reprint, receipt barcode, and fallback to browser printing when QZ is down. Byte-snapshot tests for the ESC/POS builder. Write docs/HARDWARE.md with QZ install and certificate steps.
```

**Phase 5**

```text
Read docs/SPEC.md F4 and the POS Awesome Barcode Printing notes. Port its label logic into plus/core/zpl.ts, tspl.ts and an EPL builder, rebuild the UI in Tailwind (LabelPrintDialog + desk page pos-labels + Print Labels buttons on Purchase Receipt and Stock Entry), add POS Label Template with the three default templates, Arabic text as bitmap, A4 PDF grid, and scale-barcode label generation. Credit POS Awesome in NOTICE.md and file headers. Snapshot tests for each label language.
```

**Phase 6**

```text
Read docs/SPEC.md section 6. Seed 20,000 items, measure every target in the table with a small benchmark script, then add virtual scrolling, the IndexedDB search index, favourites grid, global scanner capture and Web Worker indexing until all targets pass. Add the keyboard shortcut map and the ? overlay. Report before/after numbers in docs/PERFORMANCE.md.
```

**Phase 7**

```text
Read docs/SPEC.md section 7. Create the UAE Tax Invoice 80mm receipt (bilingual, VAT 5%, TRN, credit-note variant), item_name_ar on receipts, labels and search, AED formatting, and check full RTL layout on every POS screen. Add ar.json translations for all new strings. Keep invoice creation in one service function with a no-op hook for future e-invoicing.
```

**Phase 8**

```text
Run every test in docs/SPEC.md section 10 and fix failures. Test a clean install on a fresh v15 site and on a v16 bench. Write README (install, configure, hardware), CHANGELOG, NOTICE.md, and an upgrade note for merging upstream POS Next. Tag v1.0.0.
```

## 12. CLAUDE.md for the repo

Commit this as `CLAUDE.md` at the repo root before Phase 0. Claude Code reads it at the start of every session.

```markdown
# pos_0001 — project rules for Claude

Branded ERPNext POS: a fork of BrainWise POS Next (AGPL-3.0) with features ported
from POS Awesome (defendicon fork, GPL-3.0). Full spec: docs/SPEC.md.
How the base code works: docs/ARCHITECTURE_NOTES.md (read before changing anything).

## Targets
- Frappe/ERPNext v15 (branch version-15) first; must also install on v16.
- Dev site: pos.test. Bench at ~/frappe-bench. POS Awesome reference: ~/reference/posawesome (read-only).

## Where code goes
- New backend code: <package>/pos_0001/ only. New frontend code: <frontend>/src/plus/ only.
- Pure logic that must work offline (barcodes, totals, VAT, rounding, ESC/POS, ZPL/TSPL) goes in
  src/plus/core/ with no Vue imports and has Vitest tests.
- Editing POS Next's own files: keep the change minimal and add an entry to docs/UPSTREAM_PATCHES.md
  (file, reason, what changed).
- Never add POS Awesome as a dependency. Port logic, rebuild UI in Tailwind, credit it in NOTICE.md.
- Never copy LumenPOS code.

## Conventions
- Python: type hints, frappe.qb over raw SQL, frappe.throw(_("...")) for user errors,
  every whitelisted method checks POS Profile access.
- Vue 3 Composition API + TypeScript + Tailwind, matching POS Next components and tokens.
- Every user-facing string translatable; add Arabic to src/plus/i18n/ar.json. Check RTL.
- Schema changes only via doctype JSON or fixtures, plus a patch in patches.txt when data must move.
- Money: never edit line amounts to fix rounding; use ERPNext rounding adjustment.
- Offline invoices: always carry offline_uuid; the server must stay idempotent.

## Commands
- Build: bench build --app <package>
- Migrate: bench --site pos.test migrate
- Python tests: bench --site pos.test run-tests --app <package>
- Frontend tests: cd <frontend> && yarn test
- E2E: cd <frontend> && yarn e2e

## Definition of done for any task
1. Tests for the change exist and pass (Python + Vitest; Playwright for flows).
2. Works offline if it is used at the till.
3. No console errors; RTL checked for UI changes.
4. docs updated (SPEC section, UPSTREAM_PATCHES, HARDWARE as relevant).
5. Small, focused commits with clear messages.

## Ask before
- Changing an existing POS Next doctype's fields or behaviour.
- Adding a new npm or pip dependency.
- Anything touching GL entries, stock ledger or tax calculation logic.
```
