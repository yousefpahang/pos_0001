# Notice

POS 0001 (repository `pos_0001`, release 1.0.0) is a fork of **POS Next** by BrainWise
(<https://github.com/BrainWise-DEV/POSNext>), Copyright (c) BrainWise and contributors, licensed under the GNU Affero
General Public License v3.0. The combined work is distributed under AGPL-3.0 (see `license.txt`). Original
copyright headers are kept. Files added by this fork carry the header "Copyright (c) 2026, pos_0001 contributors".

Changes made to POS Next's own files are listed, file by file, in `docs/UPSTREAM_PATCHES.md` (AGPL-3.0 section 5a:
modified files carry a notice of the change).

## Base

| Project | Role | License |
| --- | --- | --- |
| POS Next (BrainWise) | Base of this fork | AGPL-3.0 |
| Frappe Framework, ERPNext (Frappe Technologies) | Platform; not included, installed by bench | MIT, GPL-3.0 |
| POS Awesome V15 (defendicon fork) | Logic ported, see below; not a dependency | GPL-3.0 |
| LumenPOS | Ideas only (sync log, mandatory sales person, commission report); no code used | not stated |

## Third-party work

### POS Awesome (defendicon fork)

Parts of pos_0001 are ported from **POS Awesome V15** (<https://github.com/defendicon/POS-Awesome-V15>),
GPL-3.0, Copyright (c) the POS Awesome contributors. GPL-3.0 code may be combined with AGPL-3.0 code.

| pos_0001 file | Ported from | What |
| --- | --- | --- |
| `POS/src/plus/core/escpos.js` | `frontend/src/posapp/services/rawDocumentPrint.ts` | ESC/POS text layout helpers (`center`, `leftRight`, `wrap`) and the text receipt structure |
| `POS/src/plus/core/zpl.js`, `pos_next/pos_0001/labels.py` | `frontend/src/posapp/composables/pos/items/useZplGenerator.ts` | `mmToDots`, ZPL escaping, `^BY` / `^BCN` / `^BEN` barcode fields |
| `POS/src/plus/core/epl.js`, `pos_next/pos_0001/labels.py` | same file (`generateEpl`, `getEplBarcodeType`) | EPL `B` barcode command and label structure (`N`, `q`, `Q`, `P`) |
| `POS/src/plus/components/LabelPrintPanel.vue` | `frontend/src/posapp/components/pos/shell/BarcodePrinting.vue` | Label printing flow (rows with UOM, quantity and price, template, print); the UI is rebuilt in Tailwind, no code copied |
| `pos_next/pos_0001/api/labels.py` | `posawesome/posawesome/api/label_data_sources.py` | Items of a source document as label rows (here Purchase Receipt and Stock Entry) |

POS Awesome is a reference only; it is not a dependency. Its Vuetify UI is not copied; our components are
rebuilt in Tailwind.

### Algorithms

- `POS/src/plus/core/qr.js`: QR code encoder written from ISO/IEC 18004; format-bit placement follows Project
  Nayuki's public QR Code generator (MIT). Tested against `pyqrcode` output.
- `POS/src/plus/core/code128.js`: Code128 symbol table from the public standard.
- `POS/src/plus/core/tspl.js`: TSPL commands written from TSC's TSPL/TSPL2 programming manual (POS Awesome has no
  TSPL builder). EAN-13 bar patterns (`ean.js`, `barcodes.py`) from the public GS1 standard.

### Browser packages

The till's JavaScript packages (Vue, Pinia, frappe-ui, Dexie, qz-tray and others) are listed with their versions
in `POS/package.json` and `POS/yarn.lock`, each under its own license. pos_0001 added only the development
dependency `@playwright/test` (Apache-2.0).

## Source code (AGPL-3.0 section 13)

Users of a hosted install can get the source code of the version they use. The till's menu entry
"About / Source code" shows the version and opens the link set in POS 0001 Settings, **Source Code URL**
(`about_source_url`, default <https://github.com/yousefpahang/pos_0001>). Whoever hosts a modified version must
point it at the source of that modified version.

This notice is not legal advice. Confirm the license obligations with a lawyer before selling.
