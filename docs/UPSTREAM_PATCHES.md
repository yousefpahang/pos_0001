# Upstream patches

Every edit to a file that comes from POS Next (BrainWise) is listed here so upstream merges stay easy.
New files under `pos_next/pos_0001/` and `POS/src/plus/` are ours and are not listed.

| # | Phase | File | Reason | What changed |
| --- | --- | --- | --- | --- |
| 1 | 1 | `.gitignore` | DECISIONS.md item 11: commit lockfiles | Removed `yarn.lock` from the ignore list; ignore Playwright output folders |
| 2 | 1 | `POS/package.json` | Phase 1: Playwright for e2e tests | Added dev dependency `@playwright/test` (Vitest was already present) |
| 3 | 1 | `pos_next/api/invoices.py` | DECISIONS.md item 10: `submit_invoice` did not check POS Profile access | Added `_check_submit_pos_profile_access()` and one call at the top of `submit_invoice`. Users must be listed in the profile's POS Profile User table; Administrator, System Manager and Nexus POS Manager pass. Own commit, can be sent upstream as is |
| 4 | 1 | `pos_next/modules.txt` | Register our module so its doctypes and `custom/*.json` sync on migrate | Added the line `POS 0001` (folder `pos_next/pos_0001/`) |
