# Decisions after Phase 0 (these override docs/SPEC.md where they differ)

1. Duplicates: reuse POS Next's offline_id and Offline Invoice Sync. Do NOT add offline_uuid or
   the POS Sync Log doctype. If Offline Invoice Sync lacks fields we need (device, error text,
   status Failed, payload), add them as Custom Fields in fixtures, not by editing its JSON.
2. Failed sync: do not create Draft invoices (they often fail validation too). Store the failed
   payload + error on the Offline Invoice Sync record with status Failed, show it in the cashier
   sync panel, and add a Retry action (POS and desk). Nothing is deleted from the browser queue
   until the server confirms Synced or Failed-and-stored.
3. Scale barcodes: do NOT install barcode_resolver and do NOT change the POS Barcode Rules doctype.
   Create our own doctype "POS Scale Barcode Rule" in pos_0001 with the fields from SPEC F5.
   Parse in the browser (works offline) and re-validate on the server. Hook in after POS Next's
   exact barcode match fails.
4. Offline scanning: in Phase 2, resolve scanned barcodes from the cached item barcodes in the
   browser first, then call the server only if online and not found.
5. Sales person: add Off / Optional / Mandatory per POS Profile and a default per user (custom
   fields), and add the picker to the cart header as well as the payment dialog.
6. Held carts: make them server-side (draft invoices) when online so they resume on any till;
   keep the local copy when offline and upload it on reconnect. (Built in Phase 6.)
7. QZ signing: reuse the existing key files in the site's private folder. No key fields in
   POS 0001 Settings.
8. Translations: use Frappe's CSV translations (pos_next/translations/ar.csv). No ar.json.
9. Language: stay in JavaScript (use JSDoc type comments). Do not add TypeScript.
   Read any ".ts" file name as ".js".
10. Access check: add a POS Profile permission check to submit_invoice as a minimal patch, list it
    in UPSTREAM_PATCHES.md, and keep it as a separate commit we can send to BrainWise.
11. Node: switch this bench to Node 22 (nvm, this bench only) and commit the generated yarn.lock
    so every install gets the same packages. Clients' servers need Node 22 too: add that to README.
12. Credit: keep using the POS Settings flag as the seed does.
