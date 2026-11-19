# Notice

pos_0001 is a fork of **POS Next** by BrainWise (<https://github.com/BrainWise-DEV/POSNext>),
licensed under the GNU Affero General Public License v3.0. The combined work is distributed under AGPL-3.0.

## Third-party work

### POS Awesome (defendicon fork)

Parts of pos_0001 are ported from **POS Awesome V15** (<https://github.com/defendicon/POS-Awesome-V15>),
GPL-3.0, Copyright (c) the POS Awesome contributors. GPL-3.0 code may be combined with AGPL-3.0 code.

| pos_0001 file | Ported from | What |
| --- | --- | --- |
| `POS/src/plus/core/escpos.js` | `frontend/src/posapp/services/rawDocumentPrint.ts` | ESC/POS text layout helpers (`center`, `leftRight`, `wrap`) and the text receipt structure |

POS Awesome is a reference only; it is not a dependency. Its Vuetify UI is not copied; our components are
rebuilt in Tailwind.

### Algorithms

- `POS/src/plus/core/qr.js`: QR code encoder written from ISO/IEC 18004; format-bit placement follows Project
  Nayuki's public QR Code generator (MIT). Tested against `pyqrcode` output.
- `POS/src/plus/core/code128.js`: Code128 symbol table from the public standard.

## Source code

Users of a hosted install can get the source code of the version they use from the repository named in
POS 0001 Settings (`about_source_url`).
