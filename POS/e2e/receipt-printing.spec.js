// F9 end-to-end: receipt printing through QZ Tray without real hardware. A fake QZ Tray
// answers on QZ's WebSocket (localhost:8182 / 8181) and records the raw jobs. Checks:
// raster receipt (GS v 0) with drawer kick and cut after a cash sale, online and offline;
// F9 reprint without a drawer kick; No Sale opens the drawer offline and the event reaches
// the server on reconnect; with no QZ Tray the badge is red and receipts print through
// the browser; the badge panel fits in RTL.
import { expect, request, test } from "@playwright/test"

const CASHIER = { usr: "cashier@pos.test", pwd: "cashier" }
const ADMIN = { usr: "Administrator", pwd: "admin" }
const PROFILE = "Main Till"
const PRINTER = "E2E Receipt Raster"
const NORMAL_BARCODE = "6290000000016" // ITM-00001
const DRAWER_KICK = "1b 70 00 19 fa"

const hex = (b64) =>
	Array.from(Buffer.from(b64, "base64"), (b) =>
		b.toString(16).padStart(2, "0"),
	).join(" ")

/** Rows and ink of the GS v 0 bands in a raster job. */
function decodeRaster(hexString) {
	const bytes = hexString.split(" ").map((h) => Number.parseInt(h, 16))
	let width = 0
	const rows = []
	for (let i = 0; i < bytes.length - 8; i++) {
		if (bytes[i] === 0x1d && bytes[i + 1] === 0x76 && bytes[i + 2] === 0x30) {
			const bpr = bytes[i + 4] + bytes[i + 5] * 256
			const h = bytes[i + 6] + bytes[i + 7] * 256
			width = bpr
			for (let r = 0; r < h; r++)
				rows.push(bytes.slice(i + 8 + r * bpr, i + 8 + (r + 1) * bpr))
			i += 7 + bpr * h
		}
	}
	const ink = rows.reduce(
		(n, row) =>
			n + row.reduce((m, b) => m + b.toString(2).split("1").length - 1, 0),
		0,
	)
	return {
		bytesPerRow: width,
		height: rows.length,
		rows,
		ink: ink / Math.max(1, width * 8 * rows.length),
	}
}

/** Save the printed raster as a PNG (drawn by the browser) for a manual look. */
async function saveRasterPng(page, raster, path) {
	const dataUrl = await page.evaluate(({ bytesPerRow, rows }) => {
		const c = document.createElement("canvas")
		c.width = bytesPerRow * 8
		c.height = rows.length
		const ctx = c.getContext("2d")
		ctx.fillStyle = "#fff"
		ctx.fillRect(0, 0, c.width, c.height)
		ctx.fillStyle = "#000"
		rows.forEach((row, y) => {
			row.forEach((b, x) => {
				for (let k = 0; k < 8; k++)
					if (b & (0x80 >> k)) ctx.fillRect(x * 8 + k, y, 1, 1)
			})
		})
		return c.toDataURL("image/png")
	}, raster)
	const fs = await import("node:fs")
	fs.writeFileSync(path, Buffer.from(dataUrl.split(",")[1], "base64"))
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

/** Fake QZ Tray: answers every call, records print jobs. */
async function fakeQz(context) {
	const jobs = []
	// QZ Tray listens on ws://localhost:8182 (http pages) or wss://localhost:8181 (https).
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
			else if (msg.call === "print") {
				for (const d of msg.params?.data || []) {
					jobs.push({
						printer: msg.params?.printer,
						flavor: d.flavor,
						type: d.type,
						hex: d.flavor === "base64" ? hex(d.data) : "",
						at: Date.now(),
					})
				}
			}
			ws.send(JSON.stringify({ uid: msg.uid, result }))
		})
	})
	return jobs
}

async function openTill(page) {
	await page.goto("/pos")
	const openShiftDialog = page
		.getByRole("dialog")
		.filter({ hasText: "Open POS Shift" })
	const shiftOpen = page.getByText("Shift Open:")
	await expect(openShiftDialog.or(shiftOpen).first()).toBeVisible({
		timeout: 30_000,
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
	await expect(shiftOpen).toBeVisible({ timeout: 30_000 })
}

async function cacheState(page) {
	return page.evaluate(async (profile) => {
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open("pos_next_offline")
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})
		const get = (store, key) =>
			new Promise((resolve) => {
				try {
					const req = db.transaction(store).objectStore(store).get(key)
					req.onsuccess = () => resolve(req.result || null)
					req.onerror = () => resolve(null)
				} catch {
					resolve(null)
				}
			})
		const item = await get("items", "ITM-00001")
		const pr = await get("settings", `pos0001_printing_cache::${profile}`)
		const sp = await get("settings", `pos0001_sales_person_cache::${profile}`)
		db.close()
		return {
			item: Boolean(item),
			printer: pr?.value?.printer?.name || null,
			canNoSale: Boolean(pr?.value?.can_no_sale),
			salesPersons: Boolean(sp?.value),
		}
	}, PROFILE)
}

