# Performance (SPEC section 6)

Phase 6 measured every target in SPEC section 6 with a benchmark script, then added virtual
scrolling, an IndexedDB search index built in a Web Worker, a favourites grid, global scanner capture
and faster reopening. The script runs again after any change.

## How to measure

```bash
cd POS
yarn perf                       # all targets, writes test-results/perf-<label>.json
```

The benchmark is `POS/perf/benchmark.spec.js` with the config `POS/playwright.perf.config.js`. It runs
against `http://localhost:8001` (or `POS_E2E_BASE_URL`) with the demo seed (20,000 items + 50 weighed
items), the cashier user and the POS Profile "Main Till". You can set these options as environment
variables, or put them in `<tmp>/pos0001-perf-options.json`:

| Option | Default | Meaning |
| --- | --- | --- |
| `PERF_LABEL` | `run` | Output file name `test-results/perf-<label>.json` |
| `PERF_SYNC_COUNT` | `500` | Invoices for the sync test (0 = skip; each run creates real invoices) |
| `PERF_ASSERT` | `0` | `1` = fail the run when a target is missed |
| `PERF_ITEM_COUNT` | `20000` | Items expected in the cache |

The script times inside the page with `performance.now()` where possible, so Playwright's own round
trips are not counted. Each result is the median of 3 to 10 runs. Before you run it, rebuild the demo
prices with `bench --site pos.test execute pos_next.pos_0001.demo.seed.ensure_item_prices` if Python
tests ran since the last rebuild (ERPNext's `before_tests` deletes every Item Price).

What each step measures:

| Metric | From | To |
| --- | --- | --- |
| `initial_cache_ms` | opening `/pos` in a fresh browser | all 20,053 items are in IndexedDB (progress bar checked) |
| `reopen_ms` | `page.goto("/pos")` with the cache already filled | first item card or row on screen |
| `search_first_results_ms` | the term is in the search box (one input event, like the last keystroke) | a matching card or row on screen. Terms: code prefix, two words in the name, three words, `#19999`, a barcode, each twice |
| `scan_to_cart_ms` | barcode + Enter in the search box | one more cart line |
| `scale_scan_to_cart_ms` | the same, for the scale label `2012345012509` (1.250 kg) | one more cart line |
| `global_scan_to_cart_ms` | Enter of a scanner burst with no field focused | one more cart line |
| `pay_to_print_ms` | click on Complete Payment (online cash sale) | the raw job reaches QZ Tray (a fake QZ Tray in the test) |
| `submit_offline_ms` | click on Complete Payment while offline | the invoice is in the browser queue |
| `sync_500_ms` | going back online with 500 queued invoices | the queue is empty; then the script checks for one invoice per `offline_id` |

## Results

The site is the dev bench (`bench start`, developer mode, one web process, MariaDB on the same laptop).
The browser is headless Chromium 1280x800 on the same machine. Measured on 2026-11-19 with 20,000 items
cached. "Before" is the code at the end of Phase 5. "After" is the code at the end of Phase 6.

| Action | Target | Before | After | Met |
| --- | --- | --- | --- | --- |
| Item search, first results | < 100 ms | about 1,100 ms (1 of 10 searches found nothing in 5 s) | **32 ms** (the first search after reopen was 758 ms) | yes |
| Barcode scan to line in cart | < 150 ms | 613 ms (runs 60 to 1,762) | **24 ms** | yes |
| Scale barcode scan to line | < 150 ms | 213 ms | **27 ms** | yes |
| Scan with no field focused | < 150 ms | not supported | **13 ms** | yes |
| Pay -> receipt starts printing | < 1 s | 1,825 ms | 1,735 ms; second run **1,296 ms** | **no** (see below) |
| Submit invoice offline | < 50 ms | 20 ms | 26 ms | yes |
| Reopen POS, cached | < 3 s | 7,802 ms | **2,483 ms** | yes |
| Initial full cache of 20,000 items | < 60 s, with progress bar | 20.4 s, no progress bar | 17.8 s, with progress bar | yes |
| Sync 500 queued invoices | < 5 min, no duplicates | 9 min 34 s (first run, one at a time) | second run, batches: **6 min 44 s**; 500 synced, 500 different invoices, no duplicates | **no** (see below) |

Raw files: `POS/test-results/perf-before.json` and `perf-after.json` from the runs. They are not committed
because Playwright empties that folder at the start of each run. Single runs vary by about ±30 % on this
laptop: Python tests, a build or a second browser running at the same time all slow the page.

### Targets not met on the dev bench

Second run (same day). Two changes, then measured again:

- **Batch sync.** The browser sends the queue in batches of 10 to `pos_0001.api.sync.submit_offline_invoices`,
  two requests at a time. The server processes and commits each invoice on its own, so a confirmed answer is
  durable. Invoices that a batch did not settle go through POS Next's one-by-one path, as before. This removes
  the pre-check and one HTTP round trip per invoice: 1.15 s -> 0.8 s per invoice, 9 min 34 s -> 6 min 44 s.
  What is left is server CPU. `submit_invoice` takes about 0.55 s per invoice, warm, in `bench console`
  (`update_invoice` saves a draft, then the submit makes GL and stock entries). `bench serve` is one Python
  process, so the two requests do not run in parallel. On a production server with several gunicorn workers,
  the two requests should run in parallel (about 0.3 s per invoice, or 2.5 min for 500). This could not be
  measured here: starting a gunicorn server was not allowed in the unattended run.
- **Pay -> print.** POS Next's `submit_invoice` answer now carries the receipt data (`pos0001_receipt`, the same
  data as `get_receipt_data`, read inside the submit transaction). So the till prints without a second request.
  The stock refresh after a sale runs while the receipt prints. 1,735 -> 1,296 ms. What is left is POS Next's two
  calls, `update_invoice` and `submit_invoice` (about 1.1 s together on this server), plus about 150 ms for the
  raster. Printing before the server answers would mean printing the browser's VAT and rounding on a tax
  invoice, so it was not done (Phase 4 decision 8 stays).

