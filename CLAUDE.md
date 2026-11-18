# pos_0001 — project rules for Claude

Branded ERPNext POS: a fork of BrainWise POS Next (AGPL-3.0) with features ported
from POS Awesome (defendicon fork, GPL-3.0). Full spec: docs/SPEC.md.
docs/DECISIONS.md overrides SPEC.md wherever they differ.
How the base code works: docs/ARCHITECTURE_NOTES.md (read before changing anything).
Progress and status per phase: docs/PROGRESS.md.

## Targets
- Frappe/ERPNext v15 (branch version-15) first; must also install on v16.
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