async function emptyCart(page) {
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
}

async function sellForCash(page) {
	const input = page.locator("#item-search")
	await input.click()
	await input.fill(NORMAL_BARCODE)
	await input.press("Enter")
	await expect(
		page.getByTestId("invoice-cart-lines").getByTestId("cart-line"),
	).toHaveCount(1, {
		timeout: 15_000,
	})
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
	const paidAt = Date.now()
	await complete.click()
	return paidAt
}

function watchErrors(page) {
	const errors = []
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text())
	})
	page.on("response", async (res) => {
		if (res.status() >= 500) errors.push(`HTTP ${res.status()} ${res.url()}`)
		if (res.status() !== 400) return
		const body = await res.text().catch(() => "")
		if (!body.includes("CSRFTokenError"))
			errors.push(`HTTP 400 ${res.url()} ${body.slice(0, 200)}`)
	})
	return errors
}

const IGNORABLE = [
	/nexus_demo/,
	/qz\.get_certificate/,
	/qz\.sign_message/,
	/status of 404/,
	/status of 417/,
	/status of 400/, // checked through the response listener
	/ERR_INTERNET_DISCONNECTED/,
	/Failed to fetch/,
	/WebSocket connection to 'wss?:\/\/localhost/, // no real QZ Tray on the test machine
]

function unexpected(errors) {
	return errors.filter((e) => !IGNORABLE.some((re) => re.test(e)))
}

