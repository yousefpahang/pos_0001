// pos_0001 Phase 6: benchmark for the SPEC section 6 targets on the dev site (20,000 items).
//
//   cd POS && PERF_LABEL=after yarn perf          # all targets, writes test-results/perf-after.json
//   PERF_SYNC_COUNT=0 yarn perf                   # skip the 500-invoice sync (creates invoices)
//   PERF_ASSERT=1 yarn perf                       # fail when a target is missed
//
// Times are taken inside the page with performance.now() where possible, so Playwright's own
// round trips are not counted. Results are medians of several runs. Docs: docs/PERFORMANCE.md.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, request, test } from "@playwright/test"
import { PERF_PROFILE, syncInvoice } from "./syncPayload.js"

const CASHIER = { usr: "cashier@pos.test", pwd: "cashier" }
const ADMIN = { usr: "Administrator", pwd: "admin" }
const PROFILE = PERF_PROFILE
const PRINTER = "Perf Receipt Raster"
// Options come from the environment, or from <tmp>/pos0001-perf-options.json
// (e.g. {"PERF_LABEL": "before", "PERF_SYNC_COUNT": 0}) where setting variables is awkward.
// (Not in test-results/: Playwright empties that folder when a run starts.)
const FILE_OPTIONS = (() => {
	try {
		return JSON.parse(
			fs.readFileSync(
				path.join(os.tmpdir(), "pos0001-perf-options.json"),
				"utf8",
			),
		)
	} catch {
		return {}
	}
})()
const opt = (name, fallback) =>
	process.env[name] ?? FILE_OPTIONS[name] ?? fallback
const ITEM_COUNT = Number(opt("PERF_ITEM_COUNT", 20000))
const SYNC_COUNT = Number(opt("PERF_SYNC_COUNT", 500))
const LABEL = String(opt("PERF_LABEL", "run"))
const ASSERT = String(opt("PERF_ASSERT", "0")) === "1"
// DECISIONS item 14: send the till's /api calls to another server (e.g. the multi-worker
// gunicorn at http://127.0.0.1:8002) while the page and its assets still come from baseURL.
const API_URL = String(opt("PERF_API_URL", "")).replace(/\/$/, "")
const API_SITE = String(opt("PERF_API_SITE", "pos.test"))

const TARGETS = {
	initial_cache_ms: 60_000,
	reopen_ms: 3_000,
	search_first_results_ms: 100,
	scan_to_cart_ms: 150,
	scale_scan_to_cart_ms: 150,
	global_scan_to_cart_ms: 150,
	submit_offline_ms: 50,
	pay_to_print_ms: 1_000,
	sync_500_ms: 5 * 60_000,
}

const results = {
	label: LABEL,
	at: new Date().toISOString(),
	items: ITEM_COUNT,
	metrics: {},
	notes: {},
}

/** Demo item barcode (seed: EAN-13 of "629" + 9-digit item number). */
function ean(n) {
	const body = `629${String(n).padStart(9, "0")}`
	const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0)
	return `${body}${(10 - (sum % 10)) % 10}`
}

function median(values) {
	const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
	if (!v.length) return null
	const mid = Math.floor(v.length / 2)
	return Math.round(v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2)
}

function record(name, value, note) {
	results.metrics[name] = value
	if (note) results.notes[name] = note
	console.log(
		`[perf] ${name}: ${value} ms (target ${TARGETS[name]} ms)${note ? ` - ${note}` : ""}`,
	)
	save()
}

const OUT_DIR = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"test-results",
)

function save() {
	fs.mkdirSync(OUT_DIR, { recursive: true })
	fs.writeFileSync(
		path.join(OUT_DIR, `perf-${LABEL}.json`),
		`${JSON.stringify(results, null, 2)}\n`,
	)
}

async function admin(baseURL) {
	const ctx = await request.newContext({ baseURL })
	expect(
		(await ctx.post("/api/method/login", { data: ADMIN })).ok(),
	).toBeTruthy()
	return ctx
}

