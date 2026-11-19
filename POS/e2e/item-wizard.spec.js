// Phase 8 (SPEC F13, section 10): the rice example from SPEC 5a through the Item Wizard
// (/pos/items/new, 8 steps), then sold at the till: 250 g typed in grams on the Kg line, a
// 500 g pack and a whole bag picked with the cart line's unit picker. Checks the records the
// wizard wrote, the invoice lines and prices, and that stock drops by 0.25, 0.5 and 25 Kg.
// Also: desk "Create with Wizard" button, the role check, and no console errors.
import { expect, request, test } from "@playwright/test"

const ADMIN = { usr: "Administrator", pwd: "admin" }
const CASHIER = { usr: "cashier@pos.test", pwd: "cashier" }
const PROFILE = "Main Till"
const WAREHOUSE = "Stores - DTL"

const IGNORABLE = [
	/nexus_demo/,
	/status of 404/,
	/status of 417/,
	/status of 400/,
	/status of 403/,
	/frappe\.client\.get_value PermissionError/,
	/qz\./i,
	/WebSocket connection/,
]

function watchErrors(page) {
	const errors = []
	page.on("console", (msg) => {
		if (msg.type() === "error") errors.push(msg.text())
	})
	page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`))
	page.on("response", (res) => {
		if (res.status() >= 500) errors.push(`HTTP ${res.status()} ${res.url()}`)
	})
	return errors
}

const unexpected = (errors) =>
	errors.filter((e) => !IGNORABLE.some((re) => re.test(e)))

async function login(page, user) {
	expect(
		(await page.request.post("/api/method/login", { data: user })).ok(),
	).toBeTruthy()
}

async function api(ctx, method, params = {}) {
	const res = await ctx.get(`/api/method/${method}`, { params })
	expect(res.ok(), await res.text()).toBeTruthy()
	return (await res.json()).message
}

async function getDoc(ctx, doctype, name) {
	const res = await ctx.get(
		`/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
	)
	expect(res.ok(), await res.text()).toBeTruthy()
	return (await res.json()).data
}

async function binQty(ctx, item) {
	const out = await api(ctx, "frappe.client.get_value", {
		doctype: "Bin",
		filters: JSON.stringify({ item_code: item, warehouse: WAREHOUSE }),
		fieldname: "actual_qty",
	})
	return Number(out?.actual_qty || 0)
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

/**
 * Scan an item with several units: POS Next asks which unit (the dialog shows each unit's
 * price). A till that has not refreshed its scan cache since the item was created does not
 * know which unit a barcode belongs to yet.
 */
async function scanAndPick(page, code, uom, expectedRate) {
	await scan(page, code)
	const dialog = page
		.getByRole("dialog")
		.filter({ has: page.getByRole("button", { name: "Add to Cart" }) })
	await expect(dialog).toBeVisible({ timeout: 30_000 })
	const option = dialog.getByRole("button", { name: new RegExp(`^${uom}\\b`) })
	await expect(option).toContainText(expectedRate)
	await option.click()
	await dialog.getByRole("button", { name: "Add to Cart" }).click()
	await expect(dialog).toBeHidden({ timeout: 15_000 })
}

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
		return row ? { offline_id: row.offline_id, synced: row.synced } : null
	})
}

const next = (page) => page.getByTestId("wizard-next").click()
const atStep = (page, step) =>
	expect(page.getByTestId("item-wizard-page")).toHaveAttribute(
		"data-step",
		step,
	)

