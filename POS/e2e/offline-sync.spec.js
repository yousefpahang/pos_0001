// F1 / F12 end-to-end: offline queue -> reconnect -> server stores the rejected invoice
// as Failed -> fix the cause -> Retry from the sync panel. Runs against the dev site with
// the demo seed (pos_next/pos_0001/demo/seed.py).
import { expect, request, test } from "@playwright/test"

const CASHIER = { usr: "cashier@pos.test", pwd: "cashier" }
const ADMIN = {
	usr: "Administrator",
	pwd: process.env.POS_E2E_ADMIN_PASSWORD || "admin",
}
const PROFILE = "Main Till"
const BAD_CUSTOMER = "POS0001 E2E Disabled Customer"

/** @param {import("@playwright/test").APIRequestContext} api */
async function setCustomerDisabled(api, disabled) {
	const exists = await api.get(
		`/api/resource/Customer/${encodeURIComponent(BAD_CUSTOMER)}`,
	)
	if (exists.status() === 404) {
		const created = await api.post("/api/resource/Customer", {
			data: {
				customer_name: BAD_CUSTOMER,
				customer_group: "Individual",
				territory: "All Territories",
				customer_type: "Individual",
			},
		})
		expect(created.ok(), await created.text()).toBeTruthy()
	}
	const res = await api.put(
		`/api/resource/Customer/${encodeURIComponent(BAD_CUSTOMER)}`,
		{
			data: { disabled: disabled ? 1 : 0 },
		},
	)
	expect(res.ok(), await res.text()).toBeTruthy()
}

/** @param {import("@playwright/test").APIRequestContext} api */
async function syncRow(api, offlineId) {
	const res = await api.get("/api/resource/Offline Invoice Sync", {
		params: {
			filters: JSON.stringify([["offline_id", "=", offlineId]]),
			fields: JSON.stringify([
				"name",
				"status",
				"sales_invoice",
				"error",
				"payload",
				"retry_count",
				"pos_device",
			]),
		},
	})
	expect(res.ok(), await res.text()).toBeTruthy()
	return (await res.json()).data
}

function invoicePayload(offlineId, customer) {
	// ITM-00001 at AED 20 + 5% VAT = AED 21.00, paid in cash.
	return {
		doctype: "Sales Invoice",
		is_pos: 1,
		update_stock: 1,
		pos_profile: PROFILE,
		company: "Demo Trading LLC",
		customer,
		currency: "AED",
		selling_price_list: "Standard Selling",
		set_warehouse: "Stores - DTL",
		taxes_and_charges: "UAE VAT 5% - DTL",
		items: [
			{
				item_code: "ITM-00001",
				qty: 1,
				rate: 20,
				uom: "Nos",
				warehouse: "Stores - DTL",
			},
		],
		payments: [{ mode_of_payment: "Cash", amount: 21 }],
		grand_total: 21,
		offline_id: offlineId,
	}
}

/** Put invoices in POS Next's IndexedDB queue exactly as saveOfflineInvoice() does. */
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

