# Progress

## Phase 1

Run date: 2026-11-19 (unattended). Scope: SPEC section 11, Phase 1 prompt, with DECISIONS.md applied.

### What was built

**Toolchain**

- Bench runs on Node 22.23.5 (nvm). Clean `yarn install` in the app root and `POS/`; both `yarn.lock` files are
  now committed (removed from `.gitignore`). `.nvmrc` says `22`. README lists Node 22 as a prerequisite.
- `bench build --app pos_next` works on Node 22 without `--ignore-engines`.
- Dev dependencies (note for review):
  - **Vitest** 2.1.9 was already a POS Next dev dependency (with `jsdom`, `@vitest/coverage-v8`). Added
    `POS/vitest.config.js` so unit tests do not load the PWA build plugins.
  - **`@playwright/test`** `^1.57.0` (resolved 1.65.1) added to `POS/package.json` devDependencies. Chromium
    headless shell installed with `npx playwright install chromium` (in `~/.cache/ms-playwright`).
    Config `POS/playwright.config.js`, tests in `POS/e2e/`, script `yarn e2e`.

**Backend (`pos_next/pos_0001/`)**

- Module `POS 0001` registered in `modules.txt`.
- Doctypes: **POS 0001 Settings** (Single: `offline_negative_stock` Allow/Warn/Block default Warn,
  `cache_refresh_minutes` 5, `held_cart_retention_days` 3, `default_cash_rounding`, `about_source_url`) and
  **POS Device** (named by `device_id`; device name, POS Profile, disabled, last seen, last user, app version,
  user agent).
- Custom fields (`pos_0001/custom/*.json`, synced on migrate):
  - Offline Invoice Sync (only what was missing; `status` with Failed already existed): `pos_device`,
    `retry_count`, `last_attempt_at`, `grand_total`, `error`, `payload`.
  - Sales Invoice: `pos_device`, `offline_price_mismatch`.
  - POS Profile: `pos0001_sales_person_mode` (Off/Optional/Mandatory), `pos0001_receipt_template`,
    `pos0001_receipt_footer`, `pos0001_receipt_logo`.
  - Item: `item_name_ar`, `scale_plu` (indexed). Sales Person: `sales_person_barcode` (unique).
    User: `pos0001_default_sales_person`.
- `pos_0001/permissions.py`: POS role check and POS Profile access check used by every new endpoint.
- `pos_0001/api/sync.py`:
  - `submit_offline_invoice(invoice, device_id)`: the browser queue's entry point. Runs POS Next's
    `submit_invoice` inside a savepoint. On rejection it rolls back to the savepoint (no Draft invoice is left)
    and stores the full payload, error, device and attempt count on the Offline Invoice Sync row with status
    Failed, then answers `{status: "Failed", stored: true}`. Duplicate protection stays POS Next's
    (`offline_id` + `_ensure_offline_uniqueness`).
  - `retry_failed(offline_ids)`: re-submits stored payloads; returns `{offline_id, status, invoice_name, error}`.
  - `get_sync_status(device_id, limit)`: rows for this device, limited to profiles the user may see.
  - `register_device(device_id, device_name, pos_profile, app_version)`: upserts POS Device.
  - Desk: **Retry** button on Failed Offline Invoice Sync records (`pos_0001/client/offline_invoice_sync.js`).
- POS Profile access check in POS Next's `submit_invoice` (own commit `1724d6b`, DECISIONS item 10).

**Frontend (`POS/src/plus/`)**

- `core/syncOutcome.js` (pure JS + JSDoc): when an invoice may leave the queue (Synced or Failed-and-stored
  only), queue row updates, merged sync-log rows, badge state, plain-words errors, 30 s auto-sync rule.
- `core/deviceId.js`: stable per-browser device id.
- `sync/syncClient.js`, `sync/syncLog.js` (Pinia store: merges browser queue + server rows, syncs every 30 s
  while invoices are pending and online, registers the device once per profile).
- `components/SyncBadge.vue` (Online / Offline / n pending / n failed, in the POS header) and
  `components/SyncLogPanel.vue` (time, total, status, error, Retry, Retry all failed, Sync now).
- POS Next's `utils/offline/sync.js` now submits through the new endpoint (minimal patch).
- Arabic for all new strings in `pos_next/translations/ar.csv` (57 rows).

**Fixes found on the way**

- Demo seed: all 20,000 `ITM-` items had `is_sales_item = 0` (inserted with `in_import`), so none could be sold.
  Seed fixed and the site updated (`mark_demo_items_sellable`).
- Upstream bug: `api/pos_profile.get_receivable_accounts` used `cint` without importing it (HTTP 500 on every
  till load). One-line fix, own commit, listed in UPSTREAM_PATCHES.md.

All edits to POS Next files are listed in `docs/UPSTREAM_PATCHES.md` (entries 1 to 10).

### Test results

- **Python** `bench --site pos.test run-tests --module pos_next.pos_0001.tests.test_sync`: **13 tests, OK**.
  Covers: same `offline_id` twice gives one invoice; rejected invoice stored as Failed with payload and error and
  no Draft; second failure increments `retry_count`; Retry succeeds after fixing the cause (and is a no-op after);
  device written on invoice and sync row; cashier on the profile can sync; `submit_invoice` rejects a user not on
  the POS Profile and a cashier with no profile; offline submit, Retry, register_device and sync status reject or
  hide other profiles; Guest is rejected.
- **Upstream Python modules** (regression check after the `submit_invoice` patch): `pos_next.test_promotions`
  18 OK, `pos_next.api.test_credit_sales` 4 OK, `pos_next.test_packed_items_regression` 3 OK,
  `pos_next.api.test_customers` 4 of 5 (1 failure, `AsyncMock` returns a coroutine in a loyalty test; the module
  under test was not changed in this phase, so the failure is pre-existing).
- `bench --site pos.test run-tests --app pos_next` (whole app) **does not start on v15**: upstream doctype tests
  (for example `bank_deposits/test_bank_deposits.py`) import `IntegrationTestCase`, which exists only in
  Frappe v16. Pre-existing; not changed (see Decisions to review). Run modules one by one until then.
- **Vitest** `cd POS && yarn test:run`: **26 tests, 2 files, all pass**.
- **Playwright** `cd POS && yarn e2e`: **2 tests pass** (about 40 s):
  1. Opens a shift, goes offline (`context.setOffline(true)`), badge shows offline; two invoices queued in
     IndexedDB (one for a disabled customer); back online, Sync now: the good one is Synced with an invoice and a
     device, the bad one is Failed on the server with payload, error and `retry_count` 1, and neither is still
     pending in the browser queue; panel shows the failure with its error; customer enabled, Retry in the panel
     gives Synced; sending the same `offline_id` again returns the same invoice. No unexpected console errors.
  2. RTL: with `dir="rtl"` the badge stays inside the viewport with a 44 px touch target, and the panel has no
     horizontal overflow.
- `bench --site pos.test migrate` and `bench build --app pos_next`: OK.

Console messages still seen on the till, both from POS Next and not errors of this phase: 404 for the optional
`/assets/nexus_demo/...` banner (the tag in `POS/index.html` removes itself on error) and 417 from
`api.qz.get_certificate` while no QZ certificate is set up (Phase 4).

### Manual checks (need real hardware or a person)

- [ ] Pull the network cable mid-sale on a real till, finish the sale and print, reconnect: invoice appears once
      and the badge goes Offline, then n pending, then Online.
- [ ] Make a sale through the full UI while offline (scan, pay, print). The e2e test queues invoices straight into
      IndexedDB; the full UI selling flow is planned for Phase 8 e2e.
- [ ] Desk: open a Failed Offline Invoice Sync record, check the red headline and the Retry button.
- [ ] Switch the POS language to Arabic (allowed locales) and look at the badge and Sync Log panel; only
      `dir="rtl"` was simulated automatically.
- [ ] Tablet / 1024x768: header has room for the badge (the full label shows only at 1536 px and wider;
      narrower screens show a compact count).

### Not done in this phase (belongs to later phases or not in the Phase 1 prompt)

- Behaviour behind `offline_negative_stock`, `cache_refresh_minutes`, `held_cart_retention_days`,
  `default_cash_rounding` and `offline_price_mismatch` (fields exist; logic not built yet).
- Shift close blocked while the queue is not empty or Failed records exist (F1 shift rules).
- POS Device `receipt_printer` / `label_printer` links (need POS Printer Profile, Phase 4) and POS Profile
  `pos0001_default_label_template` (needs POS Label Template, Phase 5).
- Load test of 500 queued invoices from 5 devices (section 10; Phase 8).

### Decisions to review

1. **New npm dev dependency `@playwright/test`** (asked for by the Phase 1 prompt). POS Next's root
   `package.json` already had `playwright` as a runtime dependency; left as is.
2. **Custom fields ship as module customizations** (`pos_next/pos_0001/custom/*.json`, `sync_on_migrate`), not
   through the `fixtures` hook. Same result on migrate, no `hooks.py` change, and the files stay in our folder.
3. **Failed-sync storage is a wrapper, not a change to `submit_invoice`.** `pos_0001.api.sync.submit_offline_invoice`
   wraps POS Next's `submit_invoice` in a savepoint; the browser queue (`utils/offline/sync.js`) calls the wrapper.
   Online sales still call `submit_invoice` directly as before.
4. **Access rule** used in the `submit_invoice` patch and our endpoints: the user must be in the profile's
   POS Profile User table; Administrator, System Manager and Nexus POS Manager pass. A cashier sending no
   `pos_profile` is rejected. POS Next's own read checks also accept "has Sales Invoice read", which every
   cashier has, so that fallback was not used. Check this matches how clients assign tills.
5. **Stored failures stay in the browser** as `synced: true, server_status: "Failed"` rows so the panel can show
   them while offline; they are removed by POS Next's existing 7-day cleanup. They are never re-sent by the
   browser; Retry goes through the server copy.
6. **Transient database errors** (deadlock, lock timeout) are not stored as Failed: the request fails and the
   invoice stays in the browser queue for the next sync. "Being processed by another request" answers Pending.
