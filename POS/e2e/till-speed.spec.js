// Phase 6 end-to-end (SPEC section 6): global scanner capture with no field focused, keyboard
// shortcuts and the ? overlay, instant search from the search index, virtual scrolling of the
// item list, favourites grid; RTL check of the new parts.
import { expect, test } from "@playwright/test"

const CASHIER = { usr: "cashier@pos.test", pwd: "cashier" }
const PROFILE = "Main Till"
const LINES = '[data-testid="invoice-cart-lines"] [data-testid="cart-line"]'

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

async function clearCart(page) {
	if ((await page.locator(LINES).count()) === 0) return
	await page.getByRole("button", { name: /clear/i }).first().click()
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
	await expect(page.locator(LINES)).toHaveCount(0)
}

/**
 * A keyboard-wedge scan: keys sent in one burst inside the page, nothing focused. (Playwright's
 * keyboard.type waits for each key to be handled, so on a busy page its gaps grow past 30 ms;
 * real scanner events keep their hardware time stamps.)
 */
async function scanKeys(page, code) {
	await page.evaluate((code) => {
		document.activeElement?.blur?.()
		for (const key of [...code, "Enter"]) {
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
			)
		}
	}, code)
}

/** Text and input values of the first cart line (quantity can sit in an input). */
async function firstLine(page) {
	return page
		.locator(LINES)
		.first()
		.evaluate(
			(el) =>
				`${el.textContent} ${Array.from(el.querySelectorAll("input"))
					.map((i) => i.value)
					.join(" ")}`,
		)
}

function watchErrors(page) {
	const errors = []
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text())
	})
	page.on("response", async (res) => {
		if (res.status() >= 500) errors.push(`HTTP ${res.status()} ${res.url()}`)
	})
	return errors
}
const ignorable = (e) =>
	/nexus_demo|qz\.get_certificate|Failed to load resource|CSRFTokenError|WebSocket/i.test(
		e,
	)

test("scan without focus, shortcuts, ? overlay, instant search, virtual list", async ({
	page,
}) => {
	test.setTimeout(240_000)
	const errors = watchErrors(page)
	expect(
		(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
	).toBeTruthy()
	await openTill(page)
	// The search index is built in a worker from the item cache.
	await expect
		.poll(
			() =>
				page.evaluate(() =>
					window.pos0001Search?.status().then((s) => s?.ready && s.count),
				),
			{
				timeout: 180_000,
				intervals: [2_000],
			},
		)
		.toBeGreaterThan(19_000)
	await clearCart(page)

	// Global scanner capture: keys 10 ms apart, nothing focused.
	await scanKeys(page, "6290000000016")
	await expect(page.locator(LINES)).toHaveCount(1, { timeout: 10_000 })
	// A person typing slowly on the page is not a scan.
	await page.evaluate(() => document.activeElement?.blur?.())
	await page.keyboard.type("6290000000016", { delay: 80 })
	await page.keyboard.press("Enter")
	await page.waitForTimeout(800)
	await expect(page.locator(LINES)).toHaveCount(1)

	// + / - change the last line, Del removes it.
	await page.evaluate(() => document.activeElement?.blur?.())
	// Keys under 30 ms apart count as a scanner burst, so press like a person.
	await page.keyboard.press("+")
	await page.waitForTimeout(150)
	await page.keyboard.press("+")
	await expect.poll(() => firstLine(page)).toMatch(/\b3\b/)
	await page.keyboard.press("-")
	await expect.poll(() => firstLine(page)).toMatch(/\b2\b/)
	await page.keyboard.press("Delete")
	await expect(page.locator(LINES)).toHaveCount(0)

	// ? shows the shortcut list; Esc closes it.
	await page.keyboard.press("?")
	const overlay = page.getByTestId("shortcuts-overlay")
	await expect(overlay).toBeVisible()
	await expect(page.getByTestId("shortcut-row")).toHaveCount(12)
	await page.keyboard.press("Escape")
	await expect(overlay).toBeHidden()

	// F2 focuses search; a word in the middle of names finds items at once (search index).
	await page.keyboard.press("F2")
	await expect(page.locator("#item-search")).toBeFocused()
	const started = Date.now()
	await page.locator("#item-search").fill("Dates 1kg")
	const hit = page
		.locator('[data-testid="item-card"], [data-testid="item-row"]')
		.filter({ hasText: "Dates 1kg" })
	await expect(hit.first()).toBeVisible({ timeout: 2_000 })
	console.log(
		`search shown in ${Date.now() - started} ms (incl. Playwright round trips)`,
	)
	// Long result lists render only the rows in view.
	const rendered = await page
		.locator('[data-testid="item-card"], [data-testid="item-row"]')
		.count()
	expect(rendered).toBeLessThan(120)
	await page.locator("#item-search").fill("")

	// F8 holds (opens the note dialog), F4 pays (opens the payment dialog).
	await scanKeys(page, "6290000000016")
	await expect(page.locator(LINES)).toHaveCount(1, { timeout: 10_000 })
	await page.keyboard.press("F8")
	await expect(page.getByTestId("hold-cart-dialog")).toBeVisible()
	await page.keyboard.press("Escape")
	// F-keys are ignored while a dialog is on screen, so wait until it has gone.
	await expect(page.getByTestId("hold-cart-dialog")).toBeHidden()
	await expect(page.getByRole("dialog")).toHaveCount(0)
	await page.keyboard.press("F4")
	const payment = page
		.getByRole("dialog")
		.filter({ hasText: "Complete Payment" })
	await expect(payment).toBeVisible()
	await page.keyboard.press("Escape")
	await expect(payment).toBeHidden()
	await clearCart(page)

	expect(errors.filter((e) => !ignorable(e))).toEqual([])
})

test("favourites grid and new parts in RTL", async ({ page }) => {
	test.setTimeout(120_000)
	expect(
		(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
	).toBeTruthy()
	await openTill(page)
	await clearCart(page)
	// Main Till has sales in the demo data (earlier tests), so favourites exist.
	const grid = page.getByTestId("favourites-grid")
	await expect(grid).toBeVisible({ timeout: 60_000 })
	const first = grid.getByTestId("favourite-item").first()
	const box = await first.boundingBox()
	expect(box.height).toBeGreaterThanOrEqual(44)
	await first.click()
	await expect(page.locator(LINES).first()).toBeVisible({ timeout: 10_000 })

	await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"))
	const overflow = await grid.evaluate((el) => el.scrollWidth - el.clientWidth)
	expect(overflow).toBeLessThanOrEqual(1)
	await page.evaluate(() => document.activeElement?.blur?.())
	await page.keyboard.press("?")
	const overlay = page.getByTestId("shortcuts-overlay")
	await expect(overlay).toBeVisible()
	expect(
		await overlay.evaluate((el) => el.scrollWidth - el.clientWidth),
	).toBeLessThanOrEqual(1)
	// Measured after the open transition (it scales the overlay in).
	await expect
		.poll(
			async () =>
				(await page.getByTestId("shortcut-row").first().boundingBox())?.height,
		)
		.toBeGreaterThanOrEqual(44)
	await page.keyboard.press("Escape")
	await clearCart(page)
})
