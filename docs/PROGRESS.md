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