async function setProfilePrinter(baseURL, printer) {
	const ctx = await admin(baseURL)
	if (printer) {
		const exists = await ctx.get(
			`/api/resource/POS Printer Profile/${encodeURIComponent(PRINTER)}`,
		)
		if (!exists.ok()) {
			const res = await ctx.post("/api/resource/POS Printer Profile", {
				data: {
					printer_name: PRINTER,
					purpose: "Receipt",
					connection: "QZ Local Printer",
					qz_printer: "Fake Receipt",
					print_mode: "raster",
					paper_width_mm: "80",
					auto_cut: 1,
					copies: 1,
					drawer_kick: 1,
					receipt_barcode: "Code128",
				},
			})
			expect(res.ok(), await res.text()).toBeTruthy()
		}
	}
	const res = await ctx.put(
		`/api/resource/POS Profile/${encodeURIComponent(PROFILE)}`,
		{
			data: { pos0001_receipt_printer: printer || null },
		},
	)
	expect(res.ok(), await res.text()).toBeTruthy()
	await ctx.dispose()
}

/** Fake QZ Tray (same as e2e/receipt-printing.spec.js): records when a print job arrives. */
async function fakeQz(context) {
	const jobs = []
	await context.routeWebSocket(/localhost:818[12]/, (ws) => {
		ws.onMessage((message) => {
			if (message === "ping") return
			let msg
			try {
				msg = JSON.parse(message)
			} catch {
				return
			}
			if (!msg.uid) return
			let result = null
			if (msg.call === "getVersion") result = "2.2.5"
			else if (msg.call === "printers.find") result = ["Fake Receipt"]
			else if (msg.call === "print") jobs.push({ at: Date.now() })
			ws.send(JSON.stringify({ uid: msg.uid, result }))
		})
	})
	return jobs
}

/**
 * Forward the page's /api requests to API_URL (same site and session: both servers share
 * the database and Redis). No-op when PERF_API_URL is not set.
 */
async function routeApi(context) {
	if (!API_URL) return
	await context.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const req = route.request()
			const url = new URL(req.url())
			const headers = {
				...(await req.allHeaders()),
				"x-frappe-site-name": API_SITE,
			}
			delete headers.host
			try {
				const response = await route.fetch({
					url: `${API_URL}${url.pathname}${url.search}`,
					headers,
					timeout: 120_000,
				})
				await route.fulfill({ response })
			} catch {
				await route.abort().catch(() => {})
			}
		},
	)
}

async function openTill(page) {
	await page.goto("/pos")
	const openShiftDialog = page
		.getByRole("dialog")
		.filter({ hasText: "Open POS Shift" })
	const shiftOpen = page.getByText("Shift Open:")
	await expect(openShiftDialog.or(shiftOpen).first()).toBeVisible({
		timeout: 60_000,
	})
	if (!(await shiftOpen.isVisible())) {
		await openShiftDialog.getByText(PROFILE, { exact: true }).click()
		await openShiftDialog
			.getByRole("button", { name: "Next", exact: true })
			.click()
		await openShiftDialog
			.getByRole("button", { name: "Open Shift", exact: true })
			.click()
	}
	await expect(shiftOpen).toBeVisible({ timeout: 60_000 })
}

/** Number of items in POS Next's IndexedDB item cache. */
async function cachedItemCount(page) {
	return page.evaluate(async () => {
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open("pos_next_offline")
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})
		const count = await new Promise((resolve) => {
			try {
				const req = db.transaction("items").objectStore("items").count()
				req.onsuccess = () => resolve(req.result)
				req.onerror = () => resolve(0)
			} catch {
				resolve(0)
			}
		})
		db.close()
		return count
	})
}

// Item cards (grid view) or item rows (list view). Before Phase 6 they had no test ids; the
// cart's quick-action buttons also sit in a .grid, so only <div> cards and <tr> rows count.
const ITEM_CARD =
	'[data-testid="item-card"], [data-testid="item-row"], div.grid > div.group, tbody > tr.group'
const CART_LINE = '[data-testid="invoice-cart-lines"] [data-testid="cart-line"]'

/**
 * Put `term` in the search box in one go (like a paste or the last keystroke) and time until a
 * card containing `expectText` is on screen.
 */