7. Each rejected invoice writes three Error Log rows (POS Next's "Update Invoice Error" and "Submit Invoice
   Error", which survive the savepoint, plus ours named after the `offline_id`). Accepted to avoid editing
   POS Next; could be reduced later.
8. **Upstream test suite on v15**: whole-app `run-tests` fails on import because of v16-only
   `IntegrationTestCase` in POS Next's doctype tests. Not patched (would touch about ten upstream files).
   Options: a small compatibility shim in those tests, or ask BrainWise for a v15-safe import.
9. `allow_tests` was set to true in `pos.test` site config so tests can run.
10. Two fixes outside the phase scope were committed separately: demo seed `is_sales_item`, and the upstream
    `cint` import (both described above).
11. Device name: the browser proposes "<platform> <first 8 chars of id>" on first registration; later
    registrations keep any name a manager set in desk.
12. During this run another process changed and committed `pos_next/pos_0001/demo/seed.py`
    (commit `9080847`, new `ensure_item_prices()`; demo items showed AED 0.00 on the till). That commit was not
    made by this phase and was left as is. Please confirm it is wanted.

PHASE 1: DONE

## Phase 2

Run date: 2026-11-19 (unattended). Scope: SPEC section 11, Phase 2 prompt (scale barcodes, offline scanning),
with DECISIONS.md items 3 and 4 applied. `barcode_resolver` was not installed and `POS Barcode Rules` was not
changed.

### What was built

**Backend (`pos_next/pos_0001/`)**

- Doctype **POS Scale Barcode Rule** (named by `rule_name`) with the SPEC F5 / section 8 fields: `company`,
  `pos_profiles` (Table MultiSelect, child doctype **POS Scale Barcode Rule Profile**; empty = every profile of the
  company), `prefix`, `total_length` (8-20), `item_code_start` / `item_code_length`, `item_match`
  (Scale PLU / Item Barcode), `value_type` (Weight / Price), `value_start` / `value_length`, `decimals`, `uom`
  (default Kg), `check_digit_mode` (Validate / Ignore), `priority`, `enabled`, and a read-only example barcode.
  The controller rejects layouts where segments overlap or run into the check digit (last digit), with plain
  messages. Cashiers can read rules; Nexus POS Manager and System Manager can edit.
- `scale_barcode.py`: pure Python copy of the browser logic (GS1 check digit, parsing, price-line rounding,
  barcode generation).
- `api/barcode.py` (all endpoints check the POS role and POS Profile access):
  - `get_scale_rules(pos_profile)`: rules for the profile (SPEC section 9).
  - `get_scan_cache(pos_profile)`: rules + Scale PLU map + UOM barcode map + refresh minutes, for the browser.
  - `resolve_scale_barcode(barcode, pos_profile)`: `{item_code, qty, amount, rate, uom, ...}`, same logic as the
    browser; plain errors for no rule, wrong check digit, unknown PLU, item not sold in the rule's UOM, no price.
  - `generate_scale_barcode(rule, item_code, value)`: barcode with a valid check digit (for Phase 5 labels).
  - `validate_sales_invoice`: Sales Invoice `validate` hook. Every line with `pos0001_scale_barcode` is parsed
    again with the company's rules; a line whose item, weight or amount does not match its label is rejected
    (an offline invoice is then stored as Failed by the Phase 1 flow).
- Custom field **Sales Invoice Item `pos0001_scale_barcode`** (read-only) carries the label to the server.
- Demo seed: `scale_plu` 12345 .. 12394 on the weighed items, rules **Scale Weight 20** (rule A) and
  **Scale Price 22** (rule B) for Demo Trading LLC (`ensure_scale_barcodes()`, also run on `pos.test`).

**Frontend (`POS/src/plus/`)**

- `core/ean.js`: GS1 mod-10 check digits (EAN-8, UPC-A, EAN-13, longer custom codes).
- `core/scaleBarcode.js`: rule normalisation and layout checks, parsing (first rule by priority whose prefix and
  length match), price-embedded lines (qty to 3 decimals, rate adjusted so qty x rate is exactly the printed
  price, never the amount), label barcode generation, and the cart item for a scale line.
- `core/scanResolve.js`: resolution order (1) exact barcode in the browser cache (UOM barcodes first, then POS
  Next's `items.barcodes` index), (2) scale rules with the PLU from the cache, (3) the server only when online
  and still not found.
- `scan/scanCache.js`: rules, PLU map and UOM barcodes per profile in IndexedDB (`settings` store,
  `pos0001_scan_cache::<profile>`), loaded when the till opens (started by the sync log store) and refreshed every
  `cache_refresh_minutes` while online.
- `scan/scanner.js`: wires the above to POS Next's Dexie cache and server lookups; cashier messages for errors.
- POS Next patches (UPSTREAM_PATCHES.md entries 11-16): `searchByBarcode()` uses the scanner; scan errors show
  their own message; scale labels always add with no keystroke at the label's rate; the same label scanned twice
  gives two read-only lines; the remove button removes only the clicked scale line; the invoice sends
  `pos0001_scale_barcode`.
- Arabic for all new strings in `pos_next/translations/ar.csv` (69 rows).

### Test results

- **Python** `bench --site pos.test run-tests --module pos_next.pos_0001.tests.test_barcode`: **19 tests, OK**.
  All five SPEC F5 vectors (pure logic and through `resolve_scale_barcode` as the cashier: 1.250 kg, 0.750 kg,
  AED 25.00, AED 9.99, wrong check digit rejected), Ignore mode, price-line exactness over 56 price/rate pairs,
  banker's/half-up tie avoided, barcode generation round trip, invalid layouts, rules limited to profiles, scan
  cache contents (PLU map, box and multi-barcode UOMs), access checks (outsider, Guest), item not sold in Kg named
  in the error, generate endpoint, rule form example. Sync: an offline invoice with the same weight label twice
  plus a price label is Synced with two 1.25 kg lines and a 9.99 line; tampered weight, tampered price and wrong
  item are stored as Failed with the reason.
- `pos_next.pos_0001.tests.test_sync` (Phase 1): **13 tests, OK**. Upstream modules after the new validate hook:
  `pos_next.test_promotions` 18 OK, `pos_next.api.test_credit_sales` 4 OK, `pos_next.test_packed_items_regression`
  3 OK.
- **Vitest** `cd POS && yarn test:run`: **60 tests, 5 files, all pass** (`ean`, `scaleBarcode` with the five F5
  vectors, `scanResolve` incl. "no server call when offline", plus Phase 1 files).
- **Playwright** `cd POS && yarn e2e`: **3 tests pass**. New `e2e/scale-scan.spec.js`: waits for the item and scan
  caches, sets the browser offline, scans the weight label twice, the price label and a normal EAN-13 through the
  search box: four cart lines (1.25, 1.25 read-only; price line amount AED 9.99; normal item qty 1), the bad check
  digit shows "wrong check digit" and adds nothing, removing one of the two identical lines leaves the other, no
  barcode request was sent, no console errors.
- `bench --site pos.test migrate`, `bench build --app pos_next`: OK. `biome check` clean on `src/plus`.
- Note: ERPNext's `before_tests` hook deletes every Item Price on the site when `run-tests` starts (this is why
  demo prices kept disappearing, see Phase 1 decision 12). Tests now create the price they need; after the run the
  demo prices were rebuilt with `seed.ensure_item_prices`.

### Manual checks (need real hardware or a person)

- [ ] Scan 5 real labels from the client's scale (weight and price types) with a real HID scanner; qty and amount
      match the printed label. Set the rule layout (prefix, positions, decimals) to the scale's label format first.
- [ ] Scale that prints wrong check digits: set the rule to Ignore and scan a label.
- [ ] Full offline sale through the payment dialog with scale lines, then reconnect: the invoice syncs and keeps
      the label amounts. Automated today: scanning offline (e2e) and the server side of the same payload (Python);
      the full UI payment flow is planned for Phase 8 e2e.
- [ ] Desk: create a rule in the form, check the Example field and the layout error messages, in English and
      Arabic.
- [ ] Arabic UI: the scan warning toasts read correctly in RTL (no new layout was added; only messages).
- [ ] Scan-to-cart time under 150 ms on a real till with 20,000 items cached (not measured here; Phase 6).

### Not done in this phase (later phases)

- Printing scale-barcode labels (Phase 5 uses `generate_scale_barcode` / `generateScaleBarcode`).
- Global scanner capture without focusing the search box (Phase 6).

### Decisions to review

1. **Server re-validation is a Sales Invoice `validate` hook** (`hooks.py`, UPSTREAM_PATCHES entry 11), so it covers
   online and offline sales. It only looks at lines with `pos0001_scale_barcode`, skips returns, and accepts a line
   whose barcode no longer matches any enabled rule (for example a rule disabled after an offline sale), so a rule
   change never strands an offline invoice. A line that matches a rule but not its item, weight (±0.0005) or
   amount (±0.005) is rejected. This can reject invoices, but touches no tax, GL or stock logic.
2. **New custom field `Sales Invoice Item.pos0001_scale_barcode`**, not in the SPEC section 8 list. Needed to carry
   the label to the server; read-only, hidden on prints.
3. **Price labels adjust the rate, not the amount**: qty is rounded to 3 decimals and the rate (2 decimals) is
   chosen as close to the list rate as possible so that qty x rate is exactly the printed price. Example on the
   demo site: list AED 38.23/kg, label AED 9.99 gives 0.261 kg x AED 38.26. `price_list_rate` is set to the same
   rate so no discount shows. When `offline_price_mismatch` is built, these lines should not count as mismatches.
   Pairs that land exactly half-way (6.005) are skipped because ERPNext's banker's rounding and half-up disagree.
4. **First matching rule decides**: rules are tried by priority, and the first whose prefix and length match decides;
   a wrong check digit is an error and does not fall through to the next rule.
5. **PLU lookup** tries the digits as printed, then without leading zeros (`00123` -> `123`).
6. **UOM barcode map in the scan cache**: POS Next caches an item's barcodes as one comma-joined string without their
   UOM, so a box barcode would be sold as one piece offline. `get_scan_cache` sends every barcode that has its own
   UOM, and every barcode of items with more than one barcode, and the browser checks that map first. POS Next's
   item cache was not changed.
7. **Scale labels always auto-add** (no dialog), even when POS Next's auto-add toggle is off, to meet "no keystroke".
8. **Scale lines are separate cart lines**: other cart code (offers, edit dialog) still finds lines by item + UOM;
   scale lines are read-only (POS Next's `is_resolved_barcode`), so only removal needed a line id.
9. The Scale PLU map is global (Item `scale_plu` is not per company); rules are per company.
10. The scan cache is stored in POS Next's existing `settings` store (no Dexie schema change, no version bump).

PHASE 2: DONE

## Phase 3

Run date: 2026-11-19 (unattended). Scope: SPEC section 11, Phase 3 prompt (SPEC F6), with DECISIONS.md item 5 applied.
POS Next's sales person code path (payment dialog, `sales_team` sent to `submit_invoice`) was kept and extended.

### What was built

**Backend (`pos_next/pos_0001/`)**

- `sales_person.py`: pure rules, mirrored in the browser. `resolve_mode()` combines POS Profile
  `pos0001_sales_person_mode` (Off / Optional / Mandatory, custom field from Phase 1, now with a description) with
  POS Next's POS Settings `enable_sales_persons`; `split_evenly()` (3 people: 33.34 / 33.33 / 33.33),
  `normalize_allocation()` (rounding drift up to 0.05 moves to the last row; real mistakes stay visible).
- `api/sales_person.py`:
  - `get_sales_person_cache(pos_profile)`: effective mode, multiple yes/no, the user's default sales person
    (User `pos0001_default_sales_person`, only if still enabled), and the sales person list with badge barcodes
    (`sales_person_barcode`) and commission rates. POS role and POS Profile access checked.
  - `find_by_barcode(barcode, pos_profile)`: online lookup of a badge (the till normally uses its cache).
  - Sales Invoice `before_validate` (POS invoices only): drops empty Sales Team rows, fills each row's
    `commission_rate` from the Sales Person, normalises the split. Also called inside POS Next's `update_invoice()`
    because ERPNext checks the split in `calculate_taxes_and_totals()` before hooks run.
  - Sales Invoice `validate`: when the POS Profile is set to Mandatory, an online POS sale cannot be submitted without
    a sales person. Queued offline invoices are flagged by `api/sync.py` and never rejected for this.
- Multi-person allocation reaches ERPNext's **Sales Team** table (`sales_person`, `allocated_percentage`,
  `commission_rate`; ERPNext computes `allocated_amount` and `incentives`).
- Script Report **Sales Person Commission** (module POS 0001, `report/sales_person_commission/`): filters Company,
  From / To Date (required), POS Profile, Sales Person; columns Sales Person, Invoices, Net Sales, Return Invoices,
  Returns, Net After Returns, Commission Rate (%), Commission (AED), with a total row. Built with `frappe.qb` from
  Sales Team rows of submitted Sales Invoices. Commission is the sum of ERPNext's incentives, so it matches ERPNext.
- `api/reports.py`: `sales_person_commission(from_date, to_date, pos_profile?, company?)` (SPEC section 9); cashiers
  only see POS Profiles they are on.
- Demo seed `ensure_sales_person_setup()`: badges `SP0001`..`SP0005`, cashier default **Ahmed Ali**, Main Till =
  Mandatory, Express Till = Optional (both POS Settings Multiple). `mark_demo_items_sellable()` now also sets
  `grant_commission = 1` (the import had left it 0, so no item earned commission). Both run on `pos.test`.

**Frontend (`POS/src/plus/`)**

- `core/salesPerson.js` (plain JS + JSDoc): mode, even split, normalisation, add / remove / set share (with two people
  the other gets the rest), name-or-badge matching, badge lookup, default selection, validation
  (Mandatory needs someone; a split must total 100; Mandatory with an empty list does not block the till),
  `toSalesTeam()` for the invoice.
- `salesPerson/salesPersonStore.js` (Pinia): loads the cache from IndexedDB first (works offline), refreshes from
  the server when online and every 5 minutes, holds the current cart's selection, resets to the cashier's default
  when the cart is emptied (after a sale or Clear).
- `components/SalesPersonPicker.vue`: cart header row (44 px), red when Mandatory and empty; panel with search
  (name, or scan the badge and Enter), list, selected people with % fields and "Split evenly" in Multiple mode, total
  warning. Uses logical properties (`ms`/`me`/`text-start`), numbers kept LTR.
- POS Next patches (UPSTREAM_PATCHES.md entries 17-20): hooks, `update_invoice()` call, picker in `InvoiceCart.vue`,
  payment dialog follows the store (mode, offline validation, badge search, exact split, shared selection, sales team
  on "Pay on Account" credit sales too).
- Arabic for all new strings in `pos_next/translations/ar.csv` (21 rows).

**Bugs found in POS Next on the way (fixed inside the patches above)**

1. Three sales persons in Multiple mode always failed: the dialog sent 100 / 3 each, ERPNext rounds to 99.999 and
   throws "Total allocated percentage for sales team should be 100".
2. Sales Team rows had no commission rate (ERPNext fills it only in desk JavaScript), so `incentives` were always 0.
3. "Pay on Account" (full credit sale) dropped the selected sales persons.
4. Offline, the mandatory check was skipped entirely.

### Test results

- **Python** `bench --site pos.test run-tests --module pos_next.pos_0001.tests.test_sales_person`: **20 tests, OK**.
  Mode matrix; even split totals exactly 100 for 1-12 people; drift fixed but 50 + 30 not hidden; three-way 100 / 3
  split accepted and allocated amounts add up to the commissionable amount; commission rate and incentives filled
  (60 / 40 split); a split of 80 % is stored as Failed; empty rows dropped; Mandatory blocks an online submit without
  a sales person and accepts it with one; Mandatory never rejects a queued offline invoice; Optional and Off (with POS
  Settings Multiple) accept no sales person on the server; cache for the cashier (mode, multiple, default, barcodes,
  no group nodes); disabled default not offered; Off sends no list; badge lookup; access (outsider, Guest).
  Commission report: two sales (60 / 40 and 100) plus a credit note; invoice counts, return counts, net sales, returns,
  net after returns and commission match the Sales Team rows, commission = net after returns x rate; filters (sales
  person, other profile, empty range, reversed dates); `execute()`; endpoint access for cashier and outsider.
- Regression: `pos_next.pos_0001.tests.test_sync` 13 OK, `test_barcode` 19 OK, `pos_next.test_promotions` 18 OK,
  `pos_next.api.test_credit_sales` 4 OK, `pos_next.test_packed_items_regression` 3 OK.
- **Vitest** `cd POS && yarn test:run`: **81 tests, 6 files, all pass** (21 new in `salesPerson.test.js`).
- **Playwright** `cd POS && yarn e2e`: **5 tests pass**, and passed twice in a row with `--repeat-each=2`.
  New `e2e/sales-person.spec.js`:
  1. Main Till (Mandatory, Multiple): the header shows the cashier's default (Ahmed Ali); network off; with nobody
     selected the header is red and the payment dialog says "Sales person is required" and keeps Complete Payment
     disabled even when paid in full; badge `SP0002` + Enter and "omar" + Enter select two people at 50 / 50; setting
     70 gives 30 to the other; the dialog opens with that selection; the sale completes offline and the queued
     invoice carries `[Fatima Hassan 70, Omar Khalid 30]`; the next cart is back to Ahmed Ali; back online the invoice
     syncs and the server's Sales Team has 70 / 30 with commission rates 1.5 / 2 and incentives above 0. No unexpected
     console errors.
  2. RTL: picker button and options are at least 44 px high and the panel has no horizontal overflow.
- `bench --site pos.test migrate`, `bench build --app pos_next`: OK. `biome check` clean on `src/plus` and `e2e`.
- Note: the Python run deletes every Item Price (ERPNext `before_tests`, see Phase 2); demo prices were rebuilt with
  `seed.ensure_item_prices` before the e2e run.
- **Flaky upstream startup (found while running e2e):** POS Next fetches a fresh CSRF token at startup while its first
  API calls are in flight; now and then `get_app_translations`, `check_opening_shift` or `get_user_language` get a
  400 `CSRFTokenError`. The till recovers. The e2e specs now ignore only 400s whose body is `CSRFTokenError` and still
  fail on any other 400. Not fixed (POS Next code, `src/utils/csrf.js` / `main.js`).

### Manual checks (need real hardware or a person)

- [ ] Mandatory sales person blocks payment until chosen on a real till; commission report matches (SPEC acceptance).
- [ ] Print badge barcodes (`sales_person_barcode`) and scan them with a real HID scanner into the cart header picker
      and into the payment dialog search.
- [ ] Desk: set the mode on a POS Profile (read the field description), a default sales person on a User, a badge on a
      Sales Person; open the Sales Person Commission report, check the filters, totals and the AED figures against
      ERPNext's own "Sales Person Commission Summary" on real data.
- [ ] Switch the POS to Arabic and look at the picker, the panel and the payment dialog message; only `dir="rtl"` was
      simulated automatically.
- [ ] Tablet / 1024x768: the cart header with customer and sales person rows still leaves room for the cart.

### Not done in this phase (later phases)

- F6 shortcut for the sales person picker and the `?` overlay (Phase 6 shortcut map).
- Held carts do not keep the sales person selection yet (server-side held carts are Phase 6).
- Scanning a badge in the item search box (it works in the picker and the payment dialog search).

### Decisions to review

1. **Meaning of "Off".** Optional and Mandatory on the POS Profile decide. Off keeps POS Next's behaviour, so existing
   profiles do not change on upgrade: POS Settings "Enable Sales Persons" Disabled = no picker, Single or Multiple =
   mandatory. To switch sales persons off completely, set POS Settings to Disabled. Several sales persons per sale
   only when POS Settings says Multiple. This is written in the field's description.
2. **Server check only for an explicit Mandatory** on the POS Profile, and only for online sales. Off + enabled stays a
   till-only rule (as in POS Next), and a queued offline invoice is never rejected for a missing sales person (it
   would be stored as Failed with no way to add one). This adds a check to POS Next's invoice behaviour (asked for in
   CLAUDE.md "ask before"); the safest form was chosen.
