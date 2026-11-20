# ERPNext POS Build Spec (POS Next + POS Awesome)

Nov 19, 2026 · @Yousef

## 1. Overview

We are building a branded ERPNext point of sale for UAE retail clients by forking POS Next (BrainWise) and porting the printing features of POS Awesome (defendicon fork). Target is Frappe/ERPNext v15 (branch `version-15`), kept compatible with v16.

This document is written to be handed to Claude Code. Each section is a requirement set; section 11 holds copy-paste prompts, one per build phase; section 12 is the `CLAUDE.md` to commit in the repo.

**Names:** app `pos_0001`, fork `yousefpahang/pos_0001` (remote `origin`; BrainWise is `upstream`), Frappe app/package `pos_next` (kept for clean upstream merges), bench `~/projects/pos/frappe-bench`, site `pos.test` at http://localhost:8001/pos. Versions at Phase 0: Frappe 15.127.1, ERPNext 15.125.0, POS Next 1.17.0.

### Must-have features

| # | Feature | Comes from | Status in base |
| --- | --- | --- | --- |
| F1 | Offline selling with automatic sync | POS Next | Exists, harden |
| F2 | Fast search and scan on large catalogs | POS Next + POS Awesome techniques | Exists, optimise |
| F3 | Barcode scanning | POS Next | Exists |
| F4 | Barcode label printing (thermal + A4) | POS Awesome | Port |
| F5 | Scale barcodes with embedded weight or price | New doctype POS Scale Barcode Rule | Build |
| F6 | Sales person selection (optional or mandatory) | POS Next + LumenPOS idea | Exists, extend |
| F7 | Hold / park and resume sales | POS Next | Exists |
| F8 | Split, partial and credit payments | POS Next | Exists |
| F9 | One-click receipt printing, cash drawer | POS Next (QZ silent) + POS Awesome (raw ESC/POS) | Port + extend |
| F10 | Modern, touch-friendly UI in English and Arabic | POS Next | Exists, add RTL checks |
| F11 | UAE VAT tax invoice receipt | New | Build |
| F12 | Cashier-visible sync log | LumenPOS idea | Build |
| F13 | Item Wizard: buy in bags, sell by kg / gram / packs | New | Build |

### Non-goals (first release)

- Restaurant features (tables, kitchen display, modifiers).
- Native Android/iOS apps; the POS stays a PWA.
- New payment-gateway integrations; card terminals are recorded as a payment mode with a reference number.
- Rewriting loyalty, promotions or pricing rules; use ERPNext's own.

## 1a. Decisions after Phase 0

Phase 0 found 12 places where POS Next differs from this spec. The spec below has been updated to match these decisions. Commit this list as `docs/DECISIONS.md`; it overrides anything else in this doc.

| # | Finding | Decision |
| --- | --- | --- |
| 1 | POS Next already has `offline_id` + Offline Invoice Sync | Reuse them. No `offline_uuid`, no POS Sync Log. Missing fields added as Custom Fields |
| 2 | Failed invoices stay in the browser queue | Store payload + error on Offline Invoice Sync with status Failed; Retry from POS and desk. No Draft invoices |
| 3 | Scale barcodes need barcode\_resolver; POS Barcode Rules holds only a name | Own doctype POS Scale Barcode Rule in pos\_0001; parse in browser, re-validate on server. Don't install barcode\_resolver or change POS Barcode Rules |
| 4 | Scanning needs the server | Resolve from cached barcodes in the browser first |
| 5 | Sales person is mandatory when enabled, payment dialog only | Add Off / Optional / Mandatory, default per user, picker in cart header too |
| 6 | Held carts are local to one till | Server-side drafts when online; local copy offline, uploaded on reconnect |
| 7 | QZ signing keys are files in the site's private folder | Reuse them; no key fields in settings |
| 8 | Translations use Frappe CSV | Use `translations/ar.csv`; no ar.json |
| 9 | Frontend is JavaScript, no TypeScript | Stay in JavaScript with JSDoc types |
| 10 | `submit_invoice` doesn't check POS Profile access | Minimal patch, separate commit, offer upstream |
| 11 | Install fails on Node 20 (no lockfile) | Node 22 for this bench; commit `yarn.lock` |
| 12 | Credit is a POS Settings flag | Keep the flag |

## 2. Architecture decision

Fork POS Next as the base, keep every new feature in its own folders, and treat POS Awesome as a read-only reference to port from. This keeps merges from upstream POS Next cheap.

### Sources

