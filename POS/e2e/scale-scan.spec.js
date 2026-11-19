// F5 end-to-end: with the network off, normal barcodes and scale labels resolve from the
// browser cache and land in the cart; a bad check digit shows a warning. Runs against the
// dev site with the demo seed (pos_next/pos_0001/demo/seed.py).
import { expect, test } from "@playwright/test"

const CASHIER = { usr: "cashier@pos.test", pwd: "cashier" }
const PROFILE = "Main Till"
const WEIGHT_LABEL = "2012345012509" // PLU 12345, 1.250 kg
const PRICE_LABEL = "2212345009992" // PLU 12345, AED 9.99
const BAD_LABEL = "2012345012508" // wrong check digit
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

/** What the browser has cached for scanning: the two items and the scale rules. */
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
		const plu = await get("items", "PLU-12345")
		const normal = await get("items", "ITM-00001")
		const scan = await get("settings", `pos0001_scan_cache::${profile}`)
		db.close()
		return {
			plu: Boolean(plu),
			normal: Boolean(normal),
			rules: scan?.value?.cache?.rules?.length || 0,
			pluMapped: scan?.value?.cache?.plu_map?.["12345"] || null,
		}
	}, PROFILE)
}

/** Clear the cart through POS Next's own button if anything is left from another run. */
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

test("scale labels and barcodes scan from the browser cache with the network off", async ({
	page,
	context,
}) => {
	const consoleErrors = []
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text())
	})
	const barcodeCalls = []
	page.on("request", (req) => {
		if (/search_by_barcode|resolve_scale_barcode/.test(req.url()))
			barcodeCalls.push(req.url())
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
		.toEqual({ plu: true, normal: true, rules: 2, pluMapped: "PLU-12345" })
	await emptyCart(page)

	await context.setOffline(true)
	await expect(page.getByTestId("sync-badge")).toHaveAttribute(
		"data-tone",
		/offline|failed/,
		{
			timeout: 30_000,
		},
	)

	await scan(page, WEIGHT_LABEL)
	await scan(page, WEIGHT_LABEL)
	await scan(page, PRICE_LABEL)
	await scan(page, NORMAL_BARCODE)

	// Two lines for the same weight label (never merged), one price line, one normal item.
	const cart = page.getByTestId("invoice-cart-lines")
	await expect(cart.getByTestId("cart-line")).toHaveCount(4, {
		timeout: 15_000,
	})
	const lines = cart.getByTestId("cart-line")
	const qty = (i) => lines.nth(i).getByRole("textbox", { name: "Quantity" })
	await expect(lines.filter({ hasText: "Tomato (per kg) 12345" })).toHaveCount(
		3,
	)
	await expect(qty(0)).toHaveValue("1.25")
	await expect(qty(1)).toHaveValue("1.25")
	await expect(qty(0)).toBeDisabled() // scale lines are read-only
	// Price label: the line amount is exactly the printed AED 9.99.
	await expect(lines.nth(2)).toContainText("9.99")
	const priceQty = Number(await qty(2).inputValue())
	expect(priceQty).toBeGreaterThan(0)
	await expect(lines.nth(3)).not.toContainText("Tomato")
	await expect(qty(3)).toHaveValue("1")

	await scan(page, BAD_LABEL)
	await expect(page.getByText(/wrong check digit/i).first()).toBeVisible({
		timeout: 10_000,
	})
	await expect(cart.getByTestId("cart-line")).toHaveCount(4)

	// Removing one of the two identical scale lines leaves the other.
	await lines
		.nth(0)
		.getByRole("button", { name: /remove/i })
		.click()
	await expect(cart.getByTestId("cart-line")).toHaveCount(3)
	await expect(lines.filter({ hasText: "Tomato (per kg) 12345" })).toHaveCount(
		2,
	)
	await expect(qty(0)).toHaveValue("1.25")
	await expect(lines.nth(1)).toContainText("9.99")

	// No server lookups were attempted while offline.
	expect(barcodeCalls).toEqual([])

	await page.screenshot({ path: "test-results/scale-scan-offline.png" })
	await context.setOffline(false)
	await emptyCart(page)

	const ignorable = [
		/nexus_demo/,
		/qz\.get_certificate/,
		/status of 404/,
		/status of 417/,
		/ERR_INTERNET_DISCONNECTED/,
		/Failed to fetch/,
	]
	const unexpected = consoleErrors.filter(
		(e) => !ignorable.some((re) => re.test(e)),
	)
	expect(unexpected, unexpected.join("\n")).toEqual([])
})
