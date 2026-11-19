// F6 end-to-end: the cart header picker pre-selects the cashier's default sales person,
// selects by badge barcode and by name, splits between two people, blocks payment while a
// Mandatory profile has nobody, and the split reaches the invoice. Selling happens with the
// network off (cached list); the invoice is then synced and checked on the server.
// Demo seed: Main Till = Mandatory + POS Settings Multiple, cashier default "Ahmed Ali",
// badges SP0001..SP0005.
import { expect, request, test } from "@playwright/test"

const CASHIER = { usr: "cashier@pos.test", pwd: "cashier" }
const ADMIN = { usr: "Administrator", pwd: "admin" }
const PROFILE = "Main Till"
const NORMAL_BARCODE = "6290000000016" // ITM-00001

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

/** Cached state needed to sell offline: item and sales person list for the profile. */
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
		const sp = await get("settings", `pos0001_sales_person_cache::${profile}`)
		db.close()
		return {
			item: Boolean(item),
			mode: sp?.value?.mode || null,
			persons: sp?.value?.sales_persons?.length || 0,
		}
	}, PROFILE)
}

/** Newest row of POS Next's offline invoice queue. */
async function lastQueued(page) {
	return page.evaluate(async () => {
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
			req.onsuccess = () => resolve(req.result || [])
			req.onerror = () => resolve([])
		})
		db.close()
		rows.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
		const row = rows[rows.length - 1]
		return row
			? {
					offline_id: row.offline_id,
					synced: row.synced,
					sales_team: (row.data?.sales_team || []).map((m) => [
						m.sales_person,
						m.allocated_percentage,
					]),
				}
			: null
	})
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

async function scan(page, code) {
	const input = page.locator("#item-search")
	await input.click()
	await input.fill(code)
	await input.press("Enter")
}