async function timeSearch(page, term, expectText) {
	return page.evaluate(
		async ({ term, expectText, ITEM_CARD }) => {
			const input = document.querySelector("#item-search")
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			).set
			setter.call(input, "")
			input.dispatchEvent(new Event("input", { bubbles: true }))
			await new Promise((r) => setTimeout(r, 400))
			const start = performance.now()
			setter.call(input, term)
			input.dispatchEvent(new Event("input", { bubbles: true }))
			return new Promise((resolve) => {
				const deadline = start + 5000
				const check = () => {
					const cards = document.querySelectorAll(ITEM_CARD)
					for (const card of cards) {
						if (card.textContent.includes(expectText)) {
							resolve(performance.now() - start)
							return
						}
					}
					if (performance.now() > deadline) resolve(null)
					else requestAnimationFrame(check)
				}
				check()
			})
		},
		{ term, expectText, ITEM_CARD },
	)
}

/** Scan through the focused search box: value + Enter, time until the cart has one more line. */
async function timeFieldScan(page, code) {
	return page.evaluate(
		async ({ code, CART_LINE }) => {
			const input = document.querySelector("#item-search")
			input.focus()
			const before = document.querySelectorAll(CART_LINE).length
			const setter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			).set
			const start = performance.now()
			setter.call(input, code)
			input.dispatchEvent(new Event("input", { bubbles: true }))
			input.dispatchEvent(
				new KeyboardEvent("keydown", {
					key: "Enter",
					code: "Enter",
					bubbles: true,
				}),
			)
			input.dispatchEvent(
				new KeyboardEvent("keyup", {
					key: "Enter",
					code: "Enter",
					bubbles: true,
				}),
			)
			return new Promise((resolve) => {
				const deadline = start + 5000
				const check = () => {
					if (document.querySelectorAll(CART_LINE).length > before)
						resolve(performance.now() - start)
					else if (performance.now() > deadline) resolve(null)
					else requestAnimationFrame(check)
				}
				check()
			})
		},
		{ code, CART_LINE },
	)
}

/**
 * Scan with nothing focused, the way a keyboard-wedge scanner types (keys 10 ms apart, then
 * Enter). Time from the Enter key to the new cart line.
 */
async function timeGlobalScan(page, code) {
	await page.evaluate(
		({ CART_LINE }) => {
			document.activeElement?.blur?.()
			const before = document.querySelectorAll(CART_LINE).length
			window.__perfGlobal = new Promise((resolve) => {
				const onKey = (event) => {
					if (event.key !== "Enter") return
					window.removeEventListener("keydown", onKey, true)
					const start = performance.now()
					const check = () => {
						if (document.querySelectorAll(CART_LINE).length > before)
							resolve(performance.now() - start)
						else if (performance.now() - start > 3000) resolve(null)
						else requestAnimationFrame(check)
					}
					check()
				}
				window.addEventListener("keydown", onKey, true)
			})
		},
		{ CART_LINE },
	)
	// One burst inside the page: Playwright's keyboard.type waits for each key to be handled,
	// so on a busy page its gaps exceed 30 ms, unlike a real scanner's time-stamped keys.
	await page.waitForTimeout(300) // let a pending focusSearchInput() run first
	await page.evaluate((code) => {
		document.activeElement?.blur?.()
		for (const key of [...code, "Enter"]) {
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
			)
		}
	}, code)
	return page.evaluate(() => window.__perfGlobal)
}

async function clearCart(page) {
	if ((await page.locator(CART_LINE).count()) === 0) return
	const clear = page.getByRole("button", { name: /clear/i }).first()
	if (await clear.isVisible().catch(() => false)) {
		await clear.click()
		const confirm = page
			.getByRole("dialog")
			.getByRole("button", { name: /clear|yes|confirm/i })
		if (
			await confirm
				.first()
				.isVisible()
				.catch(() => false)
		)
			await confirm.first().click()
	}
	await expect(page.locator(CART_LINE)).toHaveCount(0, { timeout: 10_000 })
}

/** Open the payment dialog, pay the exact cash amount; returns the Complete button. */
async function preparePayment(page) {
	await page.getByRole("button", { name: "Proceed to payment" }).click()
	const dialog = page
		.getByRole("dialog")
		.filter({ hasText: "Complete Payment" })
	await dialog.getByRole("button", { name: /Cash$/ }).first().click()
	await dialog
		.getByText("Quick amounts for Cash")
		.locator("xpath=following-sibling::div[1]//button")
		.first()
		.click()
	const complete = dialog
		.getByRole("button", { name: "Complete Payment" })
		.first()
	await expect(complete).toBeEnabled({ timeout: 10_000 })
	return complete
}