test.describe
	.serial("receipt printing", () => {
		test.beforeAll(async ({ baseURL }) => {
			await setProfilePrinter(baseURL, PRINTER)
		})
		test.afterAll(async ({ baseURL }) => {
			await setProfilePrinter(baseURL, null)
		})

		test("raster receipt, drawer, reprint and No Sale through QZ Tray, online and offline", async ({
			page,
			context,
			baseURL,
		}) => {
			test.setTimeout(240_000)
			const errors = watchErrors(page)
			const jobs = await fakeQz(context)
			expect(
				(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
			).toBeTruthy()
			await openTill(page)
			await expect
				.poll(async () => cacheState(page), {
					timeout: 120_000,
					intervals: [2_000],
				})
				.toEqual({
					item: true,
					printer: PRINTER,
					canNoSale: true,
					salesPersons: true,
				})
			await emptyCart(page)
			const badge = page.getByTestId("printer-badge")
			await expect(badge).toHaveAttribute("data-status", "ok", {
				timeout: 30_000,
			})

			// 1. Online cash sale: raster receipt with drawer kick and cut, within a few seconds.
			const paidAt = await sellForCash(page)
			await expect.poll(() => jobs.length, { timeout: 20_000 }).toBe(1)
			const sale = jobs[0]
			expect(sale.printer?.name).toBe("Fake Receipt")
			expect(sale.flavor).toBe("base64")
			expect(
				sale.hex.startsWith(`1b 40 ${DRAWER_KICK} 1d 76 30 00 48 00`),
			).toBe(true) // 576 dots = 72 bytes
			expect(sale.hex.endsWith("1b 64 04 1d 56 00")).toBe(true)
			expect(sale.at - paidAt).toBeLessThan(5_000)
			const raster = decodeRaster(sale.hex)
			expect(raster.bytesPerRow).toBe(72)
			expect(raster.height).toBeGreaterThan(400) // header, line, totals, barcode
			expect(raster.ink).toBeGreaterThan(0.02)
			expect(raster.ink).toBeLessThan(0.4)
			await saveRasterPng(
				page,
				raster,
				"test-results/receipt-raster-online.png",
			)

			// The receipt did not wait for the server; the sale still reaches it (queue empties).
			const unsyncedSales = () =>
				page.evaluate(async () => {
					const db = await new Promise((resolve, reject) => {
						const req = indexedDB.open("pos_next_offline")
						req.onsuccess = () => resolve(req.result)
						req.onerror = () => reject(req.error)
					})
					const rows = await new Promise((resolve) => {
						const req = db
							.transaction("invoice_queue")
							.objectStore("invoice_queue")
							.getAll()
						req.onsuccess = () => resolve(req.result)
					})
					db.close()
					return rows.filter((r) => !r.synced && !r.sync_failed).length
				})
			await expect
				.poll(unsyncedSales, { timeout: 60_000, intervals: [1_000] })
				.toBe(0)

			// 2. F9 reprint: same receipt, no drawer kick.
			await page.keyboard.press("F9")
			await expect.poll(() => jobs.length, { timeout: 15_000 }).toBe(2)
			expect(jobs[1].hex).toContain("1d 76 30 00")
			expect(jobs[1].hex).not.toContain(DRAWER_KICK)

			// 3. Offline cash sale: receipt built from the local invoice.
			await context.setOffline(true)
			await expect(page.getByTestId("sync-badge")).toHaveAttribute(
				"data-tone",
				/offline|failed/,
				{
					timeout: 30_000,
				},
			)
			await sellForCash(page)
			await expect.poll(() => jobs.length, { timeout: 20_000 }).toBe(3)
			expect(jobs[2].hex.startsWith(`1b 40 ${DRAWER_KICK} 1d 76 30 00`)).toBe(
				true,
			)
			await saveRasterPng(
				page,
				decodeRaster(jobs[2].hex),
				"test-results/receipt-raster-offline.png",
			)

			// 4. No Sale while offline: drawer opens, event waits on the till.
			await badge.click()
			const panel = page.getByTestId("printer-panel")
			await expect(panel).toBeVisible()
			const reason = `e2e change ${Date.now()}`
			await panel.getByTestId("no-sale-reason").fill(reason)
			await panel.getByTestId("no-sale-open").click()
			await expect.poll(() => jobs.length, { timeout: 15_000 }).toBe(4)
			expect(jobs[3].hex).toBe(DRAWER_KICK)
			await expect(panel.getByTestId("printer-message")).toContainText("logged")
			await page.keyboard.press("Escape")

			// 5. Back online: the No Sale event is stored on the server.
			await context.setOffline(false)
			const adminCtx = await admin(baseURL)
			await expect
				.poll(
					async () => {
						const res = await adminCtx.get(
							"/api/method/frappe.client.get_list",
							{
								params: {
									doctype: "POS Drawer Event",
									filters: JSON.stringify({ reason }),
									fields: JSON.stringify([
										"user",
										"permitted",
										"was_offline",
										"pos_profile",
									]),
								},
							},
						)
						return (await res.json()).message
					},
					{ timeout: 60_000, intervals: [3_000] },
				)
				.toEqual([
					{
						user: CASHIER.usr,
						permitted: 1,
						was_offline: 1,
						pos_profile: PROFILE,
					},
				])
			await adminCtx.dispose()

			const bad = unexpected(errors)
			expect(bad, bad.join("\n")).toEqual([])
		})

		test("QZ Tray not running: red badge, receipt prints through the browser", async ({
			page,
			context,
		}) => {
			test.setTimeout(180_000)
			const errors = watchErrors(page)
			expect(
				(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
			).toBeTruthy()
			await openTill(page)
			await expect
				.poll(async () => cacheState(page), {
					timeout: 120_000,
					intervals: [2_000],
				})
				.toMatchObject({ item: true, printer: PRINTER, salesPersons: true })
			await emptyCart(page)
			await expect(page.getByTestId("printer-badge")).toHaveAttribute(
				"data-status",
				"down",
				{
					timeout: 30_000,
				},
			)
			const popup = context.waitForEvent("page", { timeout: 30_000 })
			await sellForCash(page)
			const printWindow = await popup
			// Online cash sales print from the local invoice (DECISIONS item 13), so the
			// browser fallback is POS Next's local receipt window, not /printview.
			await expect(printWindow.getByText("Invoice #:").first()).toBeVisible({
				timeout: 15_000,
			})
			await printWindow.close()
			const bad = unexpected(errors)
			expect(bad, bad.join("\n")).toEqual([])
		})

		test("printer panel fits in RTL with 44 px targets", async ({
			page,
			context,
		}) => {
			await fakeQz(context)
			expect(
				(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
			).toBeTruthy()
			await openTill(page)
			await page.evaluate(() =>
				document.documentElement.setAttribute("dir", "rtl"),
			)
			const badge = page.getByTestId("printer-badge")
			await expect(badge).toBeVisible({ timeout: 60_000 })
			const box = await badge.boundingBox()
			expect(box.height).toBeGreaterThanOrEqual(44)
			expect(box.width).toBeGreaterThanOrEqual(44)
			const vw = page.viewportSize().width
			expect(box.x).toBeGreaterThanOrEqual(0)
			expect(box.x + box.width).toBeLessThanOrEqual(vw)
			await badge.click()
			const panel = page.getByTestId("printer-panel")
			await expect(panel).toBeVisible()
			expect(
				await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
			).toBe(true)
			for (const id of ["printer-reprint", "printer-test", "no-sale-open"]) {
				expect(
					(await panel.getByTestId(id).boundingBox()).height,
				).toBeGreaterThanOrEqual(44)
			}
			await page.screenshot({ path: "test-results/printer-panel-rtl.png" })
		})
	})
