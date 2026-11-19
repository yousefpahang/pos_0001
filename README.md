# POS 0001

Branded point of sale for ERPNext, built for UAE retail. POS 0001 (repository `pos_0001`) is a fork of
[POS Next](https://github.com/BrainWise-DEV/POSNext) by BrainWise with printing features ported from
[POS Awesome](https://github.com/defendicon/POS-Awesome-V15). License: AGPL-3.0 (see [NOTICE.md](NOTICE.md)).

Release **1.0.0** (pos_0001), based on POS Next 1.17.0. Changes: [CHANGELOG.md](CHANGELOG.md).

The app keeps POS Next's names (app and Python package `pos_next`, URL `/pos`) so upstream merges stay cheap.
Everything this fork adds lives in `pos_next/pos_0001/` (server) and `POS/src/plus/` (browser).

## What it adds to POS Next

| | Feature |
| --- | --- |
| F1 / F12 | Offline selling hardened: a rejected offline invoice is stored on the server (Offline Invoice Sync, status Failed, payload and error) with Retry in the till and in desk; sync badge and sync log panel; batch sync |
| F2 / F3 | Barcode scans resolve in the browser first, so scanning works offline; 20,000-item search index in a Web Worker; virtual grid; favourites; scans caught with no field focused |
| F4 | Label printing: ZPL, EPL, TSPL raw through QZ Tray, or an A4 PDF grid; Arabic as bitmap; from the till, the desk page `pos-labels`, Purchase Receipt and Stock Entry |
| F5 | Scale barcodes (weight or price in the barcode), doctype **POS Scale Barcode Rule**, parsed offline and checked again on the server |
| F6 | Sales person Off / Optional / Mandatory per POS Profile, default per cashier, badge scan, several sales persons per sale, report **Sales Person Commission** |
| F7 | Held carts saved on the server, resumable on any till of the same POS Profile; kept on the till while offline |
| F9 | Receipts through QZ Tray: raster (Arabic and logos on any ESC/POS printer), ESC/POS text, QZ HTML or browser; cut, copies, cash drawer, No Sale, F9 reprint, receipt barcode |
| F10 / F11 | Bilingual UAE tax invoice (print format **UAE Tax Invoice 80mm**, credit note variant), AED formatting, Arabic item names, RTL checked on every till screen |
| F13 | **Item Wizard** at `/pos/items/new`: buy in bags, sell by kg, gram, packs or the whole bag, in one step; CSV import; gram entry on Kg cart lines |

Full requirements: [docs/SPEC.md](docs/SPEC.md) and [docs/DECISIONS.md](docs/DECISIONS.md). Status per phase:
[docs/PROGRESS.md](docs/PROGRESS.md).

## Requirements

- Frappe and ERPNext **v15** (branch `version-15`). Version 16 is a target but has not been tested yet (see
  docs/PROGRESS.md, Phase 9).
- Python 3.10 or newer, MariaDB 10.6 or newer, Redis.
- **Node.js 22** on the server that builds the assets. The committed `yarn.lock` files need it; Node 20 fails on
  `nopt@10`.
- For A4 PDF labels: the system libraries of WeasyPrint (Pango; WeasyPrint itself comes with Frappe). For Arabic
  text on thermal labels printed from desk: libraqm, used by Pillow (also part of Frappe).
- On each till: Chrome or Edge, and [QZ Tray](https://qz.io/download/) when it prints to receipt or label printers.

## Install

```bash
cd ~/frappe-bench
bench get-app https://github.com/yousefpahang/pos_0001 --branch version-15
bench --site your-site install-app pos_next
bench --site your-site migrate
bench build --app pos_next
bench restart            # production only
```

Install ERPNext and run its setup wizard (company, currency AED, UAE VAT template) first. `install-app` and every
`migrate` create the default label templates, the four Item Wizard presets, the role "POS Item Wizard" and the
"POS 0001" workspace. Existing records are never overwritten.

Demo data for a test site only (one company, VAT 5%, two POS Profiles, 20,000 items, 50 weighed items, sales
persons, a cashier `cashier@pos.test` / `cashier`):

```bash
bench --site your-test-site execute pos_next.pos_0001.demo.seed.run
```

## Configure

1. **POS Profile** (desk): company, warehouse, price list, VAT template, payment modes, and the users of the till
   in the POS Profile User table. Only listed users (and POS managers) can sell on, sync to or read a profile.
2. **POS Settings** (POS Next, one per POS Profile): sales person mode, credit and partial sales, silent print,
   allowed languages (add Arabic for an Arabic till).
3. **POS Profile, POS 0001 fields**: Sales person mode (Off / Optional / Mandatory), receipt printer, label
   printer and label role, receipt title (Tax Invoice / Simplified / Auto), receipt footer and logo.
4. **POS 0001 Settings** (desk, single): offline negative stock rule, cache refresh minutes, held cart retention
   days, AED symbol, internal barcode prefix, next scale PLU, and **Source Code URL**: the link the till's
   "About / Source code" menu entry opens. Set it to the repository of the exact version you run (AGPL-3.0).
5. **Company**: TRN (Tax ID) and address, printed on the tax invoice.
6. **Users**: default sales person per cashier (User field "Default POS Sales Person"); role "POS Item Wizard" for managers who
   create items.
7. **Scale barcodes**: one **POS Scale Barcode Rule** per label format of the shop's scales (prefix, positions,
   weight or price, check digit). Items sold on the scale need `scale_plu` (the wizard assigns it).

Open the till at `https://your-site/pos`.

## Hardware

Receipt printers, label printers, the cash drawer, scales and scanners: see [docs/HARDWARE.md](docs/HARDWARE.md).
In short:

1. Install QZ Tray on each till.
2. As System Manager, create the QZ certificate once (POS Next's `setup_qz_certificate`; the key stays in the
   site's `private/qz/` folder) and install it on every till, so prints need no confirmation.
3. Create a **POS Printer Profile** per printer (receipt or label, local or network, print mode, paper width,
   cut, copies, drawer kick) and link it from the **POS Device** record of the till or from the POS Profile.
4. Scanners: any USB or Bluetooth keyboard-wedge scanner; no setup.

## Tests

```bash
cd ~/frappe-bench
bench setup requirements --dev          # once per bench: Frappe's test packages (freezegun, ...)
bench --site your-test-site set-config allow_tests true
bench --site your-test-site run-tests --app pos_next
bench --site your-test-site run-tests --module pos_next.test_promotions
bench --site your-test-site run-tests --module pos_next.test_packed_items_regression
cd apps/pos_next/POS
yarn test:run      # Vitest
yarn e2e           # Playwright, needs the site running at http://localhost:8001
```

Run the tests on a test site only. pos_next's `before_tests` hook (`pos_next/pos_0001/tests/setup.py`) runs
ERPNext's `before_tests` (which deletes every Item Price), completes the setup wizard with the demo company
"Demo Trading LLC" on a site without a company, and creates the small demo data set the tests use (POS
Profiles "Main Till" / "Express Till", "UAE VAT 5% - DTL", scale barcode rules, test items, prices, stock). A
freshly created site needs no other step. `--skip-test-records` still works and is faster on a site that has
not built ERPNext's "_Test Company" records yet. Frappe v15's runner skips test files at the package root, hence the two
`--module` lines.

`yarn e2e` runs against the demo data (`pos_next.pos_0001.demo.seed`) and needs the whole `bench start` stack
(web, Socket.IO, Redis, worker). Repeated runs sell the same demo items: before a run, rebuild prices after any
Python test run and top up stock:

```bash
bench --site your-test-site execute pos_next.pos_0001.demo.seed.ensure_item_prices
bench --site your-test-site execute pos_next.pos_0001.demo.seed.restock
```

## Updating

```bash
cd ~/frappe-bench/apps/pos_next
git pull origin version-15
cd ../..
bench --site your-site migrate
bench build --app pos_next
bench restart            # production only
```

Merging a new POS Next release into this fork: [docs/UPGRADING_UPSTREAM.md](docs/UPGRADING_UPSTREAM.md).

---

The rest of this file is POS Next's own README, kept unchanged so upstream merges stay easy. Where it differs
from the sections above (install URL, shortcuts), the sections above apply to POS 0001.

# POS Next

<div align="center">

![POS Next Banner](docs/screenshots/01-main-dashboard.png)

**A modern, lightning-fast Point of Sale system for ERPNext**

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![Frappe Version](https://img.shields.io/badge/Frappe-v15+-orange.svg)](https://github.com/frappe/frappe)
[![ERPNext Version](https://img.shields.io/badge/ERPNext-v15+-green.svg)](https://github.com/frappe/erpnext)

[Features](#-features) • [Installation](#-installation) • [Quick Start](#-quick-start) • [Demo](#-demo) • [Documentation](#-documentation)

</div>

---

## Branches

| Branch | Stability | Purpose |
|--------|-----------|---------|
| [`version-15`](https://github.com/BrainWise-DEV/POSNext/tree/version-15) | **Stable** | Production-ready release for Frappe/ERPNext v15 |
| [`develop`](https://github.com/BrainWise-DEV/POSNext/tree/develop) | **Unstable** | Active development — may contain breaking changes |

> For production use, always install from the `version-15` branch.

---

## 🎯 Why POS Next?

POS Next is a **complete rewrite** of the ERPNext POS system, built from the ground up with modern technologies to deliver:

- ⚡ **Blazing Fast Performance** - Vue 3 + Vite for instant load times
- 🔄 **True Offline Support** - Keep selling even when your internet drops
- 💎 **Modern UI/UX** - Clean, intuitive interface your staff will love
- 🎁 **Advanced Promotions** - Full-featured offers, coupons, and gift cards
- 💰 **Smart Payments** - Multiple payment methods, partial payments, split bills
- 📊 **Real-time Insights** - Live shift tracking and instant reports

## 📸 See It In Action

### Complete Sales Cycle

![Sales Cycle Demo](docs/screenshots/sales-cycle.gif)

## 📞 Support & Community

- 🐛 **Bug Reports**: [GitHub Issues](https://github.com/BrainWise-DEV/pos_next/issues)
- 💬 **Discussions**: [GitHub Discussions](https://github.com/BrainWise-DEV/pos_next/discussions)
- 📖 **Forum**: [Frappe Community](https://discuss.frappe.io/)
- 📱 **Telegram Group**: [Join our community](https://t.me/+J2WHnNKCn8ZhOWQ0) - Get help, share ideas, and connect with other users
- 📧 **Email**: support@brainwise.me

### Key Features

<table>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/02-cart-with-items.png" alt="Shopping Cart"/>
      <p align="center"><b>Intuitive Shopping Cart</b><br/>Add items instantly with barcode scanning or search</p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/04-payment-dialog.png" alt="Payment Processing"/>
      <p align="center"><b>Smart Payment Processing</b><br/>Multiple payment methods, quick amounts, partial payments</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/03-offers-dialog.png" alt="Promotional Offers"/>
      <p align="center"><b>Promotional Schemes</b><br/>Buy X Get Y, discounts, bundle offers, and more</p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/06-settings.png" alt="Settings"/>
      <p align="center"><b>Comprehensive Settings</b><br/>Flexible configuration for every business need</p>
    </td>
  </tr>
</table>

## ✨ Features

### Core Functionality

- 🚀 **Modern Tech Stack**
  - Vue 3 with Composition API
  - Vite for lightning-fast builds
  - Tailwind CSS for beautiful UI
  - TypeScript-ready architecture

- 🔄 **Offline-First Architecture**
  - IndexedDB for local data caching
  - Background sync when online
  - Web Workers for smooth performance
  - Service Worker for true PWA support

- 💰 **Advanced Payment Options**
  - Multiple payment methods per transaction
  - Partial payments with tracking
  - Quick amount buttons for faster checkout
  - Change calculation and write-off
  - Credit sale support with approval

- 🎁 **Promotional Engine**
  - **Coupons**: Percentage, fixed amount, free items
  - **Promotional Schemes**: Buy X Get Y, tiered discounts
  - **Gift Cards**: Full gift card management
  - Auto-apply eligible offers
  - Stack multiple promotions

- 💱 **Multi-Currency Support**
  - Proper currency symbols (E£, ر.س, د.إ, $, €, £)
  - Real-time exchange rates
  - Currency-specific formatting

- 💾 **Draft Invoices (Hold Orders)**
  - Save incomplete transactions
  - Resume from any device
  - Automatic cleanup
  - Badge count indicator

- 🔄 **Returns Management**
  - Quick return invoice processing
  - Partial or full returns
  - Auto-credit note generation
  - Stock adjustment

- 💼 **Shift Management**
  - Open/close shift workflow
  - Live shift timer in navbar
  - Shift-wise sales reports
  - Cash reconciliation

- 🔍 **Smart Search**
  - Real-time item search
  - Barcode scanning support
  - Item group filtering
  - Keyboard shortcuts (F4, F8, F9)

- 📱 **Responsive Design**
  - Desktop optimized
  - Tablet friendly
  - Touch-screen ready
  - Grid and list views

### Technical Features

- 🔥 **Performance Optimized**
  - Virtual scrolling for large inventories
  - Lazy loading components
  - Debounced search
  - Optimistic UI updates

- 🔒 **Enterprise Ready**
  - Role-based permissions
  - Audit trail logging
  - Multi-warehouse support
  - Tax compliance ready

- 🌐 **Internationalization**
  - RTL support ready
  - Multi-language capable
  - Regional formats

## 📋 Prerequisites

- **Frappe Framework** version 15 or higher
- **ERPNext** version 15 or higher
- **Node.js 22** on the server that builds assets (the committed `yarn.lock` files need it; Node 20 fails on `nopt@10`)
- Modern browser (Chrome, Firefox, Safari, Edge)

## 🚀 Installation

### Fresh Installation

```bash
# Navigate to your bench
cd ~/frappe-bench

# Get the app from GitHub
bench get-app https://github.com/BrainWise-DEV/pos_next.git --branch version-15

# Install on your site
bench --site [your-site-name] install-app pos_next

# Run migrations
bench --site [your-site-name] migrate

# Build assets
bench build --app pos_next

# Restart (production only)
bench restart
```

### Development Setup

```bash
# Get app in dev mode
cd ~/frappe-bench
bench get-app /path/to/pos_next

# Install frontend dependencies
cd apps/pos_next/POS
npm install

# Run dev server with hot reload
npm run dev

# In another terminal, start Frappe
bench start
```

## 🔄 Updating

Already have POS Next? Update to the latest version:

```bash
cd ~/frappe-bench/apps/pos_next
git pull origin version-15
cd ../..

# Apply updates
bench --site [your-site-name] migrate
bench build --app pos_next
bench --site [your-site-name] clear-cache

# Restart (production only - skip if using bench start)
bench restart
```

## 🎯 Quick Start

### 1. Setup POS Profile

Navigate to: **Retail > POS Profile > New**

Configure:
- Company and Warehouse
- Price List and Currency
- Payment Methods (Cash, Card, etc.)
- Default Customer (Walk-In)

### 2. Access POS

Visit: `https://your-site.com/pos` or `http://localhost:8000/pos`

### 3. Make Your First Sale

1. **Search Items** - Press `F4` or scan barcode
2. **Add to Cart** - Click items or use auto-add mode
3. **Select Customer** - Press `F8` (optional)
4. **Apply Offers** - Green button shows available offers
5. **Checkout** - Press `F9`, select payment method
6. **Print** - Receipt prints automatically

### Optional: Create Promotional Offers

**POS Offer**: `POS Next > POS Offer > New`
**POS Coupon**: `POS Next > POS Coupon > New`

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `F4` | Search items |
| `F8` | Search customers |
| `F9` | Proceed to checkout |
| `Ctrl+S` | Save draft (hold order) |
| `Esc` | Close dialog |

## 🎨 Feature Highlights

### Offline Mode

Never lose a sale! POS Next works seamlessly even without internet:
- All item data cached locally
- Stock levels synced in background
- Invoices saved and uploaded when online
- Visual indicator shows connection status

### Smart Offers Engine

Maximize revenue with sophisticated promotions:
- **Buy 2 Get 1 Free** - Product-based offers
- **Spend $100, Get 10% Off** - Value-based discounts
- **Seasonal Coupons** - Time-limited promotions
- **Free Shipping** - Threshold-based benefits

### Shift Management

Complete shift lifecycle:
- Open shift to start selling
- Live timer shows shift duration
- Close shift for reconciliation
- Detailed shift reports with cash movements

## 💱 Currency Support

Display prices in proper local format:
- **Egypt**: E£ (EGP)
- **Saudi Arabia**: ر.س (SAR)
- **UAE**: د.إ (AED)
- **US**: $ (USD)
- **Europe**: € (EUR)
- **UK**: £ (GBP)
- And many more...

## 🔧 Configuration

### Stock Settings

- **Warehouse Selection**: Choose active warehouse
- **Negative Stock**: Allow overselling
- **Auto Sync**: Background stock updates
- **Stock Policy**: Validation rules

### Pricing & Discounts

- **Tax Inclusive**: Prices include tax
- **Max Discount**: Item-level limits
- **Additional Discount**: Invoice-level
- **Rounded Totals**: Exact or rounded

### Sales Operations

- **Credit Sales**: Allow payment terms
- **Partial Payments**: Split over multiple methods
- **Returns**: Enable return processing
- **Write-off**: Small change amounts
- **Silent Print**: Auto-print receipts

## 🛠️ Troubleshooting

### Items Not Loading

**Check:**
1. Items exist in selected warehouse
2. Price list has item prices defined
3. POS Profile warehouse setting
4. Browser console for errors

**Solution:** Clear cache and reload
```bash
bench --site [your-site-name] clear-cache
```

### Offline Mode Not Working

**Check:**
1. Service Worker registered
2. IndexedDB enabled in browser
3. Sufficient storage available

**Solution:** Check browser console, ensure HTTPS (required for Service Workers)

### Close Shift Not Working

**Status:** Fixed in v1.6.0+

**Solution:** Update to latest version

## 🏗️ Build for Production

```bash
cd apps/pos_next/POS
npm run build
bench build --app pos_next
bench restart
```

## 🔌 API Reference

### Get Available Offers

```python
frappe.call({
    method: 'pos_next.api.offers.get_offers',
    args: {
        pos_profile: 'Main POS',
        customer: 'CUST-00001'
    },
    callback: (r) => console.log(r.message)
})
```

### Validate Coupon

```python
frappe.call({
    method: 'pos_next.api.offers.validate_coupon',
    args: {
        coupon_code: 'SUMMER2024',
        customer: 'CUST-00001',
        company: 'My Company',
        grand_total: 1000
    },
    callback: (r) => console.log(r.message)
})
```

### Create Invoice

```python
frappe.call({
    method: 'pos_next.api.invoices.create_invoice',
    args: {
        invoice_data: {
            customer: 'CUST-00001',
            items: [
                { item_code: 'ITEM-001', qty: 2, rate: 100 }
            ],
            payments: [
                { mode_of_payment: 'Cash', amount: 200 }
            ]
        }
    },
    callback: (r) => console.log(r.message)
})
```

## 🤝 Contributing

We welcome contributions! Here's how:

1. **Fork** the repository
2. **Create** a feature branch: `git checkout -b feature/amazing-feature`
3. **Install** pre-commit hooks: `cd apps/pos_next && pre-commit install`
4. **Make** your changes
5. **Test** thoroughly
6. **Commit** with clear messages
7. **Push** to your fork
8. **Open** a Pull Request

### Code Quality

We use automated tools to maintain code quality:
- **Python**: ruff, pyupgrade
- **JavaScript**: eslint, prettier
- **Git**: pre-commit hooks

## 📄 License

AGPL-3.0 License - See [LICENSE](LICENSE) file for details

This means you can:
- ✅ Use commercially
- ✅ Modify
- ✅ Distribute
- ✅ Use privately

You must:
- 📋 Disclose source
- 📋 Include license
- 📋 State changes
- 📋 Share alike

## 🙏 Credits & Technology

Built with amazing open-source technologies:

- [Frappe Framework](https://frappeframework.com/) - Full-stack web framework
- [ERPNext](https://erpnext.com/) - Open-source ERP
- [Vue.js 3](https://vuejs.org/) - Progressive JavaScript framework
- [Vite](https://vitejs.dev/) - Next-generation frontend tooling
- [Tailwind CSS](https://tailwindcss.com/) - Utility-first CSS framework
- [Heroicons](https://heroicons.com/) - Beautiful hand-crafted SVG icons

## 📝 Changelog

### v1.6.1 (Latest)
- Enhanced partial payments with overdue status tracking
- Major backend refactoring for better maintainability
- Performance improvements

### v1.6.0
- ✨ Implemented free items support for promotional offers
- 🐛 Fixed tax-inclusive calculation preventing tax being treated as discount
- 🔧 Improved promotional scheme handling

### v1.0.0
- 🎉 Initial release
- ✨ Modern Vue 3 interface
- 🔄 Offline-first architecture
- 💰 Multi-currency support
- 🎁 Coupon and offer system
- 💾 Draft invoice management

## 🎯 Roadmap

Coming soon:

- [ ] 🍽️ **Restaurant Mode** - Table management, kitchen display
- [ ] 📱 **Mobile App** - Native iOS and Android apps
- [ ] 📊 **Advanced Analytics** - Sales insights, trends, forecasting
- [ ] 🎯 **Loyalty Program** - Points, rewards, membership tiers
- [ ] 📦 **Quick Restock** - Low stock alerts, auto-ordering
- [ ] 🖨️ **Receipt Customization** - Custom templates, branding
- [ ] 🔗 **Integration Hub** - Payment gateways, accounting software
- [ ] 👥 **Customer Display** - Facing display for customers

---

<div align="center">

**Made with ❤️ by [BrainWise](https://nexus.brainwise.me)**

⭐ Star us on GitHub — it motivates us a lot!

[Report Bug](https://github.com/BrainWise-DEV/pos_next/issues) • [Request Feature](https://github.com/BrainWise-DEV/pos_next/issues) • [Documentation](https://github.com/BrainWise-DEV/pos_next/wiki)

</div>