| Repo | Role | License | Branch |
| --- | --- | --- | --- |
| [BrainWise-DEV/POSNext](https://github.com/BrainWise-DEV/POSNext) | Base: fork it | AGPL-3.0 | `version-15` (stable), `develop` |
| [defendicon/POS-Awesome-V15](https://github.com/defendicon/POS-Awesome-V15) | Reference: port label printing, raw ESC/POS, virtual scroll, shortcuts | GPL-3.0 | default |
| LumenPOS | Ideas only (sync log, mandatory sales person, commission report) — do not copy code, license not stated | Unknown | — |

### Rules for the codebase

1. **Isolation:** all new backend code lives in the `pos_next/pos_0001/` sub-package; all new frontend code in a `plus/` folder inside the frontend `src/`. Edits to POS Next's own files are kept small (hooks, imports, a slot or event) and each is listed in `docs/UPSTREAM_PATCHES.md`.
2. **Remotes:** `origin` = `yousefpahang/pos_0001`; `upstream` = BrainWise-DEV/POSNext. Merge `upstream/version-15` monthly.
3. **POS Awesome is never a dependency.** It is cloned at `~/reference/posawesome`. Port logic by rewriting it: its UI is Vuetify, ours is Tailwind, so components are rebuilt, not copied. Python and pure-JS logic (ZPL/EPL builders, QZ calls, barcode templates) may be adapted with attribution.
4. **Reuse before adding:** where POS Next already does something (offline\_id, Offline Invoice Sync, QZ key files, CSV translations), extend it with custom fields or hooks instead of building a parallel version.
5. **Shared parsing logic:** anything the POS must do offline (barcode parsing, totals, tax, rounding) is written once in plain JavaScript with JSDoc types under `plus/core/`, with no UI imports, and mirrored in Python only where the server must validate.
6. **Hardware:** printers are reached through [QZ Tray](https://qz.io) on each till; network ESC/POS printers may also be reached through QZ. No other local agent.
7. **Node 22** for this bench, with `yarn.lock` committed.

### Target repo layout (additions only)

```text
pos_next/                      # POS Next python package (confirmed in Phase 0)
  pos_0001/
    demo/           seed.py                       # done in Phase 0
    api/            sync.py  labels.py  printing.py  barcode.py  reports.py
    doctype/        pos_0001_settings/  pos_printer_profile/  pos_label_template/
                    pos_device/  pos_scale_barcode_rule/
    print_format/   uae_tax_invoice_80mm/
    report/         sales_person_commission/
    tests/
  translations/     ar.csv                        # existing Frappe CSV, add our strings
<frontend>/src/                # exact path in ARCHITECTURE_NOTES.md
  plus/
    core/           scaleBarcode.js  ean.js  escpos.js  zpl.js  tspl.js  rounding.js
    printing/       qz.js  receipt.js  labels.js  raster.js
    sync/           syncLog.js
    components/     LabelPrintDialog.vue  SyncLogPanel.vue  SalesPersonPicker.vue
docs/
  SPEC.md  DECISIONS.md  ARCHITECTURE_NOTES.md  PROGRESS.md
  UPSTREAM_PATCHES.md  HARDWARE.md  NOTICE.md
```

### License obligations

GPL-3.0 code may be combined with AGPL-3.0 code; the combined app is distributed under AGPL-3.0. Keep original copyright headers, credit both projects in `NOTICE.md`, and add an "About / Source code" link in the POS so users of a hosted install can get the source. You can still charge for setup, hosting, hardware and support. This is not legal advice; confirm with a lawyer before selling.

## 3. Phase 0: environment and repo exploration

Before writing any feature, Claude Code sets up a v15 bench and writes `docs/ARCHITECTURE_NOTES.md` describing how POS Next and POS Awesome actually work. Every path in this spec marked "to confirm" is checked here.

### Environment (v15)

**Status: Phase 0 is done** (commits 64b7fda, 5a872b9, 06a0fff). The bench is a separate one at `~/projects/pos/frappe-bench` so it can't affect `~/frappe-bench`.

- Ubuntu, Python 3.11, **Node 22** (via nvm, this bench only), Yarn, MariaDB 10.6+, Redis, wkhtmltopdf.
- Ports: web 8001, socketio 9001, redis 11001 / 13001, file watcher 6788 (the other bench uses 8000/9000/11000/13000).
- Phase 0 installed the frontend with `yarn install --ignore-engines` because there was no lockfile. Phase 1 switches to Node 22 and commits `yarn.lock`.

```bash
# Reference only - already done in Phase 0
cd ~/projects/pos
bench init frappe-bench --frappe-branch version-15 --python python3.11
cd frappe-bench
bench get-app erpnext --branch version-15
bench new-site pos.test --admin-password admin
bench --site pos.test install-app erpnext
bench get-app https://github.com/yousefpahang/pos_0001 --branch version-15
bench --site pos.test install-app pos_next
bench --site pos.test set-config developer_mode 1
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

- **Cached on login and refreshed in the background (every 5 min, configurable):** items, item barcodes (incl. UOM barcodes), prices for the profile's price list, item tax templates, stock qty per warehouse (informational), customers, sales persons, payment modes, POS Profile, scale barcode rules, printer profiles, label templates, print-format data.
- **Idempotency:** reuse POS Next's existing `offline_id` and Offline Invoice Sync doctype, which already stop duplicates. Verify with a test that sending the same `offline_id` twice creates one invoice.
- **Queue:** keep POS Next's browser queue; sync runs on reconnect, every 30 s while items are pending, and on demand.
- **Failure handling:** when the server rejects an invoice, store the full payload and the error on its Offline Invoice Sync record with status Failed (add `status`, `error`, `payload`, `pos_device` as Custom Fields if missing). Do not create a Draft invoice. The browser removes an invoice from its queue only after the server confirms Synced or Failed-and-stored. Retry is available in the POS sync panel and as a button on the Offline Invoice Sync form in desk.
- **Stock while offline:** setting `offline_negative_stock` = Allow / Warn / Block (default Warn).
- **Price changes while offline:** the sale keeps the price the cashier saw; server records `offline_price_mismatch = 1` for review.
- **Shift rules:** a shift opened online can continue offline; closing a shift requires the queue to be empty and no Failed records for that shift.
- **F12 Sync log panel:** a badge (Online / Offline / n pending / n failed) opens a panel listing each queued or failed invoice: time, total, status (Pending, Synced, Failed), error in plain words, Retry button. Data comes from the browser queue plus Offline Invoice Sync.

### F5 Scale barcodes (weight or price embedded)

Scanning a label printed by a shop scale adds the right item at the right weight and price, online or offline, with no keystroke.

POS Next's `POS Barcode Rules` holds only a rule name and needs the separate barcode\_resolver app, so we leave both alone. Create a new doctype **POS Scale Barcode Rule** in `pos_0001` with these fields:

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

1. Parse in the browser in `plus/core/scaleBarcode.js` so it works offline; the server re-validates the same barcode on sync (`pos_0001/api/barcode.py`).
2. Scanning resolves from the cached item barcodes in the browser first (this also makes normal barcode scans work offline). Scale rules run only when there is no exact barcode match. The server is called only if online and still not found.
3. Item UOM must be Kg (or the rule's UOM); if not, show an error naming the item.
4. Price-embedded: qty rounded to 3 decimals; line amount equals the printed price exactly (adjust rate rounding, not amount).
5. Same scale label scanned twice adds two lines, never merges.
6. Rules apply per company, optionally limited to listed POS Profiles.

Test vectors (valid EAN-13 check digits; rule A = prefix 20 weight, rule B = prefix 22 price; item PLU 12345):

| Barcode | Rule | Expected |
| --- | --- | --- |
| `2012345012509` | A | qty 1.250 kg |
| `2012345007505` | A | qty 0.750 kg |
| `2212345025008` | B | amount AED 25.00 |
| `2212345009992` | B | amount AED 9.99 |
| `2012345012508` | A | wrong check digit → error (if Validate) |

### F6 Sales person

- POS Next today makes sales person mandatory whenever it is enabled, and only in the payment dialog. Extend it, keeping its existing code path:
- Setting per POS Profile (custom field): Off / Optional / Mandatory.
- Default sales person per user (custom field on User), pre-selected on each new cart.
- Picker in the cart header as well as the payment dialog; search by name or scan the employee's barcode (`sales_person_barcode`).
- Several sales persons with allocation %, written to the invoice's Sales Team table so ERPNext commission reports work. Works offline from cache.
- New report **Sales Person Commission**: sales person, invoices, net sales, returns, commission rate, commission (AED), date range and POS Profile filters.

### F7 Hold / park

- POS Next keeps held carts only in the browser, so they can't move between tills. Change this:
- Hold button (F8) parks the cart with an optional note; held list shows time, customer, total, cashier, till.
- Online: saved on the server as a draft invoice, so any till with the same POS Profile can resume it. Offline: saved locally and uploaded as a draft on reconnect.
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
- **QZ signing:** reuse POS Next's existing QZ signing, which keeps its certificate and key as files in the site's private folder, so tills show no trust prompts. Do not add key fields to settings. Document the certificate setup in `docs/HARDWARE.md`.
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

## 5a. Feature spec: item setup wizard

### F13 Item Wizard (buy in bags, sell by kg, gram or other units)

A shop manager creates a correctly configured item in under 2 minutes, without knowing ERPNext's UOM conversion, Item Price or barcode tables. The wizard asks plain questions and writes every ERPNext record in one transaction.

**Where it lives:** a route `/pos/items/new` inside the POS app (same Vue + Tailwind UI), opened from a "New item" button in the POS item menu and from a "Create with Wizard" button on the desk Item list. Requires a new role permission `POS Item Wizard` (managers only). Needs to be online.

**Core rule for weighed goods:** the stock UOM is the weighing unit (Kg, or Litre for liquids), and prices are set per Kg/Litre. Gram and ml are entry units only: when a cashier enters 250 g, the cart line becomes 0.250 Kg at the per-Kg price. Do not create Item Prices per Gram: at 2-decimal currency precision a per-gram price like AED 0.0045 rounds to 0.00.

### Steps

1. **Start:** pick a preset or start blank. Presets: "Bulk by weight (sack/bag → kg)", "Liquid (drum/can → litre)", "Pieces in a carton", "Pre-packed portions from bulk", plus "Copy from existing item" and any presets the shop saved.
2. **Basics:** name in English and Arabic (`item_name_ar`), item group, brand, image. Item code auto-generated from the item group's naming series; editable.
3. **How you buy it:** buying unit (Bag, Sack, Carton, Drum — missing UOMs are created) and how much is in one, e.g. 1 Bag = 25 Kg. Optional second level, e.g. 1 Carton = 12 Packs, 1 Pack = 500 g. Supplier and buying price per buying unit (optional).
4. **How you sell it:** tick the selling units and set each one's size — Kg (by weight), Gram entry, a pre-packed 500 g pack, the whole Bag, etc. Toggle "Sold on the scale" to assign the next free `scale_plu` and link the shop's POS Scale Barcode Rule.
5. **Prices:** enter the price per Kg (or a margin % over cost). The wizard shows the calculated price for every selling unit, cost per Kg, and margin per unit, and lets you override any unit's price (e.g. a cheaper whole-bag price). Asks once whether prices include VAT, and picks the VAT template (5% / zero-rated / exempt). Warns in red when any unit sells below cost.
6. **Barcodes:** scan or type a barcode per selling unit, or press Generate (internal EAN-13 with prefix from settings and a valid check digit). Duplicates are blocked with the name of the item that already uses it.
7. **Opening stock (optional):** quantity in buying units (e.g. 4 Bags), warehouse, cost; shown as the converted stock (100 Kg).
8. **Review and create:** one summary screen, then Create. Afterwards offer: print labels (F4), create another like this, save as preset, open the item.

### Worked example — rice bought in 25 kg bags

| Selling unit | Conversion to stock UOM (Kg) | Price (AED, incl. VAT) | How it's set |
| --- | --- | --- | --- |
| Kg (weighed on scale) | 1 | 4.50 | Entered (cost 3.00/kg from AED 75 per bag, 50% margin) |
| Gram (entry unit) | 0.001 | — | No price; converted to Kg in the cart |
| Pack 500 g (pre-packed) | 0.5 | 2.50 | Calculated 2.25, rounded up by user |
| Bag 25 kg | 25 | 99.00 | Override (cheaper than 25 × 4.50 = 112.50) |

### What Create writes (one DB transaction, rolled back on any error)

- **Item:** stock UOM, `purchase_uom`, `sales_uom`, the UOM conversion table, `item_name_ar`, `scale_plu`, item tax template, default warehouse, and `is_stock_item`.
- **UOMs:** any missing ones are created. Kg, Gram and Litre have "must be whole number" off; Bag, Carton and Pack have it on.
- **Item Barcode** rows, one per selling unit with its UOM.
- **Item Price** rows per UOM in the POS Profile's selling price list, plus the buying price in the buying price list.
- **Item Supplier**, if a supplier was given.
- **Opening stock:** a Material Receipt Stock Entry, if opening stock was entered.

### Also

- **Edit packaging:** open an existing item in the wizard at steps 3–6 to add a unit, change prices or add barcodes. Nothing is deleted. Removing a unit only disables its barcode and price.
- **Bulk:** a CSV template with the same columns as the wizard (one row per item, units as columns) for importing many items at once. It goes through the same validation and creation code as the wizard.
- **POS support:** cashier can type a weight in grams for Kg items (the 250 → 0.250 Kg conversion); a unit picker on the cart line switches between the item's selling units and applies that unit's price.

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

Six new doctypes and a set of custom fields (shipped as fixtures). POS Next's own doctypes are reused and extended only through Custom Fields, never by editing their JSON.

### New doctypes

| Doctype | Type | Key fields |
| --- | --- | --- |
| POS 0001 Settings | Single | `offline_negative_stock` (Allow/Warn/Block), `cache_refresh_minutes` (5), `held_cart_retention_days` (3), `default_cash_rounding`, `about_source_url`, `internal_barcode_prefix` (e.g. `29`), `next_scale_plu` |
| POS Scale Barcode Rule | Master | `company`, `pos_profiles` (table, optional), `prefix`, `total_length`, `item_code_start`, `item_code_length`, `item_match` (Item Barcode / scale\_plu), `value_type` (Weight/Price), `value_start`, `value_length`, `decimals`, `uom`, `check_digit_mode` (Validate/Ignore), `priority`, `enabled` |
| POS Printer Profile | Master | `printer_name`, `purpose` (Receipt/Label), `connection` (QZ local name / Network IP:port), `print_mode` (raster/escpos\_text/qz\_html/browser), `paper_width_mm` (80/58), `dpi`, `auto_cut`, `copies`, `drawer_kick`, `label_language` (ZPL/EPL/TSPL) |
| POS Label Template | Master | `width_mm`, `height_mm`, `dpi`, `language` (ZPL/EPL/TSPL/PDF), `barcode_type` (Code128/EAN13), `body` (Code, Jinja), `a4_columns`, `a4_rows`, `margins_mm`, `is_default` |
| POS Device | Master | `device_id` (UUID from the browser), `device_name`, `pos_profile`, `receipt_printer`, `label_printer`, `last_seen`, `app_version` |
| POS Item Wizard Preset | Master | `preset_name`, `item_group`, `stock_uom`, `buying_units` (table: uom, size, parent uom), `selling_units` (table: uom, size, priced, default margin %), `sold_on_scale`, `item_tax_template`, `prices_include_vat` |

### Custom fields

| Doctype | Field | Type | Purpose |
| --- | --- | --- | --- |
| Offline Invoice Sync (POS Next) | `status` (Synced/Failed), `error`, `payload`, `pos_device`, `retry_count` | Custom Fields, only those missing | Failed-sync storage and Retry (decision 2) |
| Invoice doctype POS Next creates (see notes) | `pos_device` | Link POS Device | Audit |
| same | `offline_price_mismatch` | Check | Review prices changed while offline |
| POS Profile | `pos0001_sales_person_mode` | Select Off/Optional/Mandatory | F6 |
| POS Profile | `pos0001_receipt_template`, `pos0001_default_label_template` | Links | Printing defaults |
| POS Profile | `pos0001_receipt_footer`, `pos0001_receipt_logo` | Text / Attach Image | Receipt branding |
| Item | `item_name_ar` | Data | Arabic name |
| Item | `scale_plu` | Data, indexed | Scale barcode item code |
| Sales Person | `sales_person_barcode` | Data, unique | Scan to select |
| User | `pos0001_default_sales_person` | Link Sales Person | Default per cashier |

Roles: reuse POS Next's cashier and manager roles; add permission `No Sale drawer open` and `Print labels` checks via role on POS Profile.

## 9. API endpoints

All new endpoints are `@frappe.whitelist()` methods under `<package>.pos_0001.api`, require a logged-in user with a POS role, and check POS Profile access server-side. Use existing POS Next endpoints where they already exist; do not duplicate them.

| Method | Input | Output | Notes |
| --- | --- | --- | --- |
| `sync.retry_failed` | `offline_ids[]` | per invoice: `{offline_id, status, invoice_name, error}` | Re-submits stored payloads from Offline Invoice Sync; also a desk button |
| `sync.get_sync_status` | `device_id`, `limit` | Offline Invoice Sync rows for this device | For the sync panel |
| `sync.register_device` | `device_id`, `device_name`, `pos_profile` | POS Device + printer profiles | Called on first login per browser |
| `barcode.get_scale_rules` | `pos_profile` | rules\[\] | Cached offline |
| `barcode.resolve_scale_barcode` | `barcode`, `pos_profile` | `{item_code, qty, amount}` | Server-side re-validation, same logic as the browser |
| `barcode.generate_scale_barcode` | `rule`, `item_code`, `value` | EAN-13 string | Valid check digit |
| `printing.get_receipt_data` | `invoice` | receipt JSON | For reprints; live sales build receipts locally |
| `labels.items_from_document` | `doctype`, `name` | rows\[\] | Purchase Receipt, Stock Entry |
| `labels.render` | `template`, `rows[]` | raw string (ZPL/EPL/TSPL) or PDF file URL | Desk page; the POS renders locally |
| `reports.sales_person_commission` | `from_date`, `to_date`, `pos_profile?` | rows | Also a Script Report |
| `items.wizard_defaults` | `pos_profile`, `preset?`, `copy_from?` | defaults for every step | Price lists, warehouse, VAT templates, UOM list, next PLU |
| `items.wizard_preview` | wizard payload | per-unit prices, cost, margin, warnings | No writes; called as the user types (debounced) |
| `items.wizard_validate` | wizard payload | errors\[\] per step | Duplicate barcodes, codes, PLUs; conversions > 0; below-cost warnings |
| `items.wizard_create` | wizard payload | `{item_code, created: [...]}` | One transaction; rolls back on any error |
| `items.wizard_update_packaging` | `item_code`, payload | changes made | Edit mode; never deletes, only disables |
| `items.generate_internal_barcode` | `uom?` | EAN-13 | Uses `internal_barcode_prefix`, unique |
| `items.import_wizard_csv` | file | per-row result | Same validation and create code |

Invoice submit stays in POS Next's `submit_invoice`; per decision 10 we add a POS Profile access check there as a minimal, separate patch. QZ signing uses POS Next's existing endpoint.

Conventions: type hints on every function, `frappe.throw` with translatable messages (`_()`), no raw SQL where the Query Builder works, and every endpoint has at least one test.

## 10. Testing and acceptance

A phase is done only when its automated tests pass and its acceptance checks below pass on the `pos.test` site.

### Automated tests

- **Python** (`bench --site pos.test run-tests --app pos_next`, our tests under `pos_0001/tests/`): scale barcode vectors (F5 table), same `offline_id` sent twice → one invoice, rejected invoice → Offline Invoice Sync status Failed with payload and error, Retry succeeds after fixing the cause, POS Profile access check on `submit_invoice`, sales-person allocation totals 100%, label rendering snapshots, commission report totals, Item Wizard create for each preset (records match the F13 list, rollback on error, duplicate barcode blocked).
- **Frontend unit** (Vitest, added as a dev dependency in Phase 1): `scaleBarcode.js`, `ean.js` check digits, totals/VAT/rounding, ESC/POS and ZPL/TSPL builders (byte snapshots), raster conversion of a fixed receipt.
- **End-to-end** (Playwright, Chromium): login → cache → go offline (`context.setOffline(true)`) → sell 10 invoices incl. scanned and scale items, split payment, held cart → go online → assert 10 invoices in ERPNext, no duplicates, GL and stock entries correct; hold on one browser context and resume on another.
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
- [ ] A manager with no ERPNext training creates the rice example from F13 in under 2 minutes; the POS then sells 250 g, a 500 g pack and a whole bag at the right prices, and stock drops by 0.25, 0.5 and 25 Kg.

### Hardware test matrix (fill in with clients' models)

| Type | Models to test | Connection |
| --- | --- | --- |
| Receipt printer | Epson TM-T20/T82, Xprinter XP-80 series | USB, LAN |
| Label printer | Zebra (ZPL), TSC (TSPL), Xprinter label | USB, LAN |
| Scale (label printing) | CAS, DIGI, Mettler Toledo, Bizerba | prints EAN-13 labels |
| Scanner | Any HID keyboard-wedge 1D/2D | USB, Bluetooth |
| Cash drawer | RJ11 via receipt printer | printer kick |

## 11. Build phases and Claude Code prompts

Phase 0 is done. Phases 1–9 run unattended with `run_phases.sh`, one fresh Claude Code run per phase; each reads `CLAUDE.md`, `docs/SPEC.md`, `docs/DECISIONS.md`, `docs/ARCHITECTURE_NOTES.md` and `docs/PROGRESS.md`, and ends by writing `PHASE N: DONE` or `PHASE N: BLOCKED - reason` in `docs/PROGRESS.md`. Review `PROGRESS.md` (manual checks, decisions to review) after the run.

| Phase | Delivers | Depends on | Rough size |
| --- | --- | --- | --- |
| 0 | Bench, seed data, ARCHITECTURE\_NOTES.md (done) | — | done |
| 1 | Node 22 + yarn.lock, doctypes, custom fields, failed-sync storage + Retry, sync panel, access check, Vitest/Playwright setup | 0 | 3–4 days |
| 2 | Scale barcodes, offline scanning | 1 | 2 days |
| 3 | Sales person modes + commission report | 1 | 2 days |
| 4 | Receipt printing (raster, ESC/POS, drawer) | 1 | 4–5 days |
| 5 | Label printing | 4 | 4 days |
| 6 | Performance, server-side held carts, shortcuts | 2 | 3 days |
| 7 | UAE receipt, Arabic/RTL | 4 | 2–3 days |
| 8 | Item Wizard (F13), gram entry and unit picker in the cart | 2, 5, 7 | 4–5 days |
| 9 | Hardening, e2e, docs, release | all | 3 days |

**Phase 0**

```text
Read docs/SPEC.md sections 1-3. Set up the v15 bench and test site exactly as in section 3, clone POS Awesome to ~/reference/posawesome, and write a seed script (bench execute) for the demo data in section 3. Then work through every item of the exploration checklist and write docs/ARCHITECTURE_NOTES.md with file paths, function names and short code excerpts. List every "to confirm" path from the spec with its real value. Do not change any POS Next code in this phase.
```

**Phase 1**

```text
Read docs/SPEC.md sections 1a, 2, 4 (F1, F12), 8, 9, docs/DECISIONS.md and docs/ARCHITECTURE_NOTES.md. First switch this bench to Node 22, run a clean yarn install and commit yarn.lock; confirm bench build works. Add Vitest and Playwright as dev dependencies (note them in PROGRESS.md). Create the pos_0001 sub-package, POS 0001 Settings, POS Device, and the custom fields as fixtures (Offline Invoice Sync fields only where missing). Keep POS Next's offline_id duplicate protection; add failed-sync storage on Offline Invoice Sync (status Failed, payload, error), the Retry endpoint and desk button, device registration, and the sync badge + SyncLogPanel. Add the POS Profile access check to submit_invoice as its own commit. Keep edits to POS Next files minimal and record each in docs/UPSTREAM_PATCHES.md. Write the F1 tests from section 10. Run them and fix until green.
```

**Phase 2**

```text
Read docs/SPEC.md F5, docs/DECISIONS.md items 3-4 and the barcode notes in ARCHITECTURE_NOTES.md. Do not install barcode_resolver and do not change POS Barcode Rules. Create the POS Scale Barcode Rule doctype, implement plus/core/scaleBarcode.js and ean.js (plain JS with JSDoc, works offline), and the server re-validation in pos_0001/api/barcode.py. Make scanning resolve from cached item barcodes in the browser first, then scale rules, then the server only if online. Add the rules to the offline cache. All five F5 test vectors must pass in Vitest and in Python tests, and a scan must work with the network off.
```

**Phase 3**

```text
Read docs/SPEC.md F6. Add the Off/Optional/Mandatory mode on POS Profile, default sales person per user, barcode scan to select, multi-person allocation to the Sales Team table, offline cache, and the Sales Person Commission script report. Add tests for allocation and the report.
```

**Phase 4**

```text
Read docs/SPEC.md F9, docs/DECISIONS.md item 7 and ARCHITECTURE_NOTES.md (POS Next QZ silent print and POS Awesome raw printing). Reuse POS Next's QZ connection and its signing keys in the site's private folder. Implement POS Printer Profile and the four print modes. raster mode renders the receipt HTML to a canvas in a Web Worker, converts to 1-bit and sends GS v 0 via QZ. Add auto-cut, copies, drawer kick, No Sale with permission, reprint, receipt barcode, and fallback to browser printing when QZ is down. Byte-snapshot tests for the ESC/POS builder. Write docs/HARDWARE.md with QZ install and certificate steps.
```

**Phase 5**

```text
Read docs/SPEC.md F4 and the POS Awesome Barcode Printing notes. Port its label logic into plus/core/zpl.js, tspl.js and an EPL builder (plain JS), rebuild the UI in Tailwind (LabelPrintDialog + desk page pos-labels + Print Labels buttons on Purchase Receipt and Stock Entry), add POS Label Template with the three default templates, Arabic text as bitmap, A4 PDF grid, and scale-barcode label generation using POS Scale Barcode Rule. Credit POS Awesome in NOTICE.md and file headers. Snapshot tests for each label language.
```

**Phase 6**

```text
Read docs/SPEC.md section 6, F7 and docs/DECISIONS.md item 6. Make held carts server-side drafts when online (resumable on any till of the same POS Profile), keep the local copy when offline and upload it on reconnect, and add the retention cleanup. Then seed 20,000 items with pos_next/pos_0001/demo/seed.py, measure every target in the section 6 table with a small benchmark script, and add virtual scrolling, the IndexedDB search index, favourites grid, global scanner capture and Web Worker indexing until all targets pass. Add the keyboard shortcut map and the ? overlay. Report before/after numbers in docs/PERFORMANCE.md.
```

**Phase 7**

```text
Read docs/SPEC.md section 7 and docs/DECISIONS.md item 8. Create the UAE Tax Invoice 80mm receipt (bilingual, VAT 5%, TRN, credit-note variant), item_name_ar on receipts, labels and search, AED formatting, and check full RTL layout on every POS screen. Add Arabic for all new strings to Frappe's translations CSV (pos_next/translations/ar.csv). Keep invoice creation in one service function with a no-op hook for future e-invoicing.
```

**Phase 8**

```text
Read docs/SPEC.md section 5a (F13) and the item, UOM and pricing notes in ARCHITECTURE_NOTES.md. First check how POS Next handles item UOMs, UOM-specific Item Prices and the cart line UOM, and write findings in PROGRESS.md. Build the Item Wizard as route /pos/items/new in the POS app (Vue + Tailwind, 8 steps, with back/next, step validation and a progress bar), the desk Item list button, the POS Item Wizard role permission, the POS Item Wizard Preset doctype with the four default presets, and the items.* endpoints from section 9. wizard_create must write every record listed in F13 in one transaction and roll back on any error. Follow the core rule: price per Kg/Litre only, gram/ml as entry units. Add edit-packaging mode and the CSV import using the same create code. In the POS cart, add gram entry for Kg items and a unit picker that applies each unit's price. Arabic strings in the CSV translations. Python tests per preset (records created match F13, rollback, duplicate barcode), and a Playwright test for the rice example from section 5a through to selling 250 g, a 500 g pack and a bag.
```

**Phase 9**

```text
Run every test in docs/SPEC.md section 10 and fix failures. Test a clean install on a fresh v15 site and on a v16 bench. Write README (install, configure, hardware), CHANGELOG, NOTICE.md, and an upgrade note for merging upstream POS Next. Tag v1.0.0.
```

## 12. CLAUDE.md for the repo

Commit this as `CLAUDE.md` at the repo root before Phase 0. Claude Code reads it at the start of every session.

```markdown
# pos_0001 — project rules for Claude

Branded ERPNext POS: a fork of BrainWise POS Next (AGPL-3.0) with features ported
from POS Awesome (defendicon fork, GPL-3.0). Full spec: docs/SPEC.md.
docs/DECISIONS.md overrides SPEC.md wherever they differ.
How the base code works: docs/ARCHITECTURE_NOTES.md (read before changing anything).
Progress and status per phase: docs/PROGRESS.md.

## Targets
- Frappe/ERPNext v15 (branch version-15). v16 is not required at this stage (DECISIONS item 15).
- Bench: ~/projects/pos/frappe-bench (Node 22). Site: pos.test (admin/admin), http://localhost:8001/pos.
- Do not touch ~/frappe-bench; it is a different bench.
- POS Awesome reference: ~/reference/posawesome (read-only).

## Where code goes
- New backend code: pos_next/pos_0001/ only. New frontend code: <frontend>/src/plus/ only.
- Pure logic that must work offline (barcodes, totals, VAT, rounding, ESC/POS, ZPL/TSPL) goes in
  src/plus/core/ as plain JavaScript with JSDoc types, no Vue imports, with Vitest tests.
- Reuse POS Next first: offline_id + Offline Invoice Sync, QZ key files, CSV translations.
  Extend its doctypes only with Custom Fields (fixtures), never by editing their JSON.
- Editing POS Next's own files: keep the change minimal and add an entry to docs/UPSTREAM_PATCHES.md
  (file, reason, what changed).
- Never add POS Awesome or barcode_resolver as a dependency. Port logic, rebuild UI in Tailwind,
  credit POS Awesome in NOTICE.md. Never copy LumenPOS code.

## Conventions
- Python: type hints, frappe.qb over raw SQL, frappe.throw(_("...")) for user errors,
  every whitelisted method checks POS Profile access.
- Vue 3 + JavaScript (no TypeScript) + Tailwind, matching POS Next components and tokens.
- Every user-facing string translatable; Arabic goes in pos_next/translations/ar.csv. Check RTL.
- Schema changes only via doctype JSON or fixtures, plus a patch in patches.txt when data must move.
- Money: never edit line amounts to fix rounding; use ERPNext rounding adjustment.
- Never drop an offline invoice: it leaves the browser queue only when the server confirms
  Synced or Failed-and-stored.

## Commands (run from ~/projects/pos/frappe-bench)
- Build: bench build --app pos_next
- Migrate: bench --site pos.test migrate
- Python tests: bench --site pos.test run-tests --app pos_next
- Frontend tests and e2e: see docs/ARCHITECTURE_NOTES.md for the frontend folder, then yarn test / yarn e2e

## Definition of done for any task
1. Tests for the change exist and pass (Python + Vitest; Playwright for flows).
2. Works offline if it is used at the till.
3. No console errors; RTL checked for UI changes.
4. Docs updated (PROGRESS, UPSTREAM_PATCHES, HARDWARE as relevant).
5. Small, focused commits with clear messages.

## Ask before (when running unattended: choose the safest option, log it under
## "Decisions to review" in docs/PROGRESS.md, and continue)
- Changing an existing POS Next doctype's fields or behaviour.
- Adding a new npm or pip dependency.
- Anything touching GL entries, stock ledger or tax calculation logic.
```
