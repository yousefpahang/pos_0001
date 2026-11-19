// F4 end-to-end: barcode label printing without real hardware. A fake QZ Tray answers on
// QZ's WebSocket and records the raw jobs. Checks: on the till, offline, labels for a
// normal item (EAN-13, Arabic name as a ^GFA bitmap, 3 copies) and a scale label made
// from a POS Scale Barcode Rule go to the label printer as ZPL; the desk Print Labels
// button of a Purchase Receipt opens the pos-labels page with the received quantities and
// makes an A4 PDF; the label dialog fits in RTL.
import fs from "node:fs"
import { expect, request, test } from "@playwright/test"

const CASHIER = { usr: "cashier@pos.test", pwd: "cashier" }
const ADMIN = { usr: "Administrator", pwd: "admin" }
const PROFILE = "Main Till"
const PRINTER = "E2E Label ZPL"
const NORMAL_BARCODE = "6290000000016" // ITM-00001, Arabic name from the demo seed

async function admin(baseURL) {
	const ctx = await request.newContext({ baseURL })
	expect(
		(await ctx.post("/api/method/login", { data: ADMIN })).ok(),
	).toBeTruthy()
	return ctx
}

async function api(ctx, method, data) {
	const res = await ctx.post(`/api/method/${method}`, { data })
	expect(res.ok(), await res.text()).toBeTruthy()
	return (await res.json()).message
}

let savedPrinter = null

async function setLabelPrinter(baseURL, printer) {
	const ctx = await admin(baseURL)
	if (printer) {
		const exists = await ctx.get(
			`/api/resource/POS Printer Profile/${encodeURIComponent(PRINTER)}`,
		)
		if (!exists.ok()) {
			const res = await ctx.post("/api/resource/POS Printer Profile", {
				data: {
					printer_name: PRINTER,
					purpose: "Label",
					connection: "QZ Local Printer",
					qz_printer: "Fake Label",
					print_mode: "raster",
					label_language: "ZPL",
				},
			})
			expect(res.ok(), await res.text()).toBeTruthy()
		}
		const current = await ctx.get(
			`/api/resource/POS Profile/${encodeURIComponent(PROFILE)}`,
		)
		savedPrinter = (await current.json()).data.pos0001_label_printer || null
	}
	const res = await ctx.put(
		`/api/resource/POS Profile/${encodeURIComponent(PROFILE)}`,
		{ data: { pos0001_label_printer: printer || savedPrinter } },
	)
	expect(res.ok(), await res.text()).toBeTruthy()
	await ctx.dispose()
}

