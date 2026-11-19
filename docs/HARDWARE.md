# Hardware: receipt printers, label printers, cash drawer, QZ Tray

How a till prints receipts and opens the cash drawer (SPEC F9), and how barcode labels print (SPEC F4,
section 8 below).

## How it works

```text
POS (browser) --WebSocket--> QZ Tray (on the till) --USB / LAN--> receipt printer --RJ11--> cash drawer
```

- The POS builds the receipt itself, from the invoice in the browser, so receipts print offline too.
- **QZ Tray** is a small program installed on each till. It gives the browser access to the printers.
  There is no other local agent.
- QZ Tray only prints silently (no "Allow" pop-up) when the POS signs every request. POS Next already does
  this: the certificate and private key are files in the site's private folder
  (`sites/<site>/private/qz/digital-certificate.crt` and `private-key.pem`), and the browser asks the server to
  sign (`pos_next.api.qz.sign_message`). There are no key fields in any settings doctype (DECISIONS.md item 7).

## 1. Install QZ Tray on each till

1. Download QZ Tray 2.2 or newer from <https://qz.io/download/> and install it (Windows, macOS or Linux).
   It needs no separate Java install.
2. Start QZ Tray and set it to start with the computer (tray icon > Advanced > Automatically start).
3. Install the printer's own driver (Epson, Xprinter, ...) so the printer appears in the operating system's
   printer list. For a LAN printer no driver is needed in `raster` and `escpos_text` mode.

## 2. Certificate (once per site, then on every till)

1. In the POS, open **POS Settings** (gear icon) as a System Manager, turn on **Silent Print** and press
   **Generate Certificate**. This runs `pos_next.api.qz.setup_qz_certificate`, which writes the certificate and
   private key into `sites/<site>/private/qz/`. Run it once per site; all tills share it.
   Back up the `private/qz/` folder with the site's private files.
2. Press **Download Certificate** to save the public certificate (`.crt`).
3. On every till, copy that file into the QZ Tray program folder and name it `override.crt`:
   - Windows: `C:\Program Files\QZ Tray\override.crt`
   - macOS: `/Applications/QZ Tray.app/Contents/Resources/override.crt`
   - Linux: `/opt/qz-tray/override.crt`
4. Restart QZ Tray (tray icon > Exit, then start it again).
5. Open the POS. The first print must not show an "Allow / Block" dialog. If it does, the certificate on the
   till does not match the site's certificate: download it again and repeat step 3.

Check the current QZ Tray documentation for your version ("override.crt" / "trusted certificate") before go-live;
the folder names above are QZ Tray 2.2 defaults.

The private key never leaves the server. A new certificate (Generate Certificate after deleting the files) means
every till needs the new `override.crt`.

## 3. Printer profile (desk)

Create a **POS Printer Profile** (desk: search "POS Printer Profile"):

| Field | Use |
| --- | --- |
| Purpose | Receipt |
| Connection | **QZ Local Printer** (installed on the till) or **Network** (LAN printer, raw port) |
| QZ Printer Name | Exact name as QZ Tray / the OS lists it. Empty = the printer picked in POS Settings on that till |
| IP Address / Port | Network only, usually port 9100 |
| Print Mode | `raster` (default), `escpos_text`, `qz_html` or `browser`, see below |
| Paper Width | 80 mm (576 dots) or 58 mm (384 dots) |
| Auto Cut | Sends `GS V` after the receipt |
| Copies | 1 to 3 |
| Open Cash Drawer | Sends `ESC p 0 25 250` after sales paid at least partly in cash |
| Receipt Barcode | Code128 (switches to QR when the number is too long, e.g. offline receipts), QR or None |

Then assign it:

- per till: **POS Device** > Receipt Printer (each browser registers itself as a POS Device on first login), or
- per profile: **POS Profile** > POS 0001 section > Receipt Printer (used by tills without their own).

A till with no printer profile keeps POS Next's printing exactly as before (Silent Print / browser).

### Print modes