/** Arms an in-page timer: Complete click (capture phase) to a new row in invoice_queue. */
async function armQueueTimer(page) {
	await page.evaluate(async () => {
		const open = () =>
			new Promise((resolve, reject) => {
				const req = indexedDB.open("pos_next_offline")
				req.onsuccess = () => resolve(req.result)
				req.onerror = () => reject(req.error)
			})
		const db = await open()
		const count = () =>
			new Promise((resolve) => {
				const req = db
					.transaction("invoice_queue")
					.objectStore("invoice_queue")
					.count()
				req.onsuccess = () => resolve(req.result)
				req.onerror = () => resolve(-1)
			})
		const before = await count()
		window.__perfQueue = new Promise((resolve) => {
			const onClick = (event) => {
				const button = event.target.closest?.("button")
				if (!button || !/Complete Payment/.test(button.textContent || ""))
					return
				document.removeEventListener("click", onClick, true)
				const start = performance.now()
				const poll = async () => {
					if ((await count()) > before) {
						resolve(performance.now() - start)
						db.close()
					} else if (performance.now() - start > 10_000) resolve(null)
					else setTimeout(poll, 2)
				}
				poll()
			}
			document.addEventListener("click", onClick, true)
		})
	})
}

async function enqueue(page, invoices) {
	await page.evaluate(async (rows) => {
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open("pos_next_offline")
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})
		await new Promise((resolve, reject) => {
			const tx = db.transaction("invoice_queue", "readwrite")
			const store = tx.objectStore("invoice_queue")
			for (const data of rows) {
				store.add({
					offline_id: data.offline_id,
					data,
					timestamp: Date.now(),
					synced: false,
					retry_count: 0,
				})
			}
			tx.oncomplete = () => resolve()
			tx.onerror = () => reject(tx.error)
		})
		db.close()
	}, invoices)
}

async function pendingQueue(page, prefix) {
	return page.evaluate(async (prefix) => {
		const db = await new Promise((resolve) => {
			const req = indexedDB.open("pos_next_offline")
			req.onsuccess = () => resolve(req.result)
		})
		const rows = await new Promise((resolve) => {
			const req = db
				.transaction("invoice_queue")
				.objectStore("invoice_queue")
				.getAll()
			req.onsuccess = () => resolve(req.result)
		})
		db.close()
		return rows.filter((r) => r.offline_id.startsWith(prefix) && !r.synced)
			.length
	}, prefix)
}

