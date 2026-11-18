# pos_0001 — project rules for Claude

Branded ERPNext POS: a fork of BrainWise POS Next (AGPL-3.0) with features ported
from POS Awesome (defendicon fork, GPL-3.0). Full spec: docs/SPEC.md.
How the base code works: docs/ARCHITECTURE_NOTES.md (read before changing anything).

## Targets
- Frappe/ERPNext v15 (branch version-15) first; must also install on v16.
- Dev site: pos.test. Bench at ~/projects/pos/frappe-bench. POS Awesome reference: ~/reference/posawesome (read-only).

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