test("offline queue syncs, rejected invoice is stored as Failed and Retry fixes it", async ({
	page,
	context,
	baseURL,
}) => {
	const consoleErrors = []
	page.on("console", (msg) => {
		if (msg.type() === "error") consoleErrors.push(msg.text())
	})
	page.on("response", async (res) => {
		if (res.status() >= 500)
			consoleErrors.push(`HTTP ${res.status()} ${res.url()}`)
		// POS Next fetches a fresh CSRF token at startup while its first calls are in flight;
		// those calls can get a 400 CSRFTokenError (upstream race, see PROGRESS Phase 3).
		// Any other 400 is still an error.
		if (res.status() === 400) {
			const body = await res.text().catch(() => "")
			if (!body.includes("CSRFTokenError"))
				consoleErrors.push(`HTTP 400 ${res.url()} ${body.slice(0, 200)}`)
		}
	})

	const admin = await request.newContext({ baseURL })
	expect(
		(await admin.post("/api/method/login", { data: ADMIN })).ok(),
	).toBeTruthy()
	await setCustomerDisabled(admin, true)

	expect(
		(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
	).toBeTruthy()
	await openTill(page)

	const badge = page.getByTestId("sync-badge")
	await expect(badge).toBeVisible()
	await expect(badge).toHaveAttribute("data-tone", /online|pending|failed/)

	// Go offline: the badge must say so.
	await context.setOffline(true)
	await expect(badge).toHaveAttribute("data-tone", /offline|failed/, {
		timeout: 30_000,
	})

	const goodId = `pos_offline_e2e-${Date.now()}-good`
	const badId = `pos_offline_e2e-${Date.now()}-bad`
	await enqueue(page, [
		invoicePayload(goodId, "Walk-in Customer"),
		invoicePayload(badId, BAD_CUSTOMER),
	])

	// Back online: POS Next syncs on reconnect; open the panel and sync now as well.
	await context.setOffline(false)
	await badge.click()
	const panel = page.getByTestId("sync-log-panel")
	await expect(panel).toBeVisible()
	await expect(page.getByTestId("sync-now")).toBeEnabled({ timeout: 60_000 })
	await page.getByTestId("sync-now").click()

	await expect
		.poll(async () => (await syncRow(admin, goodId))[0]?.status, {
			timeout: 60_000,
		})
		.toBe("Synced")
	await expect
		.poll(async () => (await syncRow(admin, badId))[0]?.status, {
			timeout: 60_000,
		})
		.toBe("Failed")

	const [good] = await syncRow(admin, goodId)
	expect(good.sales_invoice).toBeTruthy()
	expect(good.pos_device).toBeTruthy()
	const [bad] = await syncRow(admin, badId)
	expect(bad.error.toLowerCase()).toContain("disabled")
	expect(JSON.parse(bad.payload).offline_id).toBe(badId)
	expect(bad.retry_count).toBe(1)

	// The browser queue no longer holds either invoice as pending.
	const pending = await page.evaluate(async () => {
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
		return rows.filter(
			(r) => r.offline_id.startsWith("pos_offline_e2e-") && !r.synced,
		).length
	})
	expect(pending).toBe(0)

	// Panel shows the failure with a Retry button; fix the cause and retry.
	await page.getByTestId("sync-now").click()
	const failedRow = panel
		.locator('[data-testid="sync-log-row"][data-status="Failed"]')
		.first()
	await expect(failedRow).toBeVisible({ timeout: 30_000 })
	await expect(failedRow).toContainText(/disabled/i)
	await expect(badge).toHaveAttribute("data-tone", "failed")

	await setCustomerDisabled(admin, false)
	await failedRow.getByTestId("sync-retry").click()
	await expect
		.poll(async () => (await syncRow(admin, badId))[0]?.status, {
			timeout: 60_000,
		})
		.toBe("Synced")

	// Sending the same offline_id again creates no second invoice.
	const again = await page.request.post(
		"/api/method/pos_next.pos_0001.api.sync.submit_offline_invoice",
		{
			headers: {
				"X-Frappe-CSRF-Token": await page.evaluate(
					() => window.csrf_token || "",
				),
			},
			data: {
				invoice: JSON.stringify(invoicePayload(goodId, "Walk-in Customer")),
			},
		},
	)
	expect(again.ok(), await again.text()).toBeTruthy()
	const againBody = (await again.json()).message
	expect(againBody.status).toBe("Synced")
	expect(againBody.invoice_name).toBe(good.sales_invoice)

	const ignorable = [
		/nexus_demo/,
		/qz\.get_certificate/,
		/status of 404/,
		/status of 417/,
		/status of 400/, // checked through the response listener above
		/ERR_INTERNET_DISCONNECTED/,
		/Failed to fetch/,
	]
	const unexpected = consoleErrors.filter(
		(e) => !ignorable.some((re) => re.test(e)),
	)
	expect(unexpected, unexpected.join("\n")).toEqual([])

	await admin.dispose()
})

test("sync badge and panel lay out in RTL without overflow", async ({
	page,
}) => {
	expect(
		(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
	).toBeTruthy()
	await openTill(page)
	await page.evaluate(() => {
		document.documentElement.setAttribute("dir", "rtl")
		document.documentElement.setAttribute("lang", "ar")
	})
	const badge = page.getByTestId("sync-badge")
	await expect(badge).toBeVisible()
	const box = await badge.boundingBox()
	const viewport = page.viewportSize()
	expect(box.x).toBeGreaterThanOrEqual(0)
	expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
	expect(box.height).toBeGreaterThanOrEqual(44)

	await badge.click()
	const panel = page.getByTestId("sync-log-panel")
	await expect(panel).toBeVisible()
	const overflow = await panel.evaluate((el) => el.scrollWidth - el.clientWidth)
	expect(overflow).toBeLessThanOrEqual(1)
	await page.screenshot({ path: "test-results/sync-panel-rtl.png" })
})