test.describe
	.serial("section 6 performance targets", () => {
		test.afterAll(async ({ baseURL }) => {
			await setProfilePrinter(baseURL, null).catch(() => {})
			save()
			console.log(`[perf] saved test-results/perf-${LABEL}.json`)
		})

		test("measure", async ({ browser, baseURL }) => {
			test.setTimeout(30 * 60_000)
			await setProfilePrinter(baseURL, PRINTER)
			const context = await browser.newContext()
			const jobs = await fakeQz(context)
			await routeApi(context)
			results.api = API_URL || baseURL
			const page = await context.newPage()
			expect(
				(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
			).toBeTruthy()

			// 1. Initial full cache (fresh browser): from opening /pos until every item is in IndexedDB.
			const t0 = Date.now()
			await openTill(page)
			let progressSeen = false
			while ((await cachedItemCount(page)) < ITEM_COUNT) {
				if (!progressSeen) {
					progressSeen = await page
						.locator('[data-testid="cache-progress"], [role="progressbar"]')
						.first()
						.isVisible()
						.catch(() => false)
				}
				if (Date.now() - t0 > 10 * 60_000) break
				await page.waitForTimeout(250)
			}
			record(
				"initial_cache_ms",
				Date.now() - t0,
				`${await cachedItemCount(page)} items cached; progress bar ${progressSeen ? "shown" : "not seen"}`,
			)
			// Let the search index (if any) and the other caches settle before timing searches.
			await page.waitForTimeout(5_000)

			// 2. Reopen the till with everything cached: navigation to the first item card.
			const reopen = []
			for (let i = 0; i < 3; i++) {
				const start = Date.now()
				await page.goto("/pos")
				await page.locator(ITEM_CARD).first().waitFor({ timeout: 30_000 })
				reopen.push(Date.now() - start)
			}
			record("reopen_ms", median(reopen), `runs ${reopen.join(", ")}`)
			await page.waitForTimeout(3_000)
			await clearCart(page)

			// 3. Search, first results (code prefix, word inside the name, Arabic-free name word, barcode).
			const searches = [
				["ITM-1234", "#1234"],
				["Royal Dates", "Royal Dates"],
				["Shampoo 1L #1", "Shampoo 1L #1"],
				["#19999", "#19999"],
				[ean(12345), "#12345"],
			]
			const searchTimes = []
			const searchDetail = []
			for (const [term, text] of searches) {
				for (let i = 0; i < 2; i++) {
					const ms = await timeSearch(page, term, text)
					searchTimes.push(ms)
					searchDetail.push(`${term}=${ms === null ? "none" : Math.round(ms)}`)
				}
			}
			const missed = searchTimes.filter((x) => x === null).length
			record(
				"search_first_results_ms",
				missed ? null : median(searchTimes),
				`${searchDetail.join("; ")}${missed ? `; ${missed} searches found nothing in 5 s` : ""}`,
			)
			await timeSearch(page, "", "")

			// 4. Scan to cart through the search box: normal EAN-13 and a scale label (1.250 kg).
			const scans = []
			for (const n of [1, 2, 3, 4, 5]) {
				scans.push(await timeFieldScan(page, ean(n)))
			}
			record(
				"scan_to_cart_ms",
				median(scans),
				`runs ${scans.map((x) => Math.round(x ?? -1)).join(", ")}`,
			)
			const scaleScans = []
			for (let i = 0; i < 3; i++)
				scaleScans.push(await timeFieldScan(page, "2012345012509"))
			record(
				"scale_scan_to_cart_ms",
				median(scaleScans),
				`runs ${scaleScans.map((x) => Math.round(x ?? -1)).join(", ")}`,
			)
			await clearCart(page)

			// 5. Scan with no field focused (global scanner capture).
			// Scans are ignored while a dialog is open (e.g. a UOM choice left from step 4).
			for (let i = 0; i < 3; i++) await page.keyboard.press("Escape")
			await page.waitForTimeout(500)
			const globals = []
			// Three different items: the same item again only raises the quantity (no new line).
			for (const n of [6, 7, 8])
				globals.push(await timeGlobalScan(page, ean(n)))
			const globalOk = globals.every((x) => x !== null)
			if (!globalOk) {
				const diag = await page.evaluate(() => ({
					dialogs: Array.from(document.querySelectorAll('[role="dialog"]'))
						.filter((d) => d.getClientRects().length)
						.map((d) => d.textContent.slice(0, 60)),
					active: document.activeElement?.tagName,
				}))
				results.notes.global_scan_diag = JSON.stringify(diag)
				await page.screenshot({ path: path.join(OUT_DIR, "perf-global-scan.png") })
			}
			record(
				"global_scan_to_cart_ms",
				globalOk ? median(globals) : null,
				globalOk
					? `runs ${globals.map((x) => Math.round(x)).join(", ")}`
					: "scan without focus did not reach the cart",
			)
			await clearCart(page)

			// 6. Pay -> receipt starts printing (online cash sale, fake QZ Tray, raster mode).
			try {
				await expect(page.getByTestId("printer-badge")).toHaveAttribute(
					"data-status",
					"ok",
					{ timeout: 30_000 },
				)
				const prints = []
				for (let i = 0; i < 3; i++) {
					await timeFieldScan(page, ean(2))
					const complete = await preparePayment(page)
					const before = jobs.length
					const paidAt = Date.now()
					await complete.click()
					await expect
						.poll(() => jobs.length, { timeout: 20_000 })
						.toBeGreaterThan(before)
					prints.push(jobs[jobs.length - 1].at - paidAt)
					await expect(page.locator(CART_LINE)).toHaveCount(0, {
						timeout: 15_000,
					})
					await page.waitForTimeout(1_000)
				}
				record(
					"pay_to_print_ms",
					median(prints),
					`runs ${prints.join(", ")} (printed from the local invoice; submit runs in the background)`,
				)
				// The background submits must still reach the server (queue empties).
				await expect
					.poll(() => pendingQueue(page, "pos_offline_"), {
						timeout: 60_000,
					})
					.toBe(0)
			} catch (error) {
				record(
					"pay_to_print_ms",
					null,
					`step failed: ${String(error?.message || error).split("\n")[0]}`,
				)
				await page
					.screenshot({
						path: path.join(OUT_DIR, "perf-pay_to_print_ms-failed.png"),
					})
					.catch(() => {})
				await page.keyboard.press("Escape").catch(() => {})
				await context.setOffline(false)
			}

			// 7. Submit invoice offline: Complete Payment click to the invoice in the browser queue.
			try {
				await context.setOffline(true)
				await expect(page.getByTestId("sync-badge")).toHaveAttribute(
					"data-tone",
					/offline|failed/,
					{ timeout: 60_000 },
				)
				const submits = []
				for (let i = 0; i < 3; i++) {
					await timeFieldScan(page, ean(3))
					const complete = await preparePayment(page)
					await armQueueTimer(page)
					await complete.click()
					submits.push(await page.evaluate(() => window.__perfQueue))
					await expect(page.locator(CART_LINE)).toHaveCount(0, {
						timeout: 15_000,
					})
					await page.waitForTimeout(500)
				}
				record(
					"submit_offline_ms",
					median(submits),
					`runs ${submits.map((x) => Math.round(x ?? -1)).join(", ")}`,
				)
				await context.setOffline(false)
				await expect(page.getByTestId("sync-badge")).toHaveAttribute(
					"data-tone",
					/online|pending/,
					{ timeout: 120_000 },
				)
			} catch (error) {
				record(
					"submit_offline_ms",
					null,
					`step failed: ${String(error?.message || error).split("\n")[0]}`,
				)
				await page
					.screenshot({
						path: path.join(OUT_DIR, "perf-submit_offline_ms-failed.png"),
					})
					.catch(() => {})
				await page.keyboard.press("Escape").catch(() => {})
				await context.setOffline(false)
			}

			// 8. Sync N queued invoices (one browser); check one invoice per offline id on the server.
			if (SYNC_COUNT > 0) {
				await expect
					.poll(() => pendingQueue(page, "pos_offline_"), { timeout: 120_000 })
					.toBe(0)
				const prefix = `pos_offline_perf-${Date.now()}-`
				await context.setOffline(true)
				await expect(page.getByTestId("sync-badge")).toHaveAttribute(
					"data-tone",
					/offline|failed/,
					{
						timeout: 60_000,
					},
				)
				const rows = Array.from({ length: SYNC_COUNT }, (_, n) =>
					syncInvoice(`${prefix}${n}`, n),
				)
				await enqueue(page, rows)
				const start = Date.now()
				await context.setOffline(false)
				await expect
					.poll(() => pendingQueue(page, prefix), {
						timeout: 15 * 60_000,
						intervals: [5_000],
					})
					.toBe(0)
				const elapsed = Date.now() - start
				const api = await admin(baseURL)
				const res = await api.get("/api/resource/Offline Invoice Sync", {
					params: {
						filters: JSON.stringify([["offline_id", "like", `${prefix}%`]]),
						fields: JSON.stringify(["status", "sales_invoice"]),
						limit_page_length: SYNC_COUNT * 2,
					},
				})
				const syncRows = (await res.json()).data
				const invoices = new Set(
					syncRows.map((r) => r.sales_invoice).filter(Boolean),
				)
				const synced = syncRows.filter((r) => r.status === "Synced").length
				await api.dispose()
				record(
					"sync_500_ms",
					elapsed,
					`${SYNC_COUNT} queued; ${synced} Synced, ${syncRows.length} sync rows, ${invoices.size} distinct invoices`,
				)
				expect(syncRows.length).toBe(SYNC_COUNT)
				expect(invoices.size).toBe(synced)
			}

			save()
			await context.close()
			if (ASSERT) {
				for (const [name, target] of Object.entries(TARGETS)) {
					if (!(name in results.metrics)) continue
					expect(results.metrics[name], name).not.toBeNull()
					expect(results.metrics[name], name).toBeLessThan(target)
				}
			}
		})
	})