| Mode | What happens | Use when |
| --- | --- | --- |
| `raster` | The receipt is drawn on a canvas in a Web Worker, converted to 1-bit and sent as `GS v 0` image bands | Default. Arabic, logo, any ESC/POS printer. No code-page problems |
| `escpos_text` | ESC/POS text commands with the printer's own font; Code128/QR by the printer | English-only receipts, fastest. Non-ASCII characters print as `?` |
| `qz_html` | POS Next's QZ HTML printing (Print Format) | Matching desk reprints. QZ Local Printer only |
| `browser` | Browser print dialog | No QZ Tray. The drawer opens only if QZ Tray happens to be connected |

When a mode needs QZ Tray and QZ Tray is not connected, the header shows a **red printer badge** and receipts
print through the browser instead. The badge panel has **Connect QZ Tray**.

## 4. Cash drawer

- Connect the drawer's RJ11 cable to the receipt printer's "DK" port.
- The drawer opens after a sale with a cash payment (Mode of Payment type **Cash**, or POS Next's cash mode on the
  POS Profile). It does not open for card-only sales or reprints.
- **No Sale** (printer badge > Open cash drawer): only for users with the POS Profile's **No Sale Role**
  (POS Profile > POS 0001 section) or POS managers. Every opening is stored as a **POS Drawer Event** (user,
  till, shift, time, reason). Openings made offline are kept on the till and uploaded on reconnect; if the role
  was removed in the meantime the event is stored with Permitted unticked.
- The pulse is pin 2, 50 ms on / 500 ms off. Drawers on pin 5 need `ESC p 1 ...`; not configurable yet.

## 5. Daily use

- Receipts print automatically after payment.
- **F9** or printer badge > Reprint last receipt reprints the last receipt of this till (marked "REPRINT", no
  drawer). Invoice history > Print reprints any invoice (online) or a queued offline invoice.
- Printer badge > Test print prints a sample receipt (includes Arabic text) to check the setup.

## 6. Hardware test matrix

Fill in with the clients' models (SPEC section 10).

| Type | Model | Connection | Mode | Result | Date / by |
| --- | --- | --- | --- | --- | --- |
| Receipt printer | Epson TM-T20 / T82 | USB, LAN | raster, escpos_text | not tested yet | |
| Receipt printer | Xprinter XP-80 series | USB, LAN | raster, escpos_text | not tested yet | |
| Cash drawer | RJ11 via receipt printer | printer kick | | not tested yet | |
| Label printer | Zebra (ZD220 / ZD420 / GK420) | USB, LAN | ZPL | not tested yet | |
| Label printer | TSC (TE200 / TE210) | USB, LAN | TSPL | not tested yet | |
| Label printer | Xprinter label (XP-360B / XP-420B) | USB | TSPL | not tested yet | |
| Label printer | older Zebra / Eltron (LP2844) | USB | EPL | not tested yet | |
| Office printer | any A4 laser / inkjet, label sheets 70 x 37 mm (3 x 8) | browser | PDF | not tested yet | |

## 7. Troubleshooting

| Problem | Check |
| --- | --- |
| Red printer badge | QZ Tray running? Tray icon present? Press Connect QZ Tray. Firewall must allow `localhost:8181/8182` |
| "Allow / Block" pop-up on every print | `override.crt` missing or old on this till (section 2) |
| Prints nothing, no error | QZ Printer Name differs from the OS printer name; or wrong IP / port for a network printer |
| Garbage characters | Printer not in ESC/POS mode, or `escpos_text` with Arabic text: use `raster` |
| Receipt too wide / cut off | Paper Width does not match the printer (58 vs 80 mm) |
| Drawer does not open | Payment mode not of type Cash; Open Cash Drawer off; cable in the printer's DK port; `browser` mode without QZ Tray |
| Label prints blank or as text | Printer language differs from the template (ZPL template on a TSPL printer); set the printer's emulation or pick a template of its language |
| Labels drift / skip one | Gap (mm) and label size do not match the roll; run the printer's own calibration (Zebra: hold feed; TSC: `~!C` / feed button) |
| Arabic name prints inverted (white on black) | The printer reads bitmap bits the other way round; note the model and report it (EPL `GW` and TSPL `BITMAP` are sent with 0 = black) |
| A4 labels off the die-cut grid | Turn off "Fit to page" / scaling in the print dialog (print at 100 %); use Download PDF for an exact sheet |

