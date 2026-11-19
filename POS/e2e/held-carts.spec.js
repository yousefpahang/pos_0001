// F7 end-to-end: hold a cart on one till and resume it on another (two browser contexts, same
// POS Profile); hold while offline, the cart stays on the till and is uploaded on reconnect.
import { expect, test } from "@playwright/test"

const CASHIER = { usr: "cashier@pos.test", pwd: "cashier" }
const PROFILE = "Main Till"
const BARCODE = "6290000000016" // ITM-00001
const API = "/api/method/pos_next.pos_0001.api.held_carts"

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

async function itemCached(page) {
	return page.evaluate(async () => {
		const db = await new Promise((resolve, reject) => {
			const req = indexedDB.open("pos_next_offline")
			req.onsuccess = () => resolve(req.result)
			req.onerror = () => reject(req.error)
		})
		const item = await new Promise((resolve) => {
			try {
				const req = db
					.transaction("items")
					.objectStore("items")
					.get("ITM-00001")
				req.onsuccess = () => resolve(req.result || null)
				req.onerror = () => resolve(null)
			} catch {
				resolve(null)
			}
		})
		db.close()
		return Boolean(item)
	})
}

async function scan(page, code) {
	const input = page.locator("#item-search")
	await input.click()
	await input.fill(code)
	await input.press("Enter")
}

async function serverHeld(request) {
	const res = await request.get(`${API}.list_held_carts`, {
		params: { pos_profile: PROFILE },
	})
	expect(res.ok()).toBeTruthy()
	return (await res.json()).message.held
}

async function hold(page, note) {
	await page.getByRole("button", { name: "Hold order as draft" }).click()
	const dialog = page.getByTestId("hold-cart-dialog")
	await expect(dialog).toBeVisible()
	await page.getByTestId("hold-cart-note").fill(note)
	await page.getByTestId("hold-cart-confirm").click()
	await expect(
		page.getByTestId("invoice-cart-lines").getByTestId("cart-line"),
	).toHaveCount(0)
}

function watchErrors(page, errors) {
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
}

const ignorable = (e) =>
	/nexus_demo|qz\.get_certificate|Failed to load resource|CSRFTokenError|ERR_INTERNET_DISCONNECTED|net::ERR/i.test(
		e,
	)

test("hold on till 1, resume on till 2; offline hold uploads on reconnect", async ({
	browser,
}) => {
	test.setTimeout(300_000)
	const errors = []
	const till1 = await browser.newContext()
	const till2 = await browser.newContext()
	const page1 = await till1.newPage()
	const page2 = await till2.newPage()
	watchErrors(page1, errors)
	watchErrors(page2, errors)

	for (const page of [page1, page2]) {
		expect(
			(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
		).toBeTruthy()
		await openTill(page)
	}
	await expect
		.poll(() => itemCached(page1), { timeout: 120_000, intervals: [2_000] })
		.toBe(true)

	// Till 1: two of ITM-00001, hold with a note.
	const note1 = `e2e hold ${Date.now()}`
	await scan(page1, BARCODE)
	await scan(page1, BARCODE)
	const lines1 = page1
		.getByTestId("invoice-cart-lines")
		.getByTestId("cart-line")
	await expect(lines1).toHaveCount(1, { timeout: 15_000 })
	await hold(page1, note1)
	const held = (await serverHeld(page1.request)).find((r) => r.note === note1)
	expect(held, "held cart is on the server").toBeTruthy()
	expect(held.name).toMatch(/^HOLD-/)
	expect(held.items[0].item_code).toBe("ITM-00001")
	expect(held.items[0].qty).toBe(2)
	expect(held.held_by).toBe(CASHIER.usr)

	// Till 2: the list shows it with time, cashier and note; resume puts the cart back.
	await page2.getByTitle("View draft invoices").click()
	const entry2 = page2.getByTestId("held-cart").filter({ hasText: note1 })
	await expect(entry2).toBeVisible({ timeout: 15_000 })
	await expect(entry2).toHaveAttribute("data-source", "server")
	await entry2.getByTestId("held-cart-resume").click()
	const lines2 = page2
		.getByTestId("invoice-cart-lines")
		.getByTestId("cart-line")
	await expect(lines2).toHaveCount(1, { timeout: 15_000 })
	await expect(lines2.first()).toContainText("2")
	expect((await serverHeld(page2.request)).some((r) => r.note === note1)).toBe(
		false,
	)

	// Till 1 opens its list after the claim: the cart is gone there too (a stale resume is
	// refused by the server; see test_held_carts.py).
	await page1.getByTitle("View draft invoices").click()
	await expect(
		page1.getByTestId("held-cart").filter({ hasText: note1 }),
	).toHaveCount(0, {
		timeout: 15_000,
	})
	await page1.keyboard.press("Escape")

	// Till 1 offline: hold stays on this till, then uploads on reconnect.
	await till1.setOffline(true)
	await expect(page1.getByTestId("sync-badge")).toHaveAttribute(
		"data-tone",
		/offline|failed/,
		{
			timeout: 60_000,
		},
	)
	const note2 = `e2e offline hold ${Date.now()}`
	await scan(page1, BARCODE)
	await expect(lines1).toHaveCount(1, { timeout: 15_000 })
	await hold(page1, note2)
	await page1.getByTitle("View draft invoices").click()
	const local = page1.getByTestId("held-cart").filter({ hasText: note2 })
	await expect(local).toHaveAttribute("data-source", "local")
	await expect(local.getByTestId("held-cart-local")).toBeVisible()
	await page1.keyboard.press("Escape")

	await till1.setOffline(false)
	await expect
		.poll(
			async () =>
				(await serverHeld(page2.request)).some((r) => r.note === note2),
			{
				timeout: 90_000,
				intervals: [2_000],
			},
		)
		.toBe(true)
	const uploaded = (await serverHeld(page2.request)).find(
		(r) => r.note === note2,
	)

	// Till 2 resumes the uploaded cart; clean up.
	await page2.getByTestId("invoice-cart-lines").waitFor()
	const res = await page2.request.post(`${API}.delete_held_cart`, {
		data: { pos_profile: PROFILE, name: uploaded.name },
		headers: {
			"X-Frappe-CSRF-Token": await page2.evaluate(
				() => window.csrf_token || "",
			),
		},
	})
	expect(res.ok()).toBeTruthy()

	expect(errors.filter((e) => !ignorable(e))).toEqual([])
	await till1.close()
	await till2.close()
})

test("held carts dialog in RTL: touch targets and no overflow", async ({
	page,
}) => {
	test.setTimeout(120_000)
	expect(
		(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
	).toBeTruthy()
	await openTill(page)
	await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"))
	await page.getByTitle("View draft invoices").click()
	const dialog = page.getByTestId("held-carts-dialog")
	await expect(dialog).toBeVisible()
	const refresh = page.getByTestId("held-carts-refresh")
	const box = await refresh.boundingBox()
	expect(box.height).toBeGreaterThanOrEqual(44)
	const overflow = await dialog.evaluate(
		(el) => el.scrollWidth - el.clientWidth,
	)
	expect(overflow).toBeLessThanOrEqual(1)
})