3. **Mandatory now also holds offline** (POS Next skipped it), because the list is cached. If the cached list is empty
   the till does not block the sale.
4. **Patch in POS Next's `update_invoice()`** (entry 18) to tidy the Sales Team before totals. It touches commission
   data only, not GL, stock or tax. Can be offered upstream with the 100 / 3 fix.
5. **Commission rate is copied from the Sales Person when the invoice is saved** (only when the row has none).
   The report's Commission is the sum of ERPNext's incentives, so it uses the rate at the time of sale; the
   Commission Rate column shows today's rate.
6. **Report scope:** all submitted Sales Invoices (POS or not) unless a POS Profile is chosen; credit notes count in
   the period of their own posting date; amounts are ERPNext's commissionable net amount (without VAT, only items with
   "Grant Commission"). The report is for Sales Manager, Accounts Manager, System Manager and Nexus POS Manager; the
   POS endpoint lets cashiers see their own profiles. Frappe's total row also adds up the Commission Rate column.
7. **Split rounding:** shares have 2 decimals; drift up to 0.05 % is moved to the last row on the server; bigger
   errors are left for ERPNext to reject (an offline invoice is then stored as Failed).
8. **New cart = default sales person** whenever the cart goes from having items to empty (after a sale, Clear, or
   removing the last line by hand).
