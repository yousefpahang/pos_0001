// Phase 7 (SPEC section 7, section 6 UI rules): UAE tax invoice print format in desk, and the
// whole till in Arabic: RTL layout on every POS screen and dialog (nothing outside the
// screen, no sideways scrolling, no overlapping or clipped text, numbers left to right),
// Arabic item names in search, grid and cart, and the AED symbol per language.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"
import { buildReceiptModel } from "../src/plus/core/receipt.js"

const CASHIER = { usr: "cashier@pos.test", pwd: "cashier" }
const ADMIN = { usr: "Administrator", pwd: "admin" }
const PROFILE = "Main Till"
const ITEM = "ITM-00001"
const ARABIC_NAME = "مناديل فاخرة"
const BARCODE = "6290000000016" // ITM-00001
const OUT = "test-results"

const here = dirname(fileURLToPath(import.meta.url))
const AR = (() => {
	const out = {}
	const text = readFileSync(
		resolve(here, "../../pos_next/translations/ar.csv"),
		"utf8",
	)
	const re = /^"((?:[^"]|"")*)","((?:[^"]|"")*)"/
	for (const line of text.split(/\r?\n/)) {
		const m = re.exec(line)
		if (m) out[m[1].replace(/""/g, '"')] = m[2].replace(/""/g, '"')
	}
	return out
})()
/** Arabic of a POS string (falls back to the English text). */
const ar = (en) => AR[en] || en

function watchErrors(page) {
	const errors = []
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text())
	})
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`))
	page.on("response", async (res) => {
		if (res.status() >= 500) errors.push(`HTTP ${res.status()} ${res.url()}`)
	})
	return errors
}

const IGNORABLE = [
	/nexus_demo/,
	/status of 404/,
	/status of 417/,
	/status of 400/,
	/WebSocket connection to 'wss?:\/\/localhost/,
	/qz\./i,
	// POS Next's customer dialog reads Selling Settings, which cashiers may not read
	// (pre-existing, English too; see PROGRESS Phase 7).
	/status of 403/,
	/frappe\.client\.get_value PermissionError/,
]

function unexpected(errors) {
	return errors.filter((e) => !IGNORABLE.some((re) => re.test(e)))
}

async function login(page, user) {
	expect(
		(await page.request.post("/api/method/login", { data: user })).ok(),
	).toBeTruthy()
}

async function setLanguage(page, locale, fromPage = true) {
	// A session that never loaded a page has no CSRF token to check.
	const token = fromPage
		? await page.evaluate(() => window.csrf_token || "").catch(() => "")
		: ""
	const res = await page.request.post(
		"/api/method/pos_next.api.localization.change_user_language",
		{ data: { locale }, headers: { "X-Frappe-CSRF-Token": token } },
	)
	expect(res.ok(), await res.text()).toBeTruthy()
}

/** Open the till; opens a shift on the demo profile when none is open. */
async function openTill(page) {
	await page.goto("/pos")
	const search = page.locator("#item-search")
	const shiftDialog = page.getByRole("dialog").filter({
		has: page.getByText(PROFILE, { exact: true }),
	})
	await expect(search.or(shiftDialog).first()).toBeVisible({ timeout: 60_000 })
	if (!(await search.isVisible())) {
		await shiftDialog.getByText(PROFILE, { exact: true }).click()
		await shiftDialog
			.getByRole("button", { name: new RegExp(`^(Next|${ar("Next")})$`) })
			.click()
		await shiftDialog
			.getByRole("button", {
				name: new RegExp(`^(Open Shift|${ar("Open Shift")})$`),
			})
			.click()
	}
	await expect(search).toBeVisible({ timeout: 60_000 })
}

/** item_name_ar of the demo item in the till's item cache. */
async function cachedArabicName(page) {
	return page.evaluate(async (code) => {
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open("pos_next_offline")
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})
		const item = await new Promise((resolve) => {
			try {
				const req = db.transaction("items").objectStore("items").get(code)
				req.onsuccess = () => resolve(req.result || null)
				req.onerror = () => resolve(null)
			} catch {
				resolve(null)
			}
		})
		db.close()
		return item?.item_name_ar || null
	}, ITEM)
}

/**
 * Layout audit of a screen part (or the whole page): problems as text.
 * @param {import("@playwright/test").Page} page
 * @param {string|null} selector
 */
async function audit(page, selector = null) {
	return page.evaluate((sel) => {
		const issues = []
		const vw = window.innerWidth
		const vh = window.innerHeight
		const root = sel ? document.querySelector(sel) : document.body
		if (!root) return [`${sel} not found`]
		if (document.documentElement.scrollWidth > vw + 1)
			issues.push(
				`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`,
			)
		const name = (el) =>
			`${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""}.${String(
				el.className?.baseVal ?? el.className ?? "",
			)
				.split(/\s+/)
				.slice(0, 3)
				.join(".")} "${(el.innerText || "").trim().slice(0, 30)}"`
		const visible = (el) => {
			const r = el.getBoundingClientRect()
			if (r.width <= 2 || r.height <= 2) return false // also screen-reader-only text
			const s = getComputedStyle(el)
			return s.visibility !== "hidden" && Number(s.opacity) > 0.05
		}
		/** Clipped (scrolled) by an ancestor that itself is on screen. */
		const clippedByAncestor = (el) => {
			for (
				let a = el.parentElement;
				a && a !== document.body;
				a = a.parentElement
			) {
				const s = getComputedStyle(a)
				if (s.overflowX !== "visible" || s.overflowY !== "visible") {
					const r = a.getBoundingClientRect()
					if (r.left >= -1 && r.right <= vw + 1) return true
				}
			}
			return false
		}
		/** The element (or its content) is what the user sees at its own centre. */
		const onTop = (el, r) => {
			const x = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1)
			const y = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1)
			const hit = document.elementFromPoint(x, y)
			return Boolean(hit && (el.contains(hit) || hit.contains(el)))
		}
		const ownText = (el) =>
			[...el.childNodes]
				.filter((n) => n.nodeType === 3)
				.map((n) => n.textContent)
				.join("")
				.trim()
		const all = [root, ...root.querySelectorAll("*")].filter(visible)
		const texts = []
		for (const el of all) {
			const r = el.getBoundingClientRect()
			if ((r.right > vw + 1 || r.left < -1) && !clippedByAncestor(el))
				issues.push(
					`outside the screen: ${name(el)} [${Math.round(r.left)}, ${Math.round(r.right)}]`,
				)
			const text = ownText(el)
			if (!text) continue
			// Text pushed out of a box that hides overflow (cut off, no ellipsis).
			for (
				let a = el.parentElement;
				a && a !== document.body;
				a = a.parentElement
			) {
				const as = getComputedStyle(a)
				// Strips meant to scroll sideways (category chips) may hide items.
				if (/overflow-x-(auto|scroll)/.test(String(a.className))) break
				if (as.overflowX !== "visible") {
					const ar = a.getBoundingClientRect()
					if (r.left < ar.left - 2 || r.right > ar.right + 2)
						issues.push(`text outside its box: ${name(el)}`)
					break
				}
			}
			const s = getComputedStyle(el)
			if (
				["hidden", "clip"].includes(s.overflowX) &&
				s.textOverflow !== "ellipsis" &&
				el.scrollWidth > el.clientWidth + 2 &&
				s.whiteSpace === "nowrap"
			)
				issues.push(`text cut off: ${name(el)}`)
			if (
				r.bottom > 0 &&
				r.top < vh &&
				r.right > 0 &&
				r.left < vw &&
				onTop(el, r)
			)
				texts.push({ el, r })
		}
		// Text on text (labels over values, mirrored icons over words). Only text the user
		// sees: not under a dialog, a toast or outside its scroll area.
		for (let i = 0; i < texts.length; i++) {
			for (let j = i + 1; j < texts.length; j++) {
				const a = texts[i]
				const b = texts[j]
				if (a.el.contains(b.el) || b.el.contains(a.el)) continue
				const left = Math.max(a.r.left, b.r.left)
				const top = Math.max(a.r.top, b.r.top)
				const w = Math.min(a.r.right, b.r.right) - left
				const h = Math.min(a.r.bottom, b.r.bottom) - top
				if (w <= 2 || h <= 2) continue
				const area = Math.min(a.r.width * a.r.height, b.r.width * b.r.height)
				if (w * h <= area * 0.25) continue
				const hit = document.elementFromPoint(left + w / 2, top + h / 2)
				if (
					hit &&
					(a.el.contains(hit) ||
						b.el.contains(hit) ||
						hit.contains(a.el) ||
						hit.contains(b.el))
				)
					issues.push(`overlap: ${name(a.el)} / ${name(b.el)}`)
			}
		}
		return [...new Set(issues)]
	}, selector)
}

/** Audit, screenshot, and keep the problems per screen. */
async function check(page, report, screen, selector = null) {
	await page.waitForTimeout(300)
	// Let enter/leave transitions (dialogs, toasts) finish; looping ones never do.
	await page
		.waitForFunction(
			() =>
				document
					.getAnimations()
					.every(
						(a) =>
							a.playState !== "running" ||
							a.effect?.getTiming?.().iterations === Number.POSITIVE_INFINITY,
					),
			null,
			{ timeout: 5_000 },
		)
		.catch(() => {})
	const issues = await audit(page, selector)
	await page.screenshot({ path: `${OUT}/rtl-${screen}.png` })
	if (issues.length) report.push(`${screen}:\n  ${issues.join("\n  ")}`)
}

async function closeDialogs(page) {
	for (let i = 0; i < 3; i++) {
		await page.keyboard.press("Escape")
		await page.waitForTimeout(150)
	}
}

test.describe
	.serial("UAE receipt and Arabic till", () => {
		test.afterAll(async ({ browser, baseURL }) => {
			const context = await browser.newContext({ baseURL })
			const page = await context.newPage()
			await login(page, CASHIER)
			await setLanguage(page, "en", false)
			await context.close()
		})

		test("desk prints a POS sale on the bilingual UAE Tax Invoice 80mm", async ({
			page,
		}) => {
			await login(page, ADMIN)
			const res = await page.request.get("/api/resource/Sales Invoice", {
				params: {
					filters: JSON.stringify([
						["docstatus", "=", 1],
						["is_pos", "=", 1],
						["is_return", "=", 0],
					]),
					fields: JSON.stringify(["name"]),
					order_by: "creation desc",
					limit_page_length: 1,
				},
			})
			const name = (await res.json()).data[0].name
			await page.goto(
				`/printview?doctype=Sales%20Invoice&name=${encodeURIComponent(name)}&format=UAE%20Tax%20Invoice%2080mm&no_letterhead=1`,
			)
			const receipt = page.locator(".uae-receipt")
			await expect(receipt).toBeVisible({ timeout: 30_000 })
			for (const text of [
				"فاتورة ضريبية",
				"Invoice No.",
				"رقم الفاتورة",
				name,
				"Total incl. VAT",
				"الإجمالي شامل الضريبة",
				"VAT 5%",
				"ضريبة القيمة المضافة 5%",
				"TRN",
			])
				await expect(receipt).toContainText(text)
			await expect(receipt).toContainText(/AED \d+\.\d\d/)
			await receipt.screenshot({ path: `${OUT}/uae-tax-invoice-desk.png` })
		})

		test("receipt totals from the till equal ERPNext's VAT and rounding", async ({
			page,
		}) => {
			// Background-submitted sales print the browser's totals (DECISIONS item 13, Phase 6
			// decision 3). Sell a sample of carts and compare with the submitted invoices.
			test.setTimeout(300_000)
			const sent = new Map()
			let waited = 0 // sales that waited for submit_invoice (print ERPNext's own data)
			page.on("request", (req) => {
				if (req.url().includes("pos_next.api.invoices.submit_invoice")) waited++
				if (!req.url().includes("pos_0001.api.sync.submit_offline_invoice"))
					return
				let body = req.postDataJSON?.() ?? null
				if (!body) {
					try {
						body = Object.fromEntries(new URLSearchParams(req.postData() || ""))
					} catch {
						body = {}
					}
				}
				const raw = body.invoices ?? body.invoice
				const list = typeof raw === "string" ? JSON.parse(raw) : raw
				for (const inv of Array.isArray(list) ? list : [list])
					if (inv?.offline_id) sent.set(inv.offline_id, inv)
			})
			await login(page, CASHIER)
			await openTill(page)
			// Scans resolve from the till's item cache: wait until it has the demo item.
			await expect
				.poll(() => cachedArabicName(page), {
					timeout: 180_000,
					intervals: [2_000],
				})
				.toBeTruthy()
			const input = page.locator("#item-search")
			const lines = page
				.getByTestId("invoice-cart-lines")
				.getByTestId("cart-line")
			const carts = [
				[BARCODE],
				[BARCODE, BARCODE, BARCODE],
				["2012345012509"], // 1.250 kg, weight label (SPEC F5)
				["2212345009992", BARCODE], // AED 9.99 price label + an item
				["6290000000023", "2012345007505"],
			]
			for (const cart of carts) {
				for (const code of cart) {
					await input.click()
					await input.fill(code)
					await input.press("Enter")
					await page.waitForTimeout(300)
				}
				await expect(lines.first()).toBeVisible({ timeout: 15_000 })
				await page.getByRole("button", { name: "Proceed to payment" }).click()
				const dialog = page
					.getByRole("dialog")
					.filter({ hasText: "Complete Payment" })
				await expect(dialog).toBeVisible({ timeout: 15_000 })
				await dialog.getByRole("button", { name: /Cash$/ }).first().click()
				const quick = dialog
					.getByText("Quick amounts for Cash")
					.locator("xpath=following-sibling::div[1]//button")
					.first()
				await quick.click({ timeout: 15_000 }).catch(async (error) => {
					await page.screenshot({ path: `${OUT}/totals-payment-failed.png` })
					throw error
				})
				const complete = dialog
					.getByRole("button", { name: "Complete Payment" })
					.first()
				await expect(complete).toBeEnabled({ timeout: 10_000 })
				await complete.click()
				await expect(lines).toHaveCount(0, { timeout: 30_000 })
				await closeDialogs(page)
			}
			await expect
				.poll(() => sent.size + waited, { timeout: 120_000 })
				.toBe(carts.length)
			expect(sent.size).toBeGreaterThanOrEqual(3)
			const cacheRes = await page.request.get(
				"/api/method/pos_next.pos_0001.api.printing.get_printing_cache",
				{ params: { pos_profile: PROFILE } },
			)
			const cache = (await cacheRes.json()).message
			const rows = []
			for (const [offlineId, inv] of sent) {
				let name = null
				await expect
					.poll(
						async () => {
							const res = await page.request.get(
								"/api/method/pos_next.api.invoices.check_offline_invoice_synced",
								{ params: { offline_id: offlineId } },
							)
							name = (await res.json()).message?.sales_invoice || null
							return name
						},
						{ timeout: 120_000, intervals: [2_000] },
					)
					.toBeTruthy()
				const res = await page.request.get(
					`/api/method/pos_next.pos_0001.api.printing.get_receipt_data`,
					{ params: { invoice: name } },
				)
				const server = (await res.json()).message
				// The receipt the till prints for this sale (same model as the printing store).
				const model = buildReceiptModel(
					{ ...inv, name: offlineId, change_amount: null },
					{ cashModes: cache.cash_modes, rounding: cache.rounding },
				)
				rows.push({
					name,
					tillGrand: Number(inv.grand_total),
					serverGrand: server.grand_total,
					till: model.total,
					server: server.rounded_total || server.grand_total,
					tillRounding: model.roundingAdjustment,
					serverRounding: server.rounding_adjustment,
					tillChange: model.change,
					serverChange: server.change_amount,
				})
			}
			console.log("Till vs ERPNext totals:", JSON.stringify(rows))
			const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005
			for (const row of rows) {
				const why = JSON.stringify(row)
				expect(near(row.tillGrand, row.serverGrand), why).toBe(true)
				expect(near(row.till, row.server), why).toBe(true)
				expect(near(row.tillRounding, row.serverRounding), why).toBe(true)
				expect(near(row.tillChange, row.serverChange), why).toBe(true)
			}
		})

		test("every till screen in Arabic: RTL layout, Arabic names, AED sign", async ({
			page,
		}) => {
			test.setTimeout(300_000)
			const errors = watchErrors(page)
			const report = []
			await login(page, CASHIER)
			await openTill(page)
			await setLanguage(page, "ar")
			await page.reload()
			await expect(page.locator("#item-search")).toBeVisible({
				timeout: 60_000,
			})
			await expect(page.locator("html")).toHaveAttribute("dir", "rtl")
			await expect(page.locator("html")).toHaveAttribute("lang", "ar")
			// Tills cached before Phase 7 get Arabic names with the next item refresh.
			if (!(await cachedArabicName(page))) {
				await page
					.getByRole("button", { name: ar("Refresh items and customers") })
					.click()
				await expect
					.poll(() => cachedArabicName(page), {
						timeout: 180_000,
						intervals: [2_000],
					})
					.toBe(ARABIC_NAME)
			}
			await expect(
				page.locator("[data-testid=item-card], [data-testid=item-row]").first(),
			).toBeVisible({ timeout: 60_000 })
			await check(page, report, "till")

			// Arabic search finds the item by its Arabic name; grid and cart show it.
			const input = page.locator("#item-search")
			await input.click()
			// The search index is rebuilt after the item cache sync finishes.
			await expect
				.poll(
					async () => {
						await input.fill("")
						await input.fill("مناديل")
						return page
							.locator("[data-testid=item-card], [data-testid=item-row]")
							.filter({ hasText: ARABIC_NAME })
							.first()
							.isVisible({ timeout: 3_000 })
							.catch(() => false)
					},
					{ timeout: 240_000, intervals: [3_000] },
				)
				.toBe(true)
			await check(page, report, "search-arabic")
			await input.fill(BARCODE)
			await input.press("Enter")
			const lines = page
				.getByTestId("invoice-cart-lines")
				.getByTestId("cart-line")
			await expect(lines).toHaveCount(1, { timeout: 15_000 })
			await expect(lines.first()).toContainText(ARABIC_NAME)
			// AED in Arabic is "د.إ"; amounts keep Western digits.
			await expect(page.getByTestId("invoice-cart-lines")).toContainText("د.إ")
			await expect(page.getByTestId("invoice-cart-lines")).toContainText(
				/\d+\.\d\d/,
			)
			await check(page, report, "cart")

			await page.getByTestId("sales-person-toggle").click()
			await expect(page.getByTestId("sales-person-panel")).toBeVisible()
			await check(page, report, "sales-person")
			await closeDialogs(page)

			await page.keyboard.press("F4")
			const pay = page.getByRole("dialog").last()
			await expect(pay).toBeVisible({ timeout: 15_000 })
			await check(page, report, "payment")
			await closeDialogs(page)

			// Customer: edit dialog, then the inline search with its result list.
			await page.getByTitle(ar("Edit customer details")).first().click()
			await expect(page.getByRole("dialog").last()).toBeVisible({
				timeout: 15_000,
			})
			await check(page, report, "customer-edit")
			await closeDialogs(page)
			await page.getByTitle(ar("Remove customer")).first().click()
			const customerSearch = page.locator("#cart-customer-search")
			await expect(customerSearch).toBeVisible({ timeout: 10_000 })
			await page.keyboard.press("F3")
			await customerSearch.fill("Gulf")
			await expect(page.getByText("Gulf Office Supplies").first()).toBeVisible({
				timeout: 15_000,
			})
			await check(page, report, "customer-search")
			await page.getByText("Gulf Office Supplies").first().click()
			await expect(customerSearch).toBeHidden({ timeout: 10_000 })

			await page.keyboard.press("F8")
			await expect(page.getByTestId("hold-cart-dialog")).toBeVisible({
				timeout: 15_000,
			})
			await check(page, report, "hold")
			await closeDialogs(page)

			await page.getByTestId("sync-badge").click()
			await expect(page.getByTestId("sync-log-panel")).toBeVisible()
			await check(page, report, "sync-panel")
			await closeDialogs(page)

			await page.getByTestId("label-button").click()
			await expect(page.getByTestId("label-panel")).toBeVisible({
				timeout: 15_000,
			})
			await check(page, report, "labels")
			await closeDialogs(page)

			await page.locator("body").click({ position: { x: 5, y: 300 } })
			await page.keyboard.press("?")
			await expect(page.getByTestId("shortcuts-overlay")).toBeVisible()
			await check(page, report, "shortcuts")
			await closeDialogs(page)

			// Header user menu and every screen it opens.
			const menuEntries = [
				["View Shift", "view-shift"],
				["Draft Invoices", "held-carts"],
				["Invoice History", "invoice-history"],
				["Offline Invoices", "offline-invoices"],
				["Return Invoice", "return-invoice"],
				["Close Shift", "close-shift"],
			]
			for (const [label, screen] of menuEntries) {
				const menuButton = page.getByRole("button", { name: /Demo Cashier/ })
				const viewShift = page.getByText(ar("View Shift"), { exact: true })
				await menuButton.click()
				if (!(await viewShift.isVisible())) await menuButton.click()
				await expect(viewShift).toBeVisible()
				const entry = page.getByText(ar(label), { exact: true }).first()
				// Some entries show only when relevant (Offline Invoices: queued sales).
				if (!(await entry.isVisible())) {
					await menuButton.click()
					continue
				}
				if (screen === "view-shift") {
					await check(page, report, "user-menu")
					// AGPL source offer (SPEC section 2): version and source link in the menu.
					const about = page.getByTestId("about-source-menu")
					await expect(about).toBeVisible()
					await expect(about).toContainText(ar("About / Source code"))
					await expect(about).toContainText("1.0.0")
					await expect(about).toHaveAttribute("href", /^https?:\/\//)
				}
				await entry.click()
				await expect(page.getByRole("dialog").last()).toBeVisible({
					timeout: 15_000,
				})
				await check(page, report, screen)
				await closeDialogs(page)
			}

			// The smallest supported till screen (SPEC section 6: 1024 x 768).
			await page.setViewportSize({ width: 1024, height: 768 })
			await check(page, report, "till-1024")
			await page.keyboard.press("F4")
			await expect(page.getByRole("dialog").last()).toBeVisible({
				timeout: 15_000,
			})
			await check(page, report, "payment-1024")
			await closeDialogs(page)

			// Cart back to empty for the next tests.
			await lines.first().hover()
			await page.keyboard.press("Delete")

			if (report.length) console.log(`RTL problems:\n${report.join("\n")}`)
			expect(report, report.join("\n")).toEqual([])
			const bad = unexpected(errors)
			expect(bad, bad.join("\n")).toEqual([])
		})
	})