test("sales person picker: default, badge scan, split, mandatory, offline sale reaches Sales Team", async ({
	page,
	context,
	baseURL,
}) => {
	test.setTimeout(240_000)
	const consoleErrors = []
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text())
	})
	// Startup CSRF race in POS Next gives 400 CSRFTokenError (see PROGRESS Phase 3);
	// any other 400 is an error.
	page.on("response", async (res) => {
		if (res.status() >= 500)
			consoleErrors.push(`HTTP ${res.status()} ${res.url()}`)
		if (res.status() !== 400) return
		const body = await res.text().catch(() => "")
		if (!body.includes("CSRFTokenError"))
			consoleErrors.push(`HTTP 400 ${res.url()} ${body.slice(0, 200)}`)
	})

	expect(
		(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
	).toBeTruthy()
	await openTill(page)
	await expect
		.poll(async () => cacheState(page), {
			timeout: 120_000,
			intervals: [2_000],
		})
		.toEqual({ item: true, mode: "Mandatory", persons: 5 })
	await emptyCart(page)

	const picker = page.getByTestId("sales-person-picker")
	const summary = page.getByTestId("sales-person-summary")
	await expect(picker).toHaveAttribute("data-mode", "Mandatory")
	await expect(summary).toHaveText("Ahmed Ali") // cashier's default

	await context.setOffline(true)
	await expect(page.getByTestId("sync-badge")).toHaveAttribute(
		"data-tone",
		/offline|failed/,
		{ timeout: 30_000 },
	)

	// Nobody selected: header turns red, payment cannot complete.
	await page.getByTestId("sales-person-toggle").click()
	const panel = page.getByTestId("sales-person-panel")
	await panel.getByTestId("sales-person-remove").first().click()
	await panel.getByTestId("sales-person-done").click()
	await expect(summary).toHaveText(/Sales person required/)

	await scan(page, NORMAL_BARCODE)
	await expect(
		page.getByTestId("invoice-cart-lines").getByTestId("cart-line"),
	).toHaveCount(1, { timeout: 15_000 })

	await page.getByRole("button", { name: "Proceed to payment" }).click()
	const dialog = page.getByRole("dialog").filter({ hasText: "Sales Person" })
	await expect(
		dialog.getByText("Sales person is required").first(),
	).toBeVisible({
		timeout: 15_000,
	})
	await dialog.getByRole("button", { name: /Cash$/ }).first().click()
	const quickCash = dialog
		.getByText("Quick amounts for Cash")
		.locator("xpath=following-sibling::div[1]//button")
		.first()
	await quickCash.click()
	await expect(dialog.getByText(/^Remaining$/i)).toBeHidden()
	const complete = dialog
		.getByRole("button", { name: "Complete Payment" })
		.first()
	await expect(complete).toBeVisible({ timeout: 10_000 })
	// Paid in full, but Mandatory with nobody selected: still blocked.
	await expect(complete).toBeDisabled()
	await page.keyboard.press("Escape")
	await expect(dialog).toBeHidden({ timeout: 10_000 })

	// Badge scan and name search in the cart header picker, then a 70 / 30 split.
	await page.getByTestId("sales-person-toggle").click()
	const search = panel.getByTestId("sales-person-search")
	await search.fill("SP0002")
	await search.press("Enter")
	await search.fill("omar")
	await search.press("Enter")
	const shares = panel.getByTestId("sales-person-share")
	await expect(shares).toHaveCount(2)
	await expect(shares.nth(0)).toHaveValue("50")
	await shares.nth(0).fill("70")
	await shares.nth(0).press("Tab")
	await expect(shares.nth(1)).toHaveValue("30")
	await panel.getByTestId("sales-person-done").click()
	await expect(summary).toHaveText("Fatima Hassan 70%, Omar Khalid 30%")

	// Pay: the dialog starts from the header selection.
	await page.getByRole("button", { name: "Proceed to payment" }).click()
	await expect(dialog.getByText("Fatima Hassan").first()).toBeVisible({
		timeout: 15_000,
	})
	await expect(dialog.getByText("Omar Khalid").first()).toBeVisible()
	await dialog.getByRole("button", { name: /Cash$/ }).first().click()
	// First quick amount for cash (covers the total; change is given).
	await quickCash.click()
	await expect(complete).toBeEnabled({ timeout: 10_000 })
	await complete.click()

	await expect
		.poll(async () => (await lastQueued(page))?.sales_team, {
			timeout: 20_000,
		})
		.toEqual([
			["Fatima Hassan", 70],
			["Omar Khalid", 30],
		])
	const queued = await lastQueued(page)

	// Next cart starts with the cashier's default again.
	await expect(summary).toHaveText("Ahmed Ali", { timeout: 15_000 })

	// Back online: sync and check the Sales Team on the server.
	await context.setOffline(false)
	await expect
		.poll(async () => (await lastQueued(page))?.synced, {
			timeout: 90_000,
			intervals: [3_000],
		})
		.toBeTruthy()

	const admin = await request.newContext({ baseURL })
	expect(
		(await admin.post("/api/method/login", { data: ADMIN })).ok(),
	).toBeTruthy()
	const sync = await (
		await admin.get("/api/method/frappe.client.get_value", {
			params: {
				doctype: "Offline Invoice Sync",
				filters: JSON.stringify({ offline_id: queued.offline_id }),
				fieldname: JSON.stringify(["status", "sales_invoice"]),
			},
		})
	).json()
	expect(sync.message.status).toBe("Synced")
	const invoice = await (
		await admin.get(
			`/api/resource/Sales Invoice/${encodeURIComponent(sync.message.sales_invoice)}`,
		)
	).json()
	expect(invoice.data.docstatus).toBe(1)
	expect(
		invoice.data.sales_team.map((r) => [
			r.sales_person,
			r.allocated_percentage,
			Number(r.commission_rate),
		]),
	).toEqual([
		["Fatima Hassan", 70, 1.5],
		["Omar Khalid", 30, 2],
	])
	expect(invoice.data.sales_team[0].incentives).toBeGreaterThan(0)
	await admin.dispose()

	const ignorable = [
		/nexus_demo/,
		/qz\.get_certificate/,
		/status of 404/,
		/status of 417/,
		/status of 400/, // checked through the response listener
		/ERR_INTERNET_DISCONNECTED/,
		/Failed to fetch/,
	]
	const unexpected = consoleErrors.filter(
		(e) => !ignorable.some((re) => re.test(e)),
	)
	expect(unexpected, unexpected.join("\n")).toEqual([])
})

test("sales person picker fits in RTL with 44 px targets", async ({ page }) => {
	expect(
		(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
	).toBeTruthy()
	await openTill(page)
	await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"))
	const toggle = page.getByTestId("sales-person-toggle")
	await expect(toggle).toBeVisible({ timeout: 60_000 })
	const box = await toggle.boundingBox()
	expect(box.height).toBeGreaterThanOrEqual(44)
	await toggle.click()
	const panel = page.getByTestId("sales-person-panel")
	await expect(panel).toBeVisible()
	const fits = await panel.evaluate(
		(el) => el.scrollWidth <= el.clientWidth + 1,
	)
	expect(fits).toBe(true)
	const options = panel.getByTestId("sales-person-option")
	expect((await options.first().boundingBox()).height).toBeGreaterThanOrEqual(
		44,
	)
	await page.screenshot({ path: "test-results/sales-person-rtl.png" })
	await panel.getByTestId("sales-person-done").click()
})