First run notes:

- **Pay -> print (1.7 s).** An online sale waits for POS Next's `submit_invoice`, which takes about
  1.0 to 1.3 s on this dev server. After that, Phase 4 fetches `get_receipt_data` so the receipt shows
  ERPNext's final VAT and rounding (Phase 4 decision 8). Then the raster receipt is drawn in the worker
  (about 150 ms). Offline sales already print from the local invoice. To reach < 1 s, there are two
  options (see Decisions to review in PROGRESS.md):
  (a) measure again on a production server (gunicorn with several workers, no developer mode), or
  (b) print online sales from the local invoice right away and add the invoice number afterwards.
  Option (b) changes the Phase 4 decision.
- **Sync 500 (9.6 min).** POS Next sends queued invoices one at a time, and each one makes two server
  calls (`check_offline_invoice_synced`, then `submit_offline_invoice`). About 1.1 s per invoice on the
  dev server sets the total time. The browser does almost no work during this time. Ways to make it
  faster: run several syncs at once (POS Next's sync uses one lock; duplicate protection by
  `offline_id` is already done on the server), drop the pre-check, or use more web workers. SPEC
  section 10 plans the 5-device load test for Phase 8.

## What changed (Phase 6)

| Technique | Where | Effect |
| --- | --- | --- |
| Search index in IndexedDB, built and searched in a Web Worker | `plus/core/searchIndex.js`, `plus/search/searchIndex.worker.js`, `plus/search/searchClient.js`, patch in `stores/itemSearch.js` | One compact row per item: lowercased name, code, barcodes, and the Arabic name (with Arabic letter forms folded). Every word must match anywhere in the row. Exact barcode, then code, then prefix matches rank first. The index is stored in its own database `pos0001_search`, so a reopened till does not rebuild it (it rebuilds only when the item count changes or after a catalogue sync). It answers 20,000 rows in a few ms. The first 60 results show at once, without POS Next's 150 to 500 ms debounce. POS Next's multi-word search looked at only the first 5,000 cached items, so it missed matches |
| Virtual scrolling | `plus/core/virtualGrid.js`, `plus/perf/useVirtualGrid.js`, patch in `ItemsSelector.vue` | The grid and the list render only the rows in view plus 3 extra rows, so 500 search results draw about 40 cards. Columns and row height are measured from the rendered grid, so Tailwind breakpoints keep working. Lists of 60 items or fewer render as before |
| Faster reopen | `plus/core/cacheFreshness.js`, patches in `stores/itemSearch.js` and `workers/offline.worker.js` | POS Next fetched the first page from the server and re-synced the whole catalogue on every page load. It also counted hidden variants by reading all 20,000 item objects (1 to 2 s). Now the till shows its cache at once. If the last item sync is older than `cache_refresh_minutes` (POS 0001 Settings, default 5), the server refresh runs afterwards. The hidden count uses the indexes |
| Favourites grid | `pos_0001/api/favourites.py`, `plus/favourites/favouritesStore.js`, `plus/components/FavouritesGrid.vue` | The profile's top 30 sellers (by quantity, last 90 days), shown as one-tap buttons while the search box is empty. The list is stored in IndexedDB and the item details come from the item cache, so it works offline |
| Global scanner capture | `plus/core/scannerCapture.js`, `plus/scan/globalScanner.js`, patch in `useSearchInput.js` | When no text field has focus, keys at most 30 ms apart that end in Enter (or Tab), with at least 4 characters, count as a scan. The scan goes through the same queue as the search box. A person typing (gaps over 30 ms) is ignored. Scans are ignored while a dialog is open |
| Web Worker for heavy work | search index worker (this phase), raster receipts (Phase 4) | Indexing 20,000 items takes about 4 s, all in the worker. The main thread stays free |
| Progress bar | `ItemsSelector.vue` | Shows the percent of the catalogue cached under POS Next's "Syncing catalog" line |

A note on testing the scanner: Playwright's `keyboard.type` waits for each key to be handled. On a busy page
its gaps grow past 30 ms. Real scanner keys keep their hardware time stamps. So the e2e test and the
benchmark send a scan as one burst of key events inside the page. Test with a real HID scanner as well
(PROGRESS.md, manual checks).

## Keyboard shortcuts

Press `?` on the till to see this list. Function keys and Ctrl+S work everywhere. The other keys work only
when no text field has focus, and no key works while a dialog is open.

| Key | Action |
| --- | --- |
| F2 | Focus item search |
| F3 | Focus customer search in the cart |
| F4 | Pay |
| F6 | Open or close the sales person picker |
| F8, Ctrl+S | Hold the cart (with a note) |
| F9 | Reprint last receipt (printing store, Phase 4) |
| Esc | Close dialog |
| Del | Remove the last cart line |
| + / - | Last line quantity +1 / -1 (not for scale lines) |
| ? | Shortcut list |