## 8. Label printers (SPEC F4)

```text
POS or desk page "POS Labels" (browser) --WebSocket--> QZ Tray --USB / LAN--> label printer (ZPL / EPL / TSPL)
                                         \--> browser print dialog / PDF --> A4 office printer (label sheets)
```

1. Install QZ Tray and the certificate as for receipts (sections 1 and 2). One QZ Tray serves both printers.
2. Create a **POS Printer Profile** with Purpose **Label**: Connection (QZ Local Printer with the QZ Printer Name,
   or Network host + port 9100) and **Label Language** (ZPL for Zebra, TSPL for TSC / Xprinter, EPL for older
   Zebra / Eltron).
3. Assign it per till (**POS Device** > Label Printer) or per profile (**POS Profile** > POS 0001 > Label Printer).
4. **POS Profile** > POS 0001: **Print Labels Role** (who may print labels; empty = POS managers only) and,
   optionally, **Default Label Template**.
5. **POS Label Template** (desk): five ship with the app and are created on install / migrate when missing:

   | Template | Language | Size |
   | --- | --- | --- |
   | Shelf Label 38x25 (ZPL) | ZPL | 38 x 25 mm, 203 dpi |
   | Product Label 50x30 (ZPL) | ZPL | 50 x 30 mm |
   | Product Label 50x30 (TSPL) | TSPL | 50 x 30 mm |
   | Product Label 50x30 (EPL) | EPL | 50 x 30 mm |
   | A4 Sheet 3x8 (PDF) | PDF | 24 labels of 70 x 37 mm per A4 sheet |

   The body is Jinja limited to values, `draw_barcode()`, `draw_arabic()`, `fit()` and `if` blocks, so the POS
   can print the same label offline; the form explains the values. Set Width / Height / DPI / Gap to the roll in
   the printer, and use a 300 dpi copy of a template for 300 dpi printers (positions are in dots).

Where to print from:

- **Till**: header **Labels** button (tag icon). Starts with the items in the cart; scan or search to add more;
  per row UOM (that UOM's barcode and price), label quantity, price override, and **Scale label** for weighed
  goods packed in store (choose a POS Scale Barcode Rule, enter the weight or amount; the EAN-13 gets a valid
  check digit). Works offline from the till's caches.
- **Desk**: page **POS Labels** (`/app/pos-labels`), and **Print Labels** on a Purchase Receipt or Stock Entry
  (rows and received quantities filled in; Stock Entry only lines with a target warehouse).

Arabic item names (`item_name_ar`) are drawn by the browser and sent as a bitmap (ZPL `^GFA`, TSPL `BITMAP`,
EPL `GW`), because label printer fonts cannot join Arabic letters. Prices on labels include VAT (the POS
Profile's tax template, or the item's own Item Tax Template).

A4 sheets: **Print A4 sheet** opens the browser print dialog (works offline); **Download PDF** makes the same
sheet on the server (WeasyPrint). Print at 100 % without "fit to page".

## 9. Barcode scanners (SPEC section 6)

Any USB or Bluetooth scanner in **HID keyboard mode** (keyboard wedge) works; no driver or QZ Tray needed.

- Set the scanner to send **Enter** (or Tab) after each code. Most scanners do this by default.
- Scans work **without clicking the search box**. When no text field has focus, the till treats keys that
  arrive at most 30 ms apart and end with Enter (at least 4 characters) as a scan. A person typing is slower
  and is ignored.
- When a text field has focus (customer search, payment amount, a note), the scan goes into that field, as
  with any keyboard. The item search box handles scans as before.
- Scans are ignored while a dialog is open (for example the payment dialog). Close it first.
- If a scanner is set to a slow "keystroke delay" (some Bluetooth models), set the delay to 0-10 ms;
  over 30 ms between characters the till cannot tell it from typing.
