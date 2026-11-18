# Upstream patches

Every edit to a file that comes from POS Next (BrainWise) is listed here so upstream merges stay easy.
New files under `pos_next/pos_0001/` and `POS/src/plus/` are ours and are not listed.

| # | Phase | File | Reason | What changed |
| --- | --- | --- | --- | --- |
| 1 | 1 | `.gitignore` | DECISIONS.md item 11: commit lockfiles | Removed `yarn.lock` from the ignore list; ignore Playwright output folders |
| 2 | 1 | `POS/package.json` | Phase 1: Playwright for e2e tests | Added dev dependency `@playwright/test` (Vitest was already present) |