9. **Demo data:** Main Till is now Mandatory and Express Till Optional; demo items got `grant_commission = 1`.
10. **e2e console filter** for the upstream CSRF startup race (see Test results). Consider fixing it in POS Next
    (retry once on `CSRFTokenError`, as it already does on 401/403).

PHASE 3: DONE

## Phase 4

Run date: 2026-11-19 (unattended). Scope: SPEC section 11, Phase 4 prompt (SPEC F9 receipt printing), with
DECISIONS.md item 7 applied: POS Next's QZ connection and signing (key files in `sites/<site>/private/qz/`) are
reused; no key fields were added anywhere.

### What was built

**Backend (`pos_next/pos_0001/`)**

- Doctype **POS Printer Profile** (named by `printer_name`): purpose Receipt / Label, company, connection
  (QZ Local Printer with optional QZ printer name, or Network host + port), print mode
  (`raster` / `escpos_text` / `qz_html` / `browser`), paper width 80 / 58 mm, DPI, characters per line, auto cut,
  copies (1-3, validated), drawer kick, receipt barcode (Code128 / QR / None), print format (for `qz_html`),
  label language (for Phase 5). Validation: copies, host / port, characters per line, `qz_html` needs a local
  printer. Cashiers read, managers edit.
- Doctype **POS Drawer Event**: No Sale openings (event id from the till, unique; user, time, POS Profile, device,
  opening shift, offline flag, reason, `permitted`). Read-only, managers read.
- **POS Device** gets `receipt_printer` and `label_printer` (our own doctype). POS Profile custom fields
  `pos0001_receipt_printer` (default for its tills) and `pos0001_no_sale_role`.