test("Item Wizard: rice in 25 kg bags, then sell 250 g, a 500 g pack and a bag", async ({
	page,
	browser,
	baseURL,
}) => {
	test.setTimeout(300_000)
	const errors = watchErrors(page)
	const name = `E2E Basmati Rice ${Date.now().toString(36)}`

	// --- Desk entry point and role check -------------------------------------------------
	await login(page, ADMIN)
	await page.goto("/app/item")
	await expect(
		page.getByRole("button", { name: "Create with Wizard" }),
	).toBeVisible({ timeout: 60_000 })

	// --- The wizard ----------------------------------------------------------------------
	const started = Date.now()
	await page.goto("/pos/items/new")
	await expect(page.getByTestId("wizard-preset-0")).toBeVisible({
		timeout: 60_000,
	})
	const profileSelect = page.getByTestId("wizard-profile")
	if (await profileSelect.isVisible()) await profileSelect.selectOption(PROFILE)
	await expect(page.getByTestId("wizard-progress")).toHaveAttribute(
		"aria-valuenow",
		"13",
	)
	await expect(page.getByTestId("wizard-preset-0")).toContainText(
		"Bulk by weight",
	)
	await page.getByTestId("wizard-preset-0").click()

	// 2. Basics (Next is blocked without a name)
	await atStep(page, "basics")
	await next(page)
	await expect(page.getByTestId("wizard-errors")).toContainText(
		"Item name is required",
	)
	await page.getByTestId("wizard-item-name").fill(name)
	await page.getByTestId("wizard-item-name-ar").fill("أرز بسمتي")
	await page.getByTestId("wizard-item-group").selectOption("Groceries")
	await expect(page.getByTestId("wizard-item-code")).toHaveValue(/^GROC-\d{5}$/)
	const itemCode = await page.getByTestId("wizard-item-code").inputValue()
	await next(page)

	// 3. How you buy it: 1 Bag = 25 Kg at AED 75
	await atStep(page, "buying")
	await expect(page.getByTestId("wizard-stock-uom")).toHaveValue("Kg")
	await expect(page.getByTestId("wizard-buying-uom").first()).toHaveValue("Bag")
	await expect(page.getByTestId("wizard-buying-size").first()).toHaveValue("25")
	await page.getByTestId("wizard-buying-price").fill("75")
	await expect(page.getByTestId("wizard-cost-per-stock")).toContainText("3.00")
	await next(page)

	// 4. How you sell it: Kg, Pack 500 g, Bag; gram entry; on the scale
	await atStep(page, "selling")
	await expect(page.getByTestId("wizard-selling-uom")).toHaveCount(3)
	await expect(page.getByTestId("wizard-entry-unit")).toContainText("Gram")
	await expect(page.getByTestId("wizard-sold-on-scale")).toBeChecked()
	await next(page)

	// 5. Prices: 4.50 per Kg incl. VAT, pack 2.25 calculated -> 2.50, bag 99.00
	await atStep(page, "prices")
	await page.getByTestId("wizard-base-price").fill("4.50")
	const row = (uom) =>
		page.locator(`[data-testid="wizard-price-row"][data-uom="${uom}"]`)
	await expect(row("Pack")).toContainText("2.25")
	await expect(row("Bag")).toContainText("112.50")
	await row("Pack").getByTestId("wizard-unit-price").fill("2.50")
	await row("Bag").getByTestId("wizard-unit-price").fill("99")
	await expect(row("Kg").getByTestId("wizard-shelf-price")).toContainText(
		"4.50",
	)
	await expect(row("Kg")).toContainText("50%")
	await expect(row("Pack").getByTestId("wizard-shelf-price")).toContainText(
		"2.50",
	)
	await expect(row("Bag").getByTestId("wizard-shelf-price")).toContainText(
		"99.00",
	)
	await expect(page.getByTestId("wizard-warnings")).toHaveCount(0)
	await page.getByTestId("wizard-base-price").fill("2.00")
	await expect(page.getByTestId("wizard-warnings")).toContainText(
		"sells below cost",
	)
	await page.getByTestId("wizard-base-price").fill("4.50")
	await expect(page.getByTestId("wizard-warnings")).toHaveCount(0)
	await next(page)

	// 6. Barcodes: generate one per unit
	await atStep(page, "barcodes")
	const generate = page.getByTestId("wizard-generate")
	await expect(generate).toHaveCount(3)
	for (let i = 0; i < 3; i++) {
		await generate.nth(i).click()
		await expect(page.getByTestId("wizard-barcode").nth(i)).toHaveValue(
			/^29\d{11}$/,
		)
	}
	const barcode = async (uom) =>
		page
			.locator(`[data-testid="wizard-barcode-row"][data-uom="${uom}"]`)
			.getByTestId("wizard-barcode")
			.inputValue()
	const codes = {
		Kg: await barcode("Kg"),
		Pack: await barcode("Pack"),
		Bag: await barcode("Bag"),
	}
	expect(new Set(Object.values(codes)).size).toBe(3)
	await next(page)

	// 7. Opening stock: 4 Bags = 100 Kg
	await atStep(page, "stock")
	await page.getByTestId("wizard-stock-qty").fill("4")
	await expect(page.getByTestId("wizard-stock-uom-select")).toHaveValue("Bag")
	await expect(page.getByTestId("wizard-warehouse")).toHaveValue(WAREHOUSE)
	await expect(page.getByTestId("wizard-stock-converted")).toContainText(
		"100 Kg",
	)
	await next(page)

	// 8. Review and create
	await atStep(page, "review")
	await expect(page.getByTestId("wizard-progress")).toHaveAttribute(
		"aria-valuenow",
		"100",
	)
	await expect(page.getByTestId("wizard-review-row")).toHaveCount(3)
	await page.getByTestId("wizard-create").click()
	await expect(page.getByTestId("wizard-done")).toContainText(itemCode, {
		timeout: 60_000,
	})
	const wizardSeconds = Math.round((Date.now() - started) / 1000)
	console.log(`wizard filled and created by the test in ${wizardSeconds} s`)
	await expect(page.getByTestId("wizard-print-labels")).toBeVisible()
	await expect(page.getByTestId("wizard-another")).toBeVisible()
	await page.screenshot({
		path: "test-results/item-wizard-done.png",
		fullPage: true,
	})

	// --- What Create wrote ---------------------------------------------------------------
	const admin = await request.newContext({ baseURL })
	expect(
		(await admin.post("/api/method/login", { data: ADMIN })).ok(),
	).toBeTruthy()
	const item = await getDoc(admin, "Item", itemCode)
	expect(item.item_name).toBe(name)
	expect(item.item_name_ar).toBe("أرز بسمتي")
	expect(item.stock_uom).toBe("Kg")
	expect(item.purchase_uom).toBe("Bag")
	expect(item.scale_plu).toMatch(/^\d{5}$/)
	expect(
		Object.fromEntries(item.uoms.map((u) => [u.uom, u.conversion_factor])),
	).toEqual({ Kg: 1, Pack: 0.5, Bag: 25 })
	expect(
		Object.fromEntries(item.barcodes.map((b) => [b.uom, b.barcode])),
	).toEqual(codes)
	expect(item.taxes.map((t) => t.item_tax_template)).toEqual([
		"UAE VAT 5% - DTL",
	])
	const prices = await api(admin, "frappe.client.get_list", {
		doctype: "Item Price",
		filters: JSON.stringify({ item_code: itemCode }),
		fields: JSON.stringify(["price_list", "uom", "price_list_rate"]),
	})
	const priceMap = Object.fromEntries(
		prices.map((p) => [`${p.price_list}:${p.uom}`, p.price_list_rate]),
	)
	expect(priceMap).toEqual({
		"Standard Selling:Kg": 4.29,
		"Standard Selling:Pack": 2.38,
		"Standard Selling:Bag": 94.29,
		"Standard Buying:Bag": 75,
	})
	expect(await binQty(admin, itemCode)).toBe(100)

	// --- Sell at the till -------------------------------------------------------------------
	const tillContext = await browser.newContext({
		baseURL,
		viewport: { width: 1280, height: 800 },
	})
	const till = await tillContext.newPage()
	const tillErrors = watchErrors(till)
	await login(till, CASHIER)
	expect(
		(await api(till.request, "pos_next.pos_0001.api.items.can_use_item_wizard"))
			.allowed,
	).toBe(false)
	await openTill(till)
	await emptyCart(till)
	const lines = till.getByTestId("invoice-cart-lines").getByTestId("cart-line")

	// Kg line switched to Bag with the unit picker
	await scanAndPick(till, codes.Kg, "Kg", "4.29")
	await expect(lines).toHaveCount(1, { timeout: 30_000 })
	await expect(lines.first().getByTestId("gram-entry-button")).toBeVisible()
	await lines.first().getByTitle("Click to change unit").click()
	await lines.first().getByRole("button", { name: "Bag", exact: true }).click()
	await expect(lines.first()).toContainText("Bag")
	await expect(lines.first()).toContainText("94.29")
	await expect(lines.first().getByTestId("gram-entry-button")).toHaveCount(0)

	// A Kg line with 250 typed in grams
	await scanAndPick(till, codes.Kg, "Kg", "4.29")
	await expect(lines).toHaveCount(2, { timeout: 30_000 })
	const kgLine = lines.filter({ has: till.getByTestId("gram-entry-button") })
	await kgLine.getByTestId("gram-entry-button").click()
	await kgLine.getByTestId("gram-entry-input").fill("250")
	await expect(kgLine.getByTestId("gram-entry-panel")).toContainText("0.250")
	await kgLine.getByTestId("gram-entry-apply").click()
	await expect(kgLine.getByRole("textbox", { name: "Quantity" })).toHaveValue(
		/^0\.25/,
	)

	// The 500 g pack by its own barcode
	await scanAndPick(till, codes.Pack, "Pack", "2.38")
	await expect(lines).toHaveCount(3, { timeout: 30_000 })
	await till.screenshot({ path: "test-results/item-wizard-cart.png" })

	await till.getByRole("button", { name: "Proceed to payment" }).click()
	const dialog = till.getByRole("dialog").filter({ hasText: "Sales Person" })
	await dialog.getByRole("button", { name: /Cash$/ }).first().click()
	await dialog
		.getByText("Quick amounts for Cash")
		.locator("xpath=following-sibling::div[1]//button")
		.first()
		.click()
	const complete = dialog
		.getByRole("button", { name: "Complete Payment" })
		.first()
	await expect(complete).toBeEnabled({ timeout: 15_000 })
	await complete.click()
	await expect
		.poll(async () => (await lastQueued(till))?.synced, {
			timeout: 90_000,
			intervals: [2_000],
		})
		.toBeTruthy()
	const queued = await lastQueued(till)

	const sync = await api(admin, "frappe.client.get_value", {
		doctype: "Offline Invoice Sync",
		filters: JSON.stringify({ offline_id: queued.offline_id }),
		fieldname: JSON.stringify(["status", "sales_invoice"]),
	})
	expect(sync.status).toBe("Synced")
	const invoice = await getDoc(admin, "Sales Invoice", sync.sales_invoice)
	expect(invoice.docstatus).toBe(1)
	const got = invoice.items
		.map((r) => ({
			uom: r.uom,
			qty: r.qty,
			stock_qty: r.stock_qty,
			price_list_rate: r.price_list_rate,
			amount: r.amount,
		}))
		.sort((a, b) => a.uom.localeCompare(b.uom))
	// POS Next sends rate = amount / qty for fractional lines (1.07 / 0.25 = 4.28), so the Kg
	// line is checked by its list price and amount (0.25 x 4.29 = 1.0725 -> 1.07).
	expect(got).toEqual([
		{
			uom: "Bag",
			qty: 1,
			stock_qty: 25,
			price_list_rate: 94.29,
			amount: 94.29,
		},
		{
			uom: "Kg",
			qty: 0.25,
			stock_qty: 0.25,
			price_list_rate: 4.29,
			amount: 1.07,
		},
		{
			uom: "Pack",
			qty: 1,
			stock_qty: 0.5,
			price_list_rate: 2.38,
			amount: 2.38,
		},
	])
	// Customer prices incl. 5% VAT: bag 99.00, pack 2.50, 250 g at 4.50/kg = 1.12
	const withVat = (v) => Math.round(v * 1.05 * 100) / 100
	expect(got.map((r) => withVat(r.amount))).toEqual([99, 1.12, 2.5])
	expect(invoice.total_taxes_and_charges).toBeCloseTo(4.89, 2)

	// Stock drops by 25 + 0.25 + 0.5 Kg
	await expect
		.poll(async () => binQty(admin, itemCode), { timeout: 30_000 })
		.toBe(74.25)
	const sle = await api(admin, "frappe.client.get_list", {
		doctype: "Stock Ledger Entry",
		filters: JSON.stringify({
			item_code: itemCode,
			voucher_no: invoice.name,
			is_cancelled: 0,
		}),
		fields: JSON.stringify(["actual_qty"]),
	})
	expect(sle.map((r) => r.actual_qty).sort((a, b) => a - b)).toEqual([
		-25, -0.5, -0.25,
	])

	await admin.dispose()
	expect(unexpected(errors), unexpected(errors).join("\n")).toEqual([])
	expect(unexpected(tillErrors), unexpected(tillErrors).join("\n")).toEqual([])
	await tillContext.close()
})

