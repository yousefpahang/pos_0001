# Merging a new POS Next release (upstream) into pos_0001

pos_0001 is a fork of BrainWise POS Next. SPEC section 2 asks for a monthly merge of `upstream/version-15`. This note
says how to do it without losing our changes.

## How the fork is laid out

- **Ours, never in upstream:** `pos_next/pos_0001/` (server), `POS/src/plus/` (browser), `POS/e2e/`, `POS/perf/`,
  `POS/playwright*.config.js`, `POS/vitest.config.js`, `docs/SPEC.md`, `DECISIONS.md`, `ARCHITECTURE_NOTES.md`,
  `PROGRESS.md`, `UPSTREAM_PATCHES.md`, `HARDWARE.md`, `PERFORMANCE.md`, this file, `NOTICE.md`, `CLAUDE.md`.
  These merge without conflicts.
- **Upstream files we edited:** every one is listed in [UPSTREAM_PATCHES.md](UPSTREAM_PATCHES.md) with the reason
  and the exact change. Conflicts can only happen in these files. The hot spots are `pos_next/hooks.py`,
  `pos_next/api/invoices.py`, `POS/src/pages/POSSale.vue`, `POS/src/components/sale/InvoiceCart.vue`,
  `POS/src/components/sale/PaymentDialog.vue`, `POS/src/utils/offline/sync.js`, `POS/src/stores/itemSearch.js`.
- **Shared files:** `README.md` (our section on top, upstream text below a divider), `CHANGELOG.md` (our
  `pos_0001` entries on top), `pos_next/translations/ar.csv` (our rows appended at the end), `POS/package.json`
  and both `yarn.lock` files.
- **Versions:** `pos_next/__init__.py` keeps POS Next's version; our release is `pos_next/pos_0001/__init__.py`
  `__version__` and the git tag `vX.Y.Z`.

## Steps

Run everything from the app folder (`~/projects/pos/frappe-bench/apps/pos_next`) on a working copy with no local
changes.

1. Fetch and look at what changed:

   ```bash
   git fetch upstream
   git log --oneline version-15..upstream/version-15
   git diff version-15...upstream/version-15 --stat
   ```

   Compare the file list with UPSTREAM_PATCHES.md. Read the upstream diff of every file that is listed there before
   merging.

2. Merge on a branch:

   ```bash
   git switch -c merge-upstream-YYYY-MM version-15
   git merge upstream/version-15
   ```

3. Resolve conflicts with UPSTREAM_PATCHES.md open:
   - Take upstream's version of the file, then apply our change again as the table row describes. Our edits are
     small on purpose (an import, one call, a slot, a hook entry), so this is usually quicker than editing the
     conflict markers.
   - `hooks.py`: keep upstream's entries and add ours back (`doc_events` on Sales Invoice, `doctype_js`,
     `doctype_list_js`, `after_install` / `after_migrate` lists, `jinja.methods`, `scheduler_events.daily`).
   - `ar.csv`: keep both sides. If upstream added a row we also have, keep one (Frappe uses the last one).
   - `yarn.lock`: do not merge by hand. Take upstream's `package.json` changes, keep our dev dependency
     (`@playwright/test`) and scripts (`e2e`, `perf`), then run `yarn install` with Node 22 in the app root and in
     `POS/` to regenerate both lockfiles.
   - `README.md`: keep our top section; take upstream's text below the divider.
   - If upstream now does something we patched in (for example a POS Profile check in `submit_invoice`, a v15-safe
     test import, the `syncPending` export), drop our patch and mark its row in UPSTREAM_PATCHES.md "dropped:
     upstream has it since X".
4. Check what upstream changed in the areas we depend on (ARCHITECTURE_NOTES.md lists the details):
   - `submit_invoice` / `update_invoice` and the Offline Invoice Sync doctype (duplicate protection, our failed-sync
     storage wraps it);
   - the Dexie schema in `POS/src/utils/offline/db.js` (our caches live in its `settings` store);
   - `get_items` result fields (`item_name_ar`, barcodes, `item_uoms`, `uom_prices`);
   - QZ Tray code (`utils/qzTray.js`, `api/qz.py`);
   - `install.reclaim_pos_settings_doctype()`: it drops `tabPOS Settings` when ERPNext's doctype of that name wins.
     Back up the site before migrating if upstream touched it.
5. Test (see README "Tests"; on a test site, never on a live one):

   ```bash
   cd ~/projects/pos/frappe-bench
   bench --site pos.test migrate
   bench build --app pos_next
   bench --site pos.test run-tests --app pos_next --skip-test-records
   bench --site pos.test run-tests --module pos_next.test_promotions
   bench --site pos.test run-tests --module pos_next.test_packed_items_regression
   bench --site pos.test execute pos_next.pos_0001.demo.seed.ensure_item_prices
   cd apps/pos_next/POS && yarn test:run && yarn e2e
   ```

   `ensure_item_prices` puts back the demo prices that ERPNext's `before_tests` hook deletes; the e2e tests need
   them. Do not run Python tests while the e2e tests run.
6. Update UPSTREAM_PATCHES.md (rows changed, added or dropped), add a CHANGELOG entry ("Merged POS Next X.Y.Z"),
   and merge the branch into `version-15`. Tag a pos_0001 release when it goes to clients.

## Sending patches upstream

Rows in UPSTREAM_PATCHES.md marked "can be sent upstream" are bug fixes that are useful to BrainWise as they are
(POS Profile check in `submit_invoice`, the `cint` import, the sales team split, the v15 test fixes). Each one is its
own commit, so `git format-patch -1 <commit>` or a cherry-pick onto a branch of upstream gives a clean pull
request. Every upstream patch merged there is one less conflict here.