/** Fake QZ Tray: answers every call, records print jobs. */
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
			else if (msg.call === "printers.find") result = ["Fake Label"]
			else if (msg.call === "print") {
				for (const d of msg.params?.data || []) {
					jobs.push({
						printer: msg.params?.printer,
						flavor: d.flavor,
						bytes: d.flavor === "base64" ? Buffer.from(d.data, "base64") : null,
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
		const plu = await get("items", "PLU-12345")
		const labels = await get("settings", `pos0001_label_cache::${profile}`)
		const scan = await get("settings", `pos0001_scan_cache::${profile}`)
		db.close()
		return {
			items: Boolean(item && plu),
			printer: labels?.value?.printer?.name || null,
			canPrint: Boolean(labels?.value?.can_print),
			arabic: labels?.value?.ar_names?.["ITM-00001"] || null,
			rules: (scan?.value?.cache?.rules || []).length,
		}
	}, PROFILE)
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
	/status of 400/,
	/ERR_INTERNET_DISCONNECTED/,
	/Failed to fetch/,
	/WebSocket connection to 'wss?:\/\/localhost/,
]

function unexpected(errors) {
	return errors.filter((e) => !IGNORABLE.some((re) => re.test(e)))
}

/** Decode the first ^GFA field of a ZPL job and save it as a PNG. */
async function saveGfaPng(page, zpl, path) {
	const m = /\^GFA,(\d+),\d+,(\d+),([0-9A-F]+)\^FS/.exec(zpl)
	expect(m, "Arabic bitmap (^GFA) in the job").toBeTruthy()
	const bpr = Number(m[2])
	const bytes = Buffer.from(m[3], "hex")
	const rows = bytes.length / bpr
	let ink = 0
	for (const b of bytes) ink += b.toString(2).split("1").length - 1
	const dataUrl = await page.evaluate(
		({ bpr, rows, data }) => {
			const c = document.createElement("canvas")
			c.width = bpr * 8
			c.height = rows
			const ctx = c.getContext("2d")
			ctx.fillStyle = "#fff"
			ctx.fillRect(0, 0, c.width, c.height)
			ctx.fillStyle = "#000"
			for (let y = 0; y < rows; y++)
				for (let x = 0; x < bpr * 8; x++)
					if (data[y * bpr + (x >> 3)] & (0x80 >> (x & 7)))
						ctx.fillRect(x, y, 1, 1)
			return c.toDataURL("image/png")
		},
		{ bpr, rows, data: [...bytes] },
	)
	fs.writeFileSync(path, Buffer.from(dataUrl.split(",")[1], "base64"))
	return { width: bpr * 8, rows, ink }
}

test.describe
	.serial("label printing", () => {
		test.beforeAll(async ({ baseURL }) => {
			await setLabelPrinter(baseURL, PRINTER)
		})
		test.afterAll(async ({ baseURL }) => {
			await setLabelPrinter(baseURL, null)
		})

		test("till offline: ZPL labels with Arabic bitmap and a scale label go to the label printer", async ({
			page,
			context,
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
					items: true,
					printer: PRINTER,
					canPrint: true,
					arabic: "مناديل فاخرة",
					rules: 2,
				})

			await context.setOffline(true)
			await expect(page.getByTestId("sync-badge")).toHaveAttribute(
				"data-tone",
				/offline|failed/,
				{ timeout: 30_000 },
			)
			await page.getByTestId("label-button").click()
			const panel = page.getByTestId("label-panel")
			await expect(panel).toBeVisible()
			await expect(panel.getByTestId("label-template")).toHaveValue(
				"Shelf Label 38x25 (ZPL)",
			)

			// Normal item by barcode (offline: browser cache), 3 labels.
			const search = panel.getByTestId("label-search")
			await search.fill(NORMAL_BARCODE)
			await search.press("Enter")
			const lines = panel.getByTestId("label-line")
			await expect(lines).toHaveCount(1, { timeout: 15_000 })
			await expect(lines.first()).toContainText("مناديل فاخرة")
			await lines.first().getByTestId("label-qty").fill("3")
			await lines.first().getByTestId("label-qty").dispatchEvent("change")

			// Weighed item as a scale label of 1.250 kg (rule A of SPEC F5).
			await search.fill("PLU-12345")
			await search.press("Enter")
			await expect(lines).toHaveCount(2, { timeout: 15_000 })
			const scale = lines.nth(1)
			await scale
				.getByTestId("label-scale-rule")
				.selectOption("Scale Weight 20")
			await scale.getByTestId("label-scale-value").fill("1.25")
			await scale.getByTestId("label-scale-value").dispatchEvent("change")
			await expect(scale).toContainText("2012345012509", { timeout: 10_000 })
			await expect(scale).toContainText("1.250 Kg")
			await expect(panel.getByTestId("label-total")).toContainText("4")

			await panel.getByTestId("label-print").click()
			await expect.poll(() => jobs.length, { timeout: 20_000 }).toBe(1)
			const job = jobs[0]
			expect(job.printer?.name).toBe("Fake Label")
			expect(job.flavor).toBe("base64")
			const zpl = job.bytes.toString("latin1")
			expect(zpl.startsWith("^XA\n^CI28\n^PW304\n^LL200\n")).toBe(true)
			expect(zpl).toContain("^FDPremium Tissue 500g #1^FS")
			expect(zpl).toContain("^BEN,52,Y,N^FD629000000001^FS")
			expect(zpl).toContain("^PQ3\n^XZ\n")
			expect(zpl).toContain("^FD201234501250^FS") // scale label EAN-13 data digits
			expect(zpl.match(/\^XA/g)).toHaveLength(2)
			const bitmap = await saveGfaPng(
				page,
				zpl,
				"test-results/label-arabic.png",
			)
			expect(bitmap.width).toBeLessThanOrEqual(288)
			expect(bitmap.rows).toBe(24)
			expect(bitmap.ink).toBeGreaterThan(80)
			await expect(panel.getByTestId("label-message")).toContainText("4")

			await context.setOffline(false)
			const bad = unexpected(errors)
			expect(bad, bad.join("\n")).toEqual([])
		})

		test("desk: Print Labels on a Purchase Receipt opens pos-labels and makes an A4 PDF", async ({
			page,
			baseURL,
		}) => {
			test.setTimeout(180_000)
			const errors = watchErrors(page)
			const ctx = await admin(baseURL)
			const profile = await api(ctx, "frappe.client.get", {
				doctype: "POS Profile",
				name: PROFILE,
			})
			const groups = await api(ctx, "frappe.client.get_list", {
				doctype: "Supplier Group",
				filters: { is_group: 0 },
				limit_page_length: 1,
			})
			const supplier = "E2E Label Supplier"
			const has = await ctx.get(
				`/api/resource/Supplier/${encodeURIComponent(supplier)}`,
			)
			if (!has.ok()) {
				const res = await ctx.post("/api/resource/Supplier", {
					data: {
						supplier_name: supplier,
						supplier_group: groups[0].name,
					},
				})
				expect(res.ok(), await res.text()).toBeTruthy()
			}
			const created = await ctx.post("/api/resource/Purchase Receipt", {
				data: {
					company: profile.company,
					supplier,
					set_warehouse: profile.warehouse,
					items: [
						{
							item_code: "ITM-00001",
							qty: 5,
							rate: 10,
							warehouse: profile.warehouse,
						},
					],
				},
			})
			expect(created.ok(), await created.text()).toBeTruthy()
			const receipt = (await created.json()).data.name
			await ctx.dispose()

			expect(
				(await page.request.post("/api/method/login", { data: ADMIN })).ok(),
			).toBeTruthy()
			await page.goto(`/app/purchase-receipt/${encodeURIComponent(receipt)}`)
			await page
				.getByRole("button", { name: "Print Labels" })
				.click({ timeout: 60_000 })
			await expect(page).toHaveURL(/\/app\/pos-labels/)
			const frame = page.frameLocator("iframe.pos0001-labels-frame")
			const lines = frame.getByTestId("label-line")
			await expect(lines).toHaveCount(1, { timeout: 60_000 })
			await expect(lines.first().getByTestId("label-qty")).toHaveValue("5")
			await expect(frame.getByTestId("label-source")).toContainText(receipt)
			await frame
				.getByTestId("label-template")
				.selectOption("A4 Sheet 3x8 (PDF)")
			const pdfResponse = page.waitForResponse(
				(res) =>
					res.url().includes("pos_0001.api.labels.render") &&
					res.request().method() === "POST",
			)
			const popup = page.context().waitForEvent("page", { timeout: 30_000 })
			await frame.getByTestId("label-pdf").click()
			const out = (await (await pdfResponse).json()).message
			expect(out.language).toBe("PDF")
			expect(out.labels).toBe(5)
			const pdfPage = await popup
			await pdfPage.close()
			const file = await page.request.get(out.file_url)
			expect(file.ok()).toBeTruthy()
			const body = await file.body()
			expect(body.subarray(0, 4).toString()).toBe("%PDF")
			fs.writeFileSync("test-results/labels-a4.pdf", body)

			const bad = unexpected(errors)
			expect(bad, bad.join("\n")).toEqual([])
		})

		test("label dialog fits in RTL with 44 px targets", async ({
			page,
			context,
		}) => {
			test.setTimeout(120_000)
			await fakeQz(context)
			expect(
				(await page.request.post("/api/method/login", { data: CASHIER })).ok(),
			).toBeTruthy()
			await openTill(page)
			await page.evaluate(() =>
				document.documentElement.setAttribute("dir", "rtl"),
			)
			const button = page.getByTestId("label-button")
			await expect(button).toBeVisible({ timeout: 60_000 })
			const box = await button.boundingBox()
			expect(box.height).toBeGreaterThanOrEqual(44)
			expect(box.width).toBeGreaterThanOrEqual(44)
			expect(box.x).toBeGreaterThanOrEqual(0)
			expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width)
			await button.click()
			const panel = page.getByTestId("label-panel")
			await expect(panel).toBeVisible()
			const search = panel.getByTestId("label-search")
			await search.fill(NORMAL_BARCODE)
			await search.press("Enter")
			await expect(panel.getByTestId("label-line")).toHaveCount(1, {
				timeout: 15_000,
			})
			expect(
				await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
			).toBe(true)
			for (const id of [
				"label-template",
				"label-search",
				"label-qty",
				"label-price",
				"label-remove",
				"label-print",
			]) {
				expect(
					(await panel.getByTestId(id).first().boundingBox()).height,
					id,
				).toBeGreaterThanOrEqual(44)
			}
			await page.screenshot({ path: "test-results/label-dialog-rtl.png" })
		})
	})
