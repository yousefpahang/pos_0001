// pos_0001 Phase 6: SPEC section 6 / 10 sync load test (DECISIONS item 14).
// 5 devices each send their offline queue at the same time, the way the browser does it
// (batches of SYNC_BATCH_SIZE to pos_0001.api.sync.submit_offline_invoices, SYNC_BATCH_LANES
// requests at a time per device). Then every offline id must have exactly one invoice.
//
//   cd POS && yarn perf perf/sync-load.spec.js
//   PERF_API_URL=http://127.0.0.1:8002 (default) PERF_SYNC_COUNT=500 PERF_DEVICES=5
//
// The default target is the multi-worker gunicorn server at 127.0.0.1:8002 (site header
// X-Frappe-Site-Name: pos.test). This test never starts or stops a server.
// Results go to test-results/perf-sync-load.json. Docs: docs/PERFORMANCE.md.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { expect, request, test } from "@playwright/test"
import {
	chunkQueue,
	runInLanes,
	SYNC_BATCH_LANES,
	SYNC_BATCH_SIZE,
} from "../src/plus/core/syncOutcome.js"
import { syncInvoice } from "./syncPayload.js"

const CASHIER = { usr: "cashier@pos.test", pwd: "cashier" }
const ADMIN = { usr: "Administrator", pwd: "admin" }
// Options come from the environment, or from <tmp>/pos0001-sync-load-options.json
// (e.g. {"PERF_SYNC_COUNT": 20, "PERF_DEVICES": 2}).
const FILE_OPTIONS = (() => {
	try {
		return JSON.parse(
			fs.readFileSync(
				path.join(os.tmpdir(), "pos0001-sync-load-options.json"),
				"utf8",
			),
		)
	} catch {
		return {}
	}
})()
const opt = (name, fallback) =>
	process.env[name] ?? FILE_OPTIONS[name] ?? fallback
const API_URL = String(opt("PERF_API_URL", "http://127.0.0.1:8002")).replace(
	/\/$/,
	"",
)
const SITE = String(opt("PERF_API_SITE", "pos.test"))
const TOTAL = Number(opt("PERF_SYNC_COUNT", 500))
const DEVICES = Number(opt("PERF_DEVICES", 5))
const TARGET_MS = 5 * 60_000
const METHOD = "/api/method/pos_next.pos_0001.api.sync.submit_offline_invoices"

const OUT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"test-results",
	"perf-sync-load.json",
)

async function session(user) {
	const ctx = await request.newContext({
		baseURL: API_URL,
		extraHTTPHeaders: { "X-Frappe-Site-Name": SITE },
	})
	const res = await ctx.post("/api/method/login", { data: user })
	expect(res.ok(), await res.text()).toBeTruthy()
	return ctx
}

/** POST one batch; returns the answers and the request time. */
async function sendBatch(ctx, deviceId, invoices) {
	const start = Date.now()
	const res = await ctx.post(METHOD, {
		form: { invoices: JSON.stringify(invoices), device_id: deviceId },
		timeout: 180_000,
	})
	const ms = Date.now() - start
	if (!res.ok()) return { ms, answers: null, error: `${res.status()}` }
	return { ms, answers: (await res.json()).message }
}

test("5 devices sync 500 queued invoices together, no duplicates", async () => {
	test.setTimeout(30 * 60_000)
	const run = `pos_offline_load-${Date.now()}`
	const perDevice = Math.ceil(TOTAL / DEVICES)
	const devices = []
	for (let d = 0; d < DEVICES; d++) {
		const rows = []
		for (let i = 0; i < perDevice && d * perDevice + i < TOTAL; i++) {
			const n = d * perDevice + i
			rows.push(syncInvoice(`${run}-d${d}-${i}`, n))
		}
		devices.push({
			id: `${run}-device-${d}`,
			ctx: await session(CASHIER),
			rows,
		})
	}

	const batchTimes = []
	const statusCount = {}
	const errors = new Set()
	const start = Date.now()
	await Promise.all(
		devices.map(async (device) => {
			// Like the browser: anything not settled is sent again (one more round per batch).
			let pending = device.rows
			for (let round = 0; round < 5 && pending.length; round++) {
				const left = []
				await runInLanes(
					chunkQueue(pending, SYNC_BATCH_SIZE).map((batch) => async () => {
						const { ms, answers } = await sendBatch(
							device.ctx,
							device.id,
							batch,
						)
						batchTimes.push({ ms, size: batch.length })
						batch.forEach((inv, i) => {
							const status = answers?.[i]?.status || "NoAnswer"
							statusCount[status] = (statusCount[status] || 0) + 1
							const error = answers?.[i]?.error
							if (status !== "Synced" && error && errors.size < 5)
								errors.add(String(error).slice(0, 160))
							if (status !== "Synced" && status !== "Failed") left.push(inv)
						})
					}),
					SYNC_BATCH_LANES,
				)
				pending = left
			}
			device.left = pending.length
		}),
	)
	const elapsed = Date.now() - start
	for (const device of devices) await device.ctx.dispose()

	// Server check: one Offline Invoice Sync row and one distinct invoice per offline id.
	const api = await session(ADMIN)
	const res = await api.get("/api/resource/Offline Invoice Sync", {
		params: {
			filters: JSON.stringify([["offline_id", "like", `${run}-%`]]),
			fields: JSON.stringify(["offline_id", "status", "sales_invoice"]),
			limit_page_length: TOTAL * 2,
		},
	})
	const syncRows = (await res.json()).data
	await api.dispose()
	const synced = syncRows.filter((r) => r.status === "Synced")
	const invoices = new Set(synced.map((r) => r.sales_invoice).filter(Boolean))
	const ids = new Set(syncRows.map((r) => r.offline_id))

	const sorted = batchTimes.map((b) => b.ms).sort((a, b) => a - b)
	const perInvoice =
		batchTimes.reduce((s, b) => s + b.ms, 0) /
		Math.max(
			1,
			batchTimes.reduce((s, b) => s + b.size, 0),
		)
	const result = {
		at: new Date().toISOString(),
		api: API_URL,
		devices: DEVICES,
		invoices: TOTAL,
		batch_size: SYNC_BATCH_SIZE,
		lanes_per_device: SYNC_BATCH_LANES,
		elapsed_ms: elapsed,
		target_ms: TARGET_MS,
		met: elapsed < TARGET_MS,
		statuses: statusCount,
		errors: [...errors],
		left_unsettled: devices.reduce((s, d) => s + d.left, 0),
		sync_rows: syncRows.length,
		distinct_offline_ids: ids.size,
		synced: synced.length,
		distinct_invoices: invoices.size,
		batch_ms_median: sorted[Math.floor(sorted.length / 2)] ?? null,
		batch_ms_max: sorted[sorted.length - 1] ?? null,
		request_ms_per_invoice: Math.round(perInvoice),
		throughput_per_min: Math.round((TOTAL / elapsed) * 60_000),
	}
	fs.mkdirSync(path.dirname(OUT), { recursive: true })
	fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`)
	console.log("[perf] sync load", JSON.stringify(result))

	expect(syncRows.length).toBe(TOTAL)
	expect(ids.size).toBe(TOTAL)
	expect(invoices.size).toBe(synced.length)
	expect(result.left_unsettled).toBe(0)
})