test("Item Wizard in Arabic: RTL layout, 44 px targets, no sideways scroll", async ({
	page,
}) => {
	await login(page, ADMIN)
	await page.goto("/pos/items/new")
	await expect(page.getByTestId("wizard-preset-0")).toBeVisible({
		timeout: 60_000,
	})
	await page.evaluate(() => {
		document.documentElement.dir = "rtl"
		document.documentElement.lang = "ar"
	})
	for (const width of [1024, 1280]) {
		await page.setViewportSize({ width, height: 768 })
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth - window.innerWidth,
		)
		expect(overflow).toBeLessThanOrEqual(1)
		const small = await page.evaluate(
			() =>
				[
					...document.querySelectorAll(
						"[data-testid^='wizard-preset'], [data-testid='wizard-blank']",
					),
				]
					.map((el) => el.getBoundingClientRect())
					.filter((r) => r.height < 44).length,
		)
		expect(small).toBe(0)
	}
	await page.getByTestId("wizard-preset-0").click()
	await expect(page.getByTestId("item-wizard-page")).toHaveAttribute(
		"data-step",
		"basics",
	)
	const nextBox = await page.getByTestId("wizard-next").boundingBox()
	const backBox = await page.getByTestId("wizard-back").boundingBox()
	expect(nextBox.height).toBeGreaterThanOrEqual(44)
	expect(nextBox.x).toBeLessThan(backBox.x) // mirrored: Next on the left in RTL
	await page.screenshot({
		path: "test-results/item-wizard-rtl.png",
		fullPage: true,
	})
})
