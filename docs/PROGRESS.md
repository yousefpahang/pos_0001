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