- `api/printing.py` (POS role + POS Profile access on every endpoint):
  - `get_printing_cache(pos_profile, device_id)`: receipt printer (device first, then profile), label printer,
    company name / address / TRN / phone, footer, logo URL, print format, cash modes (Mode of Payment type Cash plus
    POS Next's cash mode field), `can_no_sale`, cashier name.
  - `get_receipt_data(invoice)`: receipt JSON of a Sales Invoice for reprints and online sales (items with
    `item_name_ar`, taxes, rounding, payments with mode type, sales team, offline id).
  - `log_drawer_events(events)`: idempotent per event id; an event is never refused for a missing role (the drawer
    already opened), it is stored with `permitted = 0`.
  - `sync.register_device` now returns the till's printer profiles (SPEC section 9).
- Demo seed `ensure_printing_setup()`: printer profiles "Receipt 80mm Raster" and "Receipt 58mm Text" (not assigned,
  so the demo tills keep POS Next printing), role **POS No Sale** given to the cashier and set on both profiles.

**Frontend, pure logic (`POS/src/plus/core/`, plain JS + JSDoc, no Vue)**

- `escpos.js`: ESC/POS byte builder (init, align, bold, size, text, feed, cut `GS V`, drawer `ESC p 0 25 250`,
  native Code128 `GS k 73`, native QR `GS ( k`, raster `GS v 0` in bands), copies, base64 for QZ. Text helpers
  adapted from POS Awesome (credited in the file header and NOTICE.md).
- `raster.js`: RGBA to 1-bit (threshold or Floyd-Steinberg), bottom trim, full raster job (drawer on the first copy
  only, cut per copy).
- `code128.js`: Code128 (set B with set C for digit runs). `qr.js`: QR encoder, byte mode, level M, versions 1-10;
  matrices match `pyqrcode` (fixture `qr.reference.json`, generated by `pos_0001/tests/qr_reference.py`).
- `receipt.js`: one receipt model from a server, offline or reprint invoice; `escpos_text` receipt; draw operations
  for raster; barcode choice (Code128 when it fits at 2 dots per module, else QR); `planPrint` (no printer profile =
  POS Next printing; QZ modes fall back to the browser when QZ is down); `shouldKickDrawer` (sale with a cash
  payment only, never reprints).

**Frontend, till (`POS/src/plus/`)**

- `printing/qz.js`: raw jobs through POS Next's QZ connection (`utils/qzTray.js`), local printer or `{host, port}`.
- `printing/raster.worker.js` + `rasterRender.js` + `receiptPainter.js`: the receipt is painted on an OffscreenCanvas
  in a Web Worker (the browser's text engine shapes Arabic) and converted to 1-bit there; `rasterClient.js` falls
  back to the main thread if the worker is not available.
- `printing/printingStore.js`: printing cache in IndexedDB (logo kept as a data URL, works offline), the four modes,
  browser fallback, drawer kick, copies, auto cut, F9 reprint of the last receipt (stored per profile, marked
  REPRINT, no drawer), test print, No Sale with an offline event queue uploaded on reconnect. Offline receipts get
  the sale time, the till currency and the sales team from the queued invoice.
- `components/PrinterBadge.vue`: header printer badge, red when the mode needs QZ Tray and it is not connected;
  panel with Reprint last receipt (F9), Test print, Connect QZ Tray, No Sale (with reason; only when permitted).
- POS Next patches (UPSTREAM_PATCHES.md entries 21-23): header badge; `handlePrintInvoice()` routes to the printing
  store when the till has a printer profile and gets `reason: "sale"` from the two auto-print calls; auto-print
  after payment also when a printer profile is set; optional printer name on POS Next's silent print helpers.
- Arabic for all new strings in `pos_next/translations/ar.csv` (74 rows; 6 already existed).
- Docs: `docs/HARDWARE.md` (QZ Tray install, certificate steps with `override.crt`, printer profiles, modes, drawer,
  No Sale, troubleshooting, hardware matrix), `NOTICE.md`, ARCHITECTURE_NOTES "After Phase 4".

### Test results

- **Python** `bench --site pos.test run-tests --module pos_next.pos_0001.tests.test_printing`: **14 tests, OK**.
  Printer profile validation (copies 1-3, network host / port, characters per line, disabled profile ignored);
  printing cache: profile printer, POS Device override, `register_device` returns printers, no printer = POS Next
  printing, cash modes, company, footer; No Sale permission (empty role = managers only, role on profile, role on
  user); access (outsider, Guest); receipt data of a synced offline invoice (offline id, items, VAT, payments with
  mode type), outsider refused, missing invoice; drawer events stored once per event id with user, device, offline
  flag and reason, stored as not permitted without the role, bad input and other profiles refused.
- Regression: `test_sync` 13 OK, `test_barcode` 19 OK, `test_sales_person` 20 OK, `pos_next.test_promotions` 18 OK,
  `pos_next.api.test_credit_sales` 4 OK, `pos_next.test_packed_items_regression` 3 OK. Whole-app `run-tests` still
  does not start on v15 (Phase 1 decision 8).
- **Vitest** `cd POS && yarn test:run`: **124 tests, 11 files, all pass** (43 new in `escpos`, `code128`, `qr`,
  `raster`, `receipt`). Byte snapshots in `src/plus/core/__snapshots__/`: an 80 mm cash receipt in `escpos_text`
  (drawer, Code128, cut), a 58 mm offline receipt (QR, no cut), and the raster job of a fixed 10 x 4 receipt
  (drawer, two copies). Raster conversion of a fixed receipt is checked bit by bit.
- **Playwright** `cd POS && yarn e2e`: **8 tests pass** (3 new in `e2e/receipt-printing.spec.js`). A fake QZ Tray
  answers on QZ's WebSocket port (`routeWebSocket`) and records the raw jobs:
  1. Online cash sale: one raw job to "Fake Receipt" that starts with `ESC @`, the drawer kick and `GS v 0` with 72
     bytes per row, ends with feed + `GS V`, and is sent within 5 s of Complete Payment. The decoded raster has over
     400 rows with 2-40 % ink and is saved as `test-results/receipt-raster-online.png` (checked by eye: header,
     line, VAT, rounding, total, Code128). F9 reprints without a drawer kick. An offline cash sale prints from the
     local invoice (`receipt-raster-offline.png`: OFFLINE - PENDING SYNC, sales person, AED total, change, QR of the
     offline id). No Sale while offline sends exactly `1b 70 00 19 fa`; back online the POS Drawer Event is on the
     server with the user, `permitted = 1`, `was_offline = 1`. No unexpected console errors.
  2. No QZ Tray: badge `data-status="down"` (red), the sale prints through a browser window.
  3. RTL: badge 44 x 44 px inside the viewport, panel without horizontal overflow, buttons at least 44 px high.
- `bench --site pos.test migrate`, `bench build --app pos_next` (worker bundled as `raster.worker-*.js`): OK.
  `biome check` clean on `src/plus` and `e2e`.
- After the Python runs, demo prices were rebuilt with `seed.ensure_item_prices` (ERPNext `before_tests`, see Phase 2).

### Manual checks (need real hardware or a person)

- [ ] Install QZ Tray on a real till, generate and download the certificate, copy it as `override.crt`, restart QZ
      Tray: the first print shows no Allow / Block dialog (HARDWARE.md section 2). The `override.crt` folders are
      QZ Tray 2.2 defaults; confirm with the QZ documentation of the installed version.
- [ ] Receipt prints Arabic correctly in raster mode on the client's printer (Epson TM-T20/T82, Xprinter XP-80),
      80 mm and 58 mm; logo prints; auto cut works; copies 2 and 3.
- [ ] `escpos_text` mode on the same printers (font A, 48 / 32 columns); native Code128 and QR print and scan.
- [ ] Network printer (LAN, port 9100) through QZ Tray in raster and escpos_text mode.
- [ ] Drawer opens on cash sales only, not on card sales or reprints; No Sale opens it and the event appears in
      POS Drawer Event (desk) with the right user and shift.
- [ ] Pay to receipt starts printing in under 1 s on a real till (SPEC section 6). The e2e check allows 5 s with a
      fake printer and includes a server round trip for online sales (`get_receipt_data`).
- [ ] Scan the receipt barcode (Code128 of the invoice number) with a real scanner; scan the QR of an offline receipt.
- [ ] Stop QZ Tray mid-shift: badge turns red and receipts print through the browser; start QZ Tray, press Connect.
- [ ] Reprint from Invoice History (online) and from the offline invoices list.
- [ ] `qz_html` mode with the POS Profile's print format through QZ Tray.
- [ ] Switch the POS to Arabic and look at the printer badge and panel; only `dir="rtl"` was simulated.
- [ ] Desk: POS Printer Profile form (depends-on fields, descriptions) and the POS Device / POS Profile printer fields.

### Not done in this phase (later phases)

- Bilingual UAE tax invoice layout, `item_name_ar` on offline receipts (not in POS Next's item cache), configurable
  title (Phase 7). The receipt model and raster painter already carry an Arabic name per line.
- Label printers (Phase 5); the `label_printer` and `label_language` fields exist.
- F9 lives in the printing store for now; the full shortcut map and `?` overlay are Phase 6.
- Return lookup by scanning an offline receipt's QR (it holds the offline id, not the final invoice name).

### Decisions to review

1. **No printer profile = POS Next printing unchanged.** pos_0001 printing (and its auto-print after payment) runs
   only when the till's POS Device or its POS Profile has a POS Printer Profile, so existing tills behave as before
   after the upgrade. The demo profiles have none assigned.
2. **Auto-print after payment is on whenever a printer profile is set**, even if POS Profile "Print Receipt on Order
   Complete" is off (SPEC: "prints automatically within 1 second of payment").
3. **Raster rendering draws the receipt model, not arbitrary HTML.** A Web Worker has no DOM and cannot render HTML,
   so the worker paints layout operations (text, pairs, rules, logo, barcode) on an OffscreenCanvas; the browser's
   text engine shapes Arabic. `qz_html` stays the mode for printing an ERPNext Print Format.
4. **Own QR encoder** (`plus/core/qr.js`, about 350 lines) instead of a new npm dependency (CLAUDE.md: ask before
   adding one). Verified against `pyqrcode`, already a Frappe dependency, for four values.
5. **Receipt barcode:** Code128 of the invoice name when it fits at 2 dots per module (server names do), otherwise
   QR. Offline receipts therefore carry a QR of the offline id; the return dialog does not find invoices by offline
   id yet.
6. **New doctype POS Drawer Event** (not in SPEC section 8) to log No Sale, because the spec asks for "logged" and
   the log must survive offline. No Sale permission is a role chosen on the POS Profile (`pos0001_no_sale_role`);
   empty means POS managers only. Offline, the till trusts its cached permission; the server stores the event anyway
   and marks it `permitted = 0` if the role was removed meanwhile.
7. **Drawer opens on cash payments only** (Mode of Payment type Cash, or POS Next's cash mode on the profile),
   including cash refunds. In `browser` mode it opens only if QZ Tray happens to be connected; otherwise the cashier
   sees a warning.
8. **Online sales print from `get_receipt_data`** (one server call after submit) so the receipt shows ERPNext's final
   VAT and rounding. Offline sales print from the local invoice. If that call fails the print fails with a message;
   it never prints stale data.
9. **Printer target:** the profile's QZ printer name, else the printer chosen in POS Next's POS Settings on that till.
   Network printers use QZ Tray's raw socket (`{host, port}`); `qz_html` is refused for network printers.
10. **Drawer pulse fixed at `ESC p 0 25 250`** (pin 2, SPEC). Pin 5 drawers are not configurable yet.
11. **POS Next silent-print helpers got an optional printer name** (UPSTREAM_PATCHES entry 23), the smallest change
    that lets `qz_html` use the profile's printer.
12. Receipt texts ("Tax Invoice", labels) are English with Arabic translations through `__()`; the bilingual UAE
    layout is Phase 7.
13. The e2e test mocks QZ Tray's WebSocket. It proves the bytes and the flow, not the printer; real-printer checks
    are under Manual checks.

PHASE 4: DONE

## Phase 5

Run date: 2026-11-19 (unattended). Scope: SPEC section 11, Phase 5 prompt (SPEC F4 barcode label printing). POS
Awesome was read as a reference only (`useZplGenerator.ts`, `useBarcodePrintOutput.ts`, `BarcodePrinting.vue`,
`label_data_sources.py`); nothing was added as a dependency and no Vuetify code was copied.

### What was built

**Pure logic (`POS/src/plus/core/`, plain JS + JSDoc, no Vue), mirrored in Python**

- `zpl.js`, `epl.js`, `tspl.js`: escaping, barcode fields (ZPL `^BY`/`^BCN`/`^BEN`, EPL `B` with `1` / `E30`, TSPL
  `BARCODE "128"` / `"EAN13"`) and bitmap commands for Arabic (ZPL `^GFA` hex with 1 = black, EPL `GW` and TSPL
  `BITMAP` binary with 0 = black). ZPL and EPL parts adapted from POS Awesome (credited in file headers and NOTICE.md);
  POS Awesome has no TSPL builder, so `tspl.js` is written from the TSPL manual.
- `labelTemplate.js`: renderer for the template body, a Jinja subset (values, `draw_barcode()`, `draw_arabic()`,
  `fit()`, `if / elif / else / not`) with Jinja's whitespace rules (`trim_blocks`, `lstrip_blocks`, trailing newline).
  Anything else is rejected with a plain message, on the server too, so the POS prints exactly what the server would.
- `labels.js`: label rows from the browser cache (that UOM's barcode, price incl. VAT, item VAT overrides, price
  override, scale labels with `generateScaleBarcode` from POS Scale Barcode Rule), raw jobs with copies (`{{ qty }}` or
  repeated labels), and the A4 sheet HTML (grid centred on the page, SVG barcodes, Arabic as text).
- `ean.js` / `code128.js`: EAN-13 and Code128 module strings for the A4 sheet.
- Python copies: `pos_0001/labels.py` (Jinja sandbox renderer, commands, A4 HTML, Arabic bitmap with Pillow + libraqm)
  and `pos_0001/barcodes.py`. One byte snapshot, `pos_0001/tests/label_snapshots.json` (29 cases: every default
  template plus 24 whitespace / helper cases in three languages), is checked by Vitest and by the Python tests.

**Backend (`pos_next/pos_0001/`)**

- Doctype **POS Label Template**: name, language ZPL / EPL / TSPL / PDF, enabled, default per language, company,
  width / height mm, DPI 203 / 300, gap, barcode type Code128 / EAN13, A4 columns / rows / label margin, Jinja body
  with help text. Validation renders a sample label, so a broken body cannot be saved.
- Five default templates (`default_label_templates.json`): Shelf Label 38x25 (ZPL), Product Label 50x30 (ZPL),
  A4 Sheet 3x8 (PDF) as asked, plus Product Label 50x30 in TSPL and EPL. Created on install and migrate when missing
  (`pos_0001/install.py`), never overwritten.
- POS Profile custom fields: `pos0001_label_printer`, `pos0001_default_label_template`, `pos0001_label_role`. The
  till's label printer is POS Device `label_printer`, else the profile's (`printing.resolve_printers`).
- `api/labels.py` (POS role, profile access and the Print Labels role on every endpoint): `get_label_cache`,
  `get_label_profiles`, `resolve_rows`, `search_items`, `items_from_document` (Purchase Receipt; Stock Entry lines with a
  target warehouse; label qty = received qty rounded up; the user must be able to read the document), `render` (raw job
  as base64, or a private PDF File). Scale labels reuse `barcode.generate_scale_barcode` logic and the rules of the
  profile.
- Desk page **pos-labels** (shows `/pos/labels` in an iframe) and a **Print Labels** button on Purchase Receipt and
  Stock Entry (`client/print_labels_button.js`).
- Demo seed `ensure_label_setup()`: printer "Label Printer ZPL" on Main Till, role **POS Label Printer** for the cashier
  on both profiles, Arabic names on ITM-00001, ITM-00002, PLU-12345 (run on `pos.test`).

**Frontend (`POS/src/plus/`)**

- `labels/labelStore.js`: label cache in IndexedDB (`pos0001_label_cache::<profile>`), rows resolved on the server when
  online and from the item / scan caches offline, item search (server, or Dexie barcode / code / name offline), print
  (raw through QZ Tray to the label printer, checking the printer's label language; A4 through the browser print
  dialog), server PDF download.
- `labels/textBitmap.js`: Arabic text drawn right to left on a canvas, shrunk to fit, 1-bit.
- `components/LabelPrintPanel.vue` (Tailwind): template, output status, search / scan, rows with UOM, label quantity,
  price override, scale label (rule + weight or amount), remove, total, Print / Download PDF. 44 px targets, logical
  properties, numbers LTR. `components/LabelButton.vue`: header button, dialog pre-filled with the cart lines.
  `pages/LabelsPage.vue`: `/pos/labels` with profile choice and document rows (`?doctype=&name=`).
- POS Next patches (UPSTREAM_PATCHES.md entries 24-27): hooks (`doctype_js`, `after_install` / `after_migrate` lists),
  one route, one header button.
- Arabic for all new strings in `pos_next/translations/ar.csv` (78 rows; 13 already existed).
- Docs: HARDWARE.md section 8 (label printers, templates, where to print), test matrix and troubleshooting rows,
  NOTICE.md, ARCHITECTURE_NOTES "After Phase 5".

### Test results

- **Python** `bench --site pos.test run-tests --module pos_next.pos_0001.tests.test_labels`: **21 tests, OK**.
  Shared snapshots (all 29 cases equal to the browser), ZPL text, subset errors, EAN-13 / Code128 modules, bitmap
  commands, Arabic bitmap with Pillow + libraqm (shaped, shrunk to fit); default templates shipped, bad bodies and
  sizes refused, one default per language; rows: price incl. VAT per UOM with that UOM's barcode, Arabic name, price
  override, scale labels give the SPEC F5 barcodes (2012345012509, 2212345025008), item without a scale code refused;
  search by barcode (with UOM) and name; cache; access (no role, outsider, Guest, profile list); Purchase Receipt rows
  (Box UOM barcode, 2.4 kg -> 3 labels) and Stock Entry rows (received lines only; cashier without Stock Entry read is
  refused); render TSPL (bytes, Arabic `BITMAP`) and A4 PDF (private file, 25 labels = 2 pages); bad input refused.
- Regression: `test_printing` 14 OK (one assertion updated: `register_device` now also returns the profile's label
  printer), `test_sync` 13 OK, `test_barcode` 19 OK, `test_sales_person` 20 OK, `pos_next.test_promotions` 18 OK,
  `pos_next.api.test_credit_sales` 4 OK, `pos_next.test_packed_items_regression` 3 OK. Whole-app `run-tests` still does
  not start on v15 (Phase 1 decision 8).
- **Vitest** `cd POS && yarn test:run`: **146 tests, 12 files, all pass** (22 new in `labels.test.js`).
- **Playwright** `cd POS && yarn e2e`: **11 tests pass** (3 new in `e2e/label-printing.spec.js`, fake QZ Tray):
  1. Till, network off: Labels button, barcode 6290000000016 + Enter adds the item from the browser cache with its
     Arabic name, 3 labels; PLU-12345 as a scale label of 1.250 kg shows 2012345012509; Print sends one base64 job to
     "Fake Label": ZPL with `^PW304 ^LL200`, `^BEN ... ^FD629000000001`, `^PQ3`, the scale label's
     `^FD201234501250`, two `^XA`, and a `^GFA` bitmap of the Arabic name (24 rows, saved as
     `test-results/label-arabic.png`, checked by eye: correctly joined Arabic). No unexpected console errors.
  2. Desk: a Purchase Receipt for 5 x ITM-00001, Print Labels opens `/app/pos-labels` with one row of 5 labels and the
     source line; A4 template + Download PDF returns a PDF of 5 labels (`test-results/labels-a4.pdf`).
  3. RTL: Labels button 44 x 44 inside the viewport, dialog without horizontal overflow, controls 44 px high.
- The A4 PDF was also rendered to PNG on the server and checked by eye (24 labels on the 70 x 37 grid, SVG barcodes,
  Arabic name, scale label with weight).
- `bench --site pos.test migrate`, `bench build --app pos_next`: OK. `biome check` clean on `src/plus` and `e2e`.
- After the Python runs, demo prices were rebuilt with `seed.ensure_item_prices` (ERPNext `before_tests`, see Phase 2).

### Manual checks (need real hardware or a person)

- [ ] Print 20 labels from a Purchase Receipt on the client's label printer and on an A4 sheet; scan every barcode
      back with a real scanner (SPEC acceptance). Check EAN-13 and Code128 at 2 dots per module on 203 dpi.
- [ ] Zebra (ZPL): Shelf Label 38x25 and Product Label 50x30 on 203 dpi; `^CI28` UTF-8 text; the Arabic `^GFA`
      bitmap prints black on white and is readable.
- [ ] TSC / Xprinter (TSPL) and an EPL printer: Arabic `BITMAP` / `GW` bitmaps are sent with 0 = black (from the
      manuals); confirm they are not inverted. Confirm `CODEPAGE UTF-8` on the TSC model.
- [ ] Gap and size calibration on real rolls (38 x 25, 50 x 30); 300 dpi printers need 300 dpi copies of the
      templates (positions are in dots).
- [ ] A4 3 x 8 sheet (70 x 37 mm, e.g. Avery 3474-type) from the browser at 100 % and from Download PDF: labels sit
      inside the die-cut grid.
- [ ] Scale label for goods packed in store: print one, scan it at the till, qty and amount match (weight and price
      rules).
- [ ] Network label printer through QZ Tray (raw port 9100).
- [ ] Desk: POS Label Template form (help text, depends-on fields, error messages for a broken body) in English and
      Arabic; Print Labels button on a submitted Purchase Receipt and on a Stock Entry.
- [ ] Switch the POS to Arabic and look at the label dialog; only `dir="rtl"` was simulated automatically.

### Not done in this phase (later phases or not in the Phase 5 prompt)

- A visual label designer (POS Awesome has one); templates are edited as Jinja text.
- RFID / EPC encoding, Sales Order / Delivery Note / BOM sources, serial number labels (POS Awesome extras, not in SPEC).
- Arabic currency sign "د.إ" on labels per language setting (Phase 7 AED formatting).
- POS Next's item cache has no `item_name_ar`; offline labels take Arabic names from the label cache (Phase 7 adds it
  to search and receipts).

### Decisions to review

1. **Template body is a Jinja subset**, not full Jinja: the POS must render labels offline in the browser, where there
   is no Jinja. Values, three helpers and `if` blocks only; enforced on save. Both renderers are proven equal by one
   shared byte snapshot. A full Jinja body would need the server for every label.
2. **Five default templates instead of three**: the three asked for plus TSPL and EPL copies of the 50 x 30 product
   label, so every label language has a working default. They are created on install and every migrate when missing
   (`after_install` / `after_migrate` in hooks.py, UPSTREAM_PATCHES 25); a deleted default comes back on the next
   migrate, so disable it instead of deleting it.
3. **A4 PDF uses WeasyPrint, not wkhtmltopdf.** The bench's wkhtmltopdf 0.12.6 is built without patched Qt and
   scaled the A4 page to about 77 %, which would move labels off the sheet's grid. WeasyPrint is already a Frappe v15
   dependency (`WeasyPrint==70.0`), so no new package. Check it is present on v16.
4. **Grid layout**: the A4 grid is centred on the sheet and `margins_mm` is the space kept free inside each label
   (field label "Label Margin"), because one margin value cannot describe both page margins of real label sheets.
   Default 70 x 37 mm, 3 x 8.
5. **Label printing permission**: POS role + access to the POS Profile + the profile's **Print Labels Role**; empty
   role = POS managers only (same rule as No Sale). Desk users printing from a Purchase Receipt also need read access
   to the document and a POS Profile of its company. Demo: role "POS Label Printer" for the cashier.
6. **"POS item menu" entry point**: POS Next has no per-item menu, so the till entry point is a **Labels** button in
   the header that opens the dialog pre-filled with the cart lines (scale lines left out). One header patch.
7. **Desk page shows the POS label screen in an iframe** (`/pos/labels`) instead of a second UI in desk JavaScript:
   one Tailwind UI, and raw jobs go through QZ Tray from the browser like on the till (the server cannot reach a
   till's printer). `labels.render` still renders raw jobs and PDFs on the server (API and Download PDF).
8. **Prices on labels include VAT**: rate of the price list for that UOM (else stock UOM price x conversion factor),
   plus the POS Profile tax template's "On Net Total" rate, or the item's own Item Tax Template rate for those
   accounts; unchanged when the template says "included in print rate". Item Group tax templates are not looked at.
9. **Scale labels**: for Weight rules the label price is the line amount (weight x rate, 2 decimals) plus VAT; for
   Price rules the entered amount is the encoded line amount (what the till will charge before VAT) and the label
   shows it plus VAT when prices exclude VAT. Scale labels always print as EAN-13.
10. **Barcode choice**: the UOM's own barcode, else (stock UOM) a barcode without a UOM, else the item code as Code128.
    EAN-13 only for valid 13-digit codes; 12-digit UPC-A codes print as Code128.
11. **Label quantity from documents** = received qty in the line's UOM rounded up (2.4 kg -> 3 labels), capped at 999.
12. **Limits**: 500 rows, 999 labels per row, 2000 labels per print.
13. **Server PDFs are private File records** named `labels-<hash>.pdf` and are not cleaned up automatically.
14. **Label cache carries all Arabic item names** (item code -> `item_name_ar`, only items that have one) so offline
    labels show them; large catalogues with Arabic names make this cache bigger.
15. **Bitmap polarity** for EPL `GW` and TSPL `BITMAP` (0 = black) is from the manuals and not verified on hardware.
16. `register_device` (Phase 1) now returns the profile's label printer too; the Phase 4 test was updated.

PHASE 5: DONE

## Phase 6 (first run)

Run date: 2026-11-19 (unattended). Scope: SPEC section 11, Phase 6 prompt (SPEC section 6, F7), with DECISIONS.md
item 6 applied. The 20,000-item demo catalogue from `pos_next/pos_0001/demo/seed.py` was already on `pos.test`
(20,000 `ITM-` items + 50 weighed items), so the seed was not run again.

### What was built

**Held carts on the server (F7, DECISIONS item 6)**

- A held cart is a **draft Sales Invoice** (`pos0001_held = 1`), built by POS Next's own `update_invoice()` from the
  till's draft payload. Payments, opening shift and `offline_id` are removed first. New custom fields on Sales Invoice
  (collapsed "Held Cart (POS)" section): `pos0001_held`, `pos0001_hold_id` (unique), `pos0001_held_at`,
  `pos0001_held_by`, `pos0001_hold_note`, `pos0001_held_cart` (the exact cart as JSON: lines, offers, sales persons).
- `pos_0001/api/held_carts.py` (POS role + POS Profile access on every endpoint): `hold_cart` (idempotent per hold id;
  returns `Failed` with ERPNext's reason instead of raising), `list_held_carts` (time, customer, total, cashier, till,
  note, lines), `resume_held_cart` (row lock; returns the cart and deletes the draft in the same transaction, so two
  tills cannot resume one cart), `delete_held_cart`, and the daily `cleanup_held_carts` for drafts older than
  `held_cart_retention_days` (POS 0001 Settings, default 3; 0 = keep).
- A held draft is **named by its hold id** (`HOLD-<uuid>`, Sales Invoice `before_insert` hook), so held carts never use
  a number of the invoice naming series. A late re-upload of a cart that was already resumed answers `Resumed` (its
  Deleted Document exists) and is not created again.
- Till: **Hold** (button or F8 / Ctrl+S) asks for an optional note. The cart is always saved in the browser first
  (POS Next's `pos_next_drafts` database). It is removed there only when the server confirms it holds the cart.
  Offline, or when the server refuses the cart, it stays local ("On this till" / "Not uploaded" with the reason) and
  is uploaded on reconnect. **Held Carts** (replaces POS Next's Draft Invoices dialog) lists server and local carts,
  newest first, and can resume or delete them. Resuming restores the lines, customer, offers and sales persons. POS
  Next drafts saved before this phase are given a hold id and uploaded like the others.

**Performance (SPEC section 6, details and numbers in `docs/PERFORMANCE.md`)**

- Benchmark `POS/perf/benchmark.spec.js` (`yarn perf`) measures every target in the section 6 table.
- **Search index** (`plus/core/searchIndex.js`) with lowercased name, code, barcodes and Arabic name (Arabic letter
  forms folded). It is built in a **Web Worker** (`plus/search/searchIndex.worker.js`), stored in its own IndexedDB
  database `pos0001_search`, and searched in memory. The first results come without POS Next's debounce.
- **Virtual scrolling** for the item grid and list (`plus/core/virtualGrid.js`, `plus/perf/useVirtualGrid.js`).
- **Favourites grid**: top 30 sellers of the POS Profile (`pos_0001.api.favourites.get_favourites`, cached offline),
  one-tap buttons above the grid while the search box is empty.
- **Global scanner capture** (`plus/core/scannerCapture.js`, `plus/scan/globalScanner.js`): scans work with no field
  focused, using the 30 ms inter-key rule.
- **Faster reopen**: the cached catalogue shows at once, and the server refresh runs afterwards only when the cache
  is older than `cache_refresh_minutes`. POS Next's `getCacheStats()` counts hidden items through indexes.
- **Progress bar** for the first full cache.
- **Keyboard shortcuts** (`plus/core/shortcuts.js`, `plus/shortcuts/useShortcuts.js`) and the **`?` overlay**
  (`plus/components/ShortcutsOverlay.vue`): F2, F3, F4, F6, F8, F9 (Phase 4), Ctrl+S, Esc, Del, +, -.
- POS Next patches: UPSTREAM_PATCHES.md entries 28-36. Arabic for all new strings in `pos_next/translations/ar.csv`
  (59 new rows). Docs: `docs/PERFORMANCE.md`, HARDWARE.md section 9 (scanners), ARCHITECTURE_NOTES "After Phase 6".

### Test results

- **Python** (`bench --site pos.test run-tests --module ...`): new `pos_0001.tests.test_held_carts` **11 OK**. It covers:
  a held draft has no shift, payments or offline id and is named by its hold id; the same hold id twice gives one
  draft; resume on another till returns the exact cart and claims it, a second resume is refused, and a late
  re-upload answers Resumed; resume by hold id; other profile, outsider and Guest refused; a refused draft is reported,
  not raised; bad input; delete; offline hold time kept (future times clamped); retention cleanup (0 = keep).
  New `test_favourites` **3 OK** (top sellers by quantity, limit, per profile, access).
  Regression: `test_sync` 13 OK, `test_barcode` 19 OK, `test_sales_person` 20 OK, `test_printing` 14 OK, `test_labels`
  21 OK, `pos_next.test_promotions` 18 OK, `pos_next.api.test_credit_sales` 4 OK, `pos_next.test_packed_items_regression`
  3 OK. Whole-app `run-tests` still does not start on v15 (Phase 1 decision 8).
- **Vitest** `cd POS && yarn test:run`: **186 tests, 17 files, all pass**. 40 new tests in `heldCarts`, `searchIndex`
  (including 20,000 rows searched in well under the target), `virtualGrid`, `shortcuts` (with scanner capture), and
  `cacheFreshness`.
- **Playwright** `cd POS && yarn e2e`: **15 tests pass** (5.0 min). New tests:
  - `e2e/held-carts.spec.js`: two browser contexts (till 1, till 2) on Main Till. Hold with a note on till 1. The
    server has a `HOLD-` draft with the item, quantity and cashier. Till 2 lists it as a server cart and resumes it
    (cart restored, server copy gone). Till 1's list no longer shows it. Till 1 offline: the hold shows "On this till"
    and is on the server after reconnect. RTL check of the dialog.
  - `e2e/till-speed.spec.js`: scan with nothing focused adds the item; slow typing is not a scan; `+`, `-` and Del
    change or remove the last line; `?` shows 12 shortcuts, and Esc closes the list; F2 focuses search; "Dates 1kg"
    finds items at once; a long result list renders fewer than 120 rows; F8 opens Hold; F4 opens Payment. Favourites
    grid: a tap adds the item; 44 px targets; no overflow in RTL (grid and overlay).
- **Benchmark** (`yarn perf`, dev bench, 20,000 items). Before -> after:

  | Target | Before | After |
  | --- | --- | --- |
  | Search first results < 100 ms | ~1,100 ms (one search found nothing) | **32 ms** |
  | Scan to cart < 150 ms | 613 ms | **24 ms** |
  | Scale scan to cart < 150 ms | 213 ms | **27 ms** |
  | Scan with no field focused | not supported | **13 ms** |
  | Pay -> receipt < 1 s | 1,825 ms | 1,735 ms (**not met**) |
  | Submit offline < 50 ms | 20 ms | 26 ms |
  | Reopen cached < 3 s | 7,802 ms | **2,483 ms** |
  | Initial cache 20,000 < 60 s, progress bar | 20.4 s, no bar | 17.8 s, bar |
  | Sync 500 queued < 5 min, no duplicates | (code not changed) | 9 min 34 s, no duplicates (**not met**) |

- `bench --site pos.test migrate`, `bench build --app pos_next`: OK. `biome check` clean on `src/plus`, `e2e`, `perf`.
- After the Python runs, the demo prices were rebuilt with `seed.ensure_item_prices` (ERPNext `before_tests`).

### Manual checks (need real hardware or a person)

- [ ] Hold a cart on till 1 and resume it on till 2 on two real machines (SPEC acceptance). Also hold while the
      network cable is out, then plug it back in: the cart appears on till 2.
- [ ] Scan with a real HID scanner (USB and Bluetooth) **without clicking the search box**, and with the payment
      dialog open (the scan must be ignored). Check that Bluetooth scanners' key delay stays under 30 ms
      (HARDWARE.md section 9).
- [ ] 20,000-item search and scan meet the section 6 targets on a real mid-range till (Intel i3 / 8 GB or a 2022
      Android tablet, Chrome). The numbers above come from a developer laptop.
- [ ] Pay -> receipt printing < 1 s and sync of 500 invoices < 5 min on a **production** server (gunicorn workers,
      no developer mode), with a real receipt printer.
- [ ] Reopen the installed PWA from the taskbar / home screen: under 3 s with the cache filled.
- [ ] Keyboard shortcuts on a real keyboard, including laptop Fn keys, and `?` on an Arabic keyboard layout (the key
      gives `؟` there; the shortcut only reacts to `?`).
- [ ] Switch the POS to Arabic and look at the Held Carts dialog, Hold dialog, favourites grid and `?` overlay;
      only `dir="rtl"` was simulated automatically.
- [ ] Desk: open a held draft in Sales Invoice (collapsed "Held Cart (POS)" section) and check the list filter
      "Held Cart".
- [ ] 1024x768 and a 10-inch tablet: the favourites grid (collapsible) leaves enough room for the item grid.

### Not done in this phase

- Pay -> print < 1 s and sync 500 < 5 min are not met on the dev bench (see Decisions to review 1 and 2).
- Favourites are not filtered by stock, and they are not shown on the item group tabs.
- The F3 shortcut focuses the customer search in the cart. When a customer is already chosen, it shows a hint
  instead of clearing the customer.
- The search index takes Arabic names from the label cache (Phase 5), only when the cashier may print labels.
  Phase 7 adds `item_name_ar` to the item cache.

### Decisions to review

1. **Pay -> print is 1.7 s on the dev bench.** Most of this is POS Next's online `submit_invoice` (about 1.1 s here),
   plus `get_receipt_data` (Phase 4 decision 8: online receipts show the server's final VAT and rounding). Options:
   measure on a production server first, or print online sales from the local invoice at once (this changes Phase 4
   decision 8). Nothing was changed.
2. **Sync of 500 invoices takes 9.6 min (one browser, dev bench).** POS Next syncs one invoice at a time, with a
   pre-check call for each. Making it parallel or dropping the pre-check changes POS Next's sync behaviour (ask-first
   area), so it was left for the Phase 8 load test. There were no duplicates: 500 sync rows, 500 different invoices.
3. **Held carts are named `HOLD-<uuid>`, not from the invoice naming series.** This keeps the tax invoice numbers
   without gaps (UAE). It uses a Sales Invoice `before_insert` hook that only acts on held drafts. A resumed cart is
   submitted as a new invoice with a normal number; the held draft is deleted (a Deleted Document remains as the
   audit trail and as the "already resumed" marker).
4. **Resume = claim.** Resuming deletes the server draft at once, so no other till can take the cart. If the till
   that resumed it then closes without selling, the cart is lost (as with POS Next's local drafts). The other choice,
   locking the cart until it is sold or held again, is more complex.
5. **Held drafts never carry the opening shift**, so POS Next's shift close (`delete_draft_invoices`) leaves them
   alone. They are removed only by resume, delete or the retention cleanup.
6. **A cart the server refuses** (for example a disabled customer, or "block sale beyond stock" in POS Next's
   `update_invoice`) stays on the till with the reason, and is tried again on every refresh or reconnect. It can
   still be resumed on that till.
7. **Hold and "Save draft" are one thing.** F8 and Ctrl+S both hold the cart (SPEC lists them separately). POS Next's
   local-only drafts are now held carts; old local drafts are uploaded once.
8. **Reopen shows the cache first.** POS Next fetched the server's first page and re-synced the whole catalogue on
   every page load. Now the cached catalogue shows at once, and the server refresh runs afterwards only when the
   last item sync is older than `cache_refresh_minutes` (default 5). Prices changed on the server reach a reopened
   till in the background, not before the first screen. This changes POS Next behaviour (ask-first area); the safe
   variant was chosen, since data is never older than the setting before a refresh starts.
9. **POS Next's `getCacheStats()`** now counts hidden variants and templates through IndexedDB indexes. It assumes
   `has_variants` is cached as 0/1, as the server sends it, and falls back to the old full scan on error.
10. **Search ranking**: exact barcode, exact code, code prefix, then name or Arabic prefix, then word starts, then
    any substring. Every word must match. The index replaces POS Next's browser search when ready; POS Next's
    search is the fallback. Server results still replace them after the debounce when online (as before).
11. **Global scanner rule**: at least 4 characters, at most 30 ms between keys, ending in Enter or Tab, no text field
    focused, no dialog open. `+`, `-` and Del inside a fast burst are not taken as shortcuts.
12. **Favourites** = top 30 by quantity sold on the POS Profile in the last 90 days (not configurable yet). The
    list is collapsible, and the choice is remembered per browser.
13. **No new npm or pip dependency.** Virtual scrolling is built in (POS Awesome uses `vue-virtual-scroller`).
14. `window.pos0001Search` (status and search) is exposed for e2e tests and support.
15. The e2e test and the benchmark send scans as one burst of key events inside the page. Playwright's
    `keyboard.type` spaces keys by the time each takes to be handled, which exceeds 30 ms on a busy page.
16. Demo data note: ITM-00002 shows two "Nos" UOM rows in the UOM dialog (left over from earlier test data). It does
    not affect this phase but is worth cleaning up in the seed.

## Phase 6

Second run, 2026-11-19 (unattended). The first run (section above) built everything in SPEC section 11, Phase 6,
but two section 6 targets were not met. This run worked on those two targets and checked everything again.

### What was built

- **Batch offline sync** (SPEC section 6, "sync 500 queued invoices < 5 min"):
  - Server: `pos_0001.api.sync.submit_offline_invoices`. It takes up to 25 invoices and processes each one the same
    way as `submit_offline_invoice`. Each invoice is committed on its own, so a Synced or Failed-and-stored answer
    is durable even if a later invoice of the batch breaks. An invoice that cannot be processed (lock timeout,
    access error, no offline id) answers `Error` with `stored: false`, and the browser keeps it.
  - Browser (POS Next `utils/offline/sync.js`, UPSTREAM_PATCHES 37): the queue goes in batches of 10, two
    requests at a time. An invoice the batch settled skips the pre-check and the single submit. Any other answer,
    or a failed batch request, goes through POS Next's one-by-one path as before. The DECISIONS item 2 rule is
    kept: a row leaves the queue only on Synced or Failed-and-stored. A run starts no new batch after 40 s and
    then starts a follow-up run, so it never outlives the 60 s sync mutex timeout.
  - Pure helpers in `plus/core/syncOutcome.js`: `chunkQueue`, `matchBatchResponses`, `runInLanes`.
- **Receipt data in the submit answer** (SPEC section 6, "pay -> receipt starts printing < 1 s"). POS Next's
  `submit_invoice` adds `pos0001_receipt` for online Sales Invoices (UPSTREAM_PATCHES 38). This is the same data
  as `get_receipt_data`, read inside the submit transaction, so it still has ERPNext's final VAT and rounding.
  `POSSale.vue` prints from it, so no second request is needed (UPSTREAM_PATCHES 39). The stock refresh after a
  sale now runs while the receipt prints. A plain copy is printed, because IndexedDB cannot store the reactive
  answer and F9 reprint needs the stored copy (the e2e test found this).
- E2E fix in `till-speed.spec.js`: the test pressed `+` twice less than 30 ms apart, so the scanner rule took
  the presses as a burst. It now waits 150 ms between presses. The shortcut-row height is now measured after the
  overlay's open transition (it read 43.96 px during the scale-in).
- Docs: PERFORMANCE.md (second-run numbers and analysis), ARCHITECTURE_NOTES "After Phase 6", UPSTREAM_PATCHES
  37-39.

### Test results

- **Python** (`bench --site pos.test run-tests --module ...`):
  - `test_sync`: **17 OK**. New `TestBatchSync` (4 tests): one answer per invoice, in order. The same offline
    id twice in one batch gives one invoice. A rejected invoice is stored as Failed with its payload. An
    invoice without an offline id answers Error, not stored, and the rest of the batch still syncs. A user who
    is not on the POS Profile gets Error and nothing is created. Bad input and Guest are refused.
  - `test_printing`: **17 OK**, with 3 new tests. The online `submit_invoice` answer carries the receipt, equal
    to `get_receipt_data`. An offline sync answer has none. A receipt failure returns None.
  - Regression: `test_held_carts` 11, `test_favourites` 3, `test_barcode` 19, `test_sales_person` 20,
    `test_labels` 21, `pos_next.test_promotions` 18, `pos_next.api.test_credit_sales` 4,
    `pos_next.test_packed_items_regression` 3. All OK.
  - The whole-app `run-tests` still does not start on v15 (Phase 1 decision 8). Demo prices were rebuilt after
    the runs (`seed.ensure_item_prices`).
- **Vitest** `yarn test:run`: **190 tests, 17 files, all pass** (4 new tests for the batch helpers).
- **Playwright** `yarn e2e`: **15 passed** (4.5 min) on the final run. Earlier runs in this session found the F9
  regression (fixed). They also failed on the two timing problems in `till-speed.spec.js` (fixed in the test) and
  once on the "online receipt < 5 s" check of `receipt-printing.spec.js`: 6.5 s on a cold first sale while
  the shared machine was busy. That check passed on the 3 runs after.
- **Benchmark** `yarn perf` (dev bench, 20,000 items). First run -> this run:

  | Target | First run | This run | Met |
  | --- | --- | --- | --- |
  | Search first results < 100 ms | 32 ms | 33 ms | yes |
  | Scan to cart < 150 ms | 24 ms | 22 ms | yes |
  | Scale scan to cart < 150 ms | 27 ms | 24 ms | yes |
  | Scan with no field focused | 13 ms | 13 ms | yes |
  | Pay -> receipt < 1 s | 1,735 ms | **1,296 ms** | **no** |
  | Submit offline < 50 ms | 26 ms | 18 ms | yes |
  | Reopen cached < 3 s | 2,483 ms | 2,477 ms | yes |
  | Initial cache 20,000 < 60 s, progress bar | 17.8 s | 16.0 s | yes |
  | Sync 500 queued < 5 min, no duplicates | 9 min 34 s | **6 min 44 s**, 500 Synced, 500 different invoices | **no** |

- `bench build --app pos_next`: OK. `biome check` is clean on the changed files. `e2e/till-speed.spec.js` and
  `perf/benchmark.spec.js` still have small formatting differences from before this run.

### Manual checks (need real hardware, a person or a production server)

The manual checks of the first run still apply. Also:

- [ ] Run `yarn perf` against a **production** setup (gunicorn with several workers, no developer mode, nginx).
      Check sync 500 < 5 min and pay -> print < 1 s there. `bench serve` is one Python process, so the two sync
      requests cannot run in parallel on the dev bench. Starting a gunicorn server was not allowed in this
      unattended run.
- [ ] 5 tills syncing together (SPEC section 10 load test, Phase 8). This now means 10 batch requests at once.
      Watch for lock waits or deadlocks on Bin and GL. Such an invoice answers Error and is retried one by one.
- [ ] Online sale on a real receipt printer: the receipt prints at once, and F9 reprints the same receipt.

### Decisions to review

1. **Batch sync changes POS Next's sync behaviour** (ask-first area). Safest variant chosen: the new path is
   used only for invoices the server settles in the batch. Everything else uses POS Next's old path. The
   offline-id duplicate protection is not changed. Batch size 10, two lanes. These are constants in
   `plus/core/syncOutcome.js` (`SYNC_BATCH_SIZE`, `SYNC_BATCH_LANES`).
2. **Invoices from one till may reach the server slightly out of order**, because two batches run at a time. Each
   invoice keeps its own posting date and time from the till. Set `SYNC_BATCH_LANES = 1` if strict order matters.
3. **Pay -> print stays 1.3 s on the dev bench.** The till still waits for the server, because the receipt must
   show ERPNext's final VAT and rounding (Phase 4 decision 8, UAE tax invoice). To go below 1 s on slow servers,
   it would have to print the browser's figures first, or merge POS Next's `update_invoice` and `submit_invoice`
   calls into one. Both change POS Next or the tax display, so neither was done.
4. **The two remaining targets depend on the server.** SPEC section 6 gives the till hardware but not the
   server. This run reports them as not met on the dev bench and does not claim production numbers it could not
   measure.

### After the second run (2026-11-19, with the user)

- Demo photos: every demo item has a product photo (30 CC0 / public-domain photos in `pos_0001/demo/images`,
  credits in `CREDITS.md` there; `seed.ensure_item_images`).
- POSNext workspace lists every pos_0001 feature: new shortcuts, a "What this POS can do" overview and four new
  cards (UPSTREAM_PATCHES 40). `test_workspace`: 5 OK. RTL checked; the overview paragraphs stay English because
  Frappe does not translate workspace paragraph text.

PHASE 6: BLOCKED - pay -> receipt (1.3 s, target 1 s) and sync of 500 queued invoices (6 min 44 s, target 5 min) are still not met on the dev bench; both are now bound by server time in POS Next's submit_invoice and need a measurement on a production (multi-worker) server, which this unattended run was not allowed to start
