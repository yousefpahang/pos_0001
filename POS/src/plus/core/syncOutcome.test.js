import { describe, expect, it } from "vitest"
import {
	AUTO_SYNC_INTERVAL_MS,
	SYNC_BATCH_SIZE,
	badgeState,
	buildSyncLogRows,
	chunkQueue,
	classifySubmitResponse,
	matchBatchResponses,
	plainError,
	queueUpdateFor,
	runInLanes,
	shouldAutoSync,
} from "./syncOutcome.js"

describe("batch sync helpers", () => {
	it("chunks the queue in order, within the server limit of 25", () => {
		expect(SYNC_BATCH_SIZE).toBeLessThanOrEqual(25)
		expect(chunkQueue([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
		expect(chunkQueue([], 10)).toEqual([])
		expect(chunkQueue([1, 2], 0)).toEqual([[1], [2]])
	})

	it("matches answers by offline_id, null when missing", () => {
		const answers = [
			{ offline_id: "b", status: "Failed", stored: true },
			{ offline_id: "a", status: "Synced", invoice_name: "SINV-1" },
		]
		const matched = matchBatchResponses(["a", "b", "c", undefined], answers)
		expect(matched[0].invoice_name).toBe("SINV-1")
		expect(matched[1].status).toBe("Failed")
		expect(matched[2]).toBeNull()
		expect(matched[3]).toBeNull()
		expect(matchBatchResponses(["a"], null)).toEqual([null])
		expect(matchBatchResponses(["a"], { message: "x" })).toEqual([null])
	})

	it("an Error answer keeps the invoice queued", () => {
		expect(
			classifySubmitResponse({
				offline_id: "a",
				status: "Error",
				error: "Lock wait timeout",
				stored: false,
			}).action,
		).toBe("retry_later")
	})

	it("runs jobs with at most N at once and catches each error", async () => {
		let running = 0
		let peak = 0
		const job =
			(value, fail = false) =>
			async () => {
				running++
				peak = Math.max(peak, running)
				await new Promise((r) => setTimeout(r, 5))
				running--
				if (fail) throw new Error(`bad ${value}`)
				return value
			}
		const results = await runInLanes(
			[job(1), job(2, true), job(3), job(4), job(5)],
			2,
		)
		expect(peak).toBe(2)
		expect(results.map((r) => r.ok)).toEqual([true, false, true, true, true])
		expect(results[0].value).toBe(1)
		expect(results[1].error.message).toBe("bad 2")
		expect(results[4].value).toBe(5)
		expect(await runInLanes([], 2)).toEqual([])
	})
})

describe("classifySubmitResponse", () => {
	it("synced with an invoice name leaves the queue", () => {
		expect(
			classifySubmitResponse({
				offline_id: "a",
				status: "Synced",
				invoice_name: "ACC-SINV-1",
			}),
		).toEqual({ action: "synced", invoiceName: "ACC-SINV-1", error: null })
	})

	it("failed and stored on the server leaves the queue", () => {
		expect(
			classifySubmitResponse({
				offline_id: "a",
				status: "Failed",
				stored: true,
				error: "Customer is disabled",
			}),
		).toEqual({
			action: "stored_failed",
			invoiceName: null,
			error: "Customer is disabled",
		})
	})

	it("failed but not stored stays queued", () => {
		expect(
			classifySubmitResponse({ status: "Failed", stored: false }).action,
		).toBe("retry_later")
		expect(classifySubmitResponse({ status: "Failed" }).action).toBe(
			"retry_later",
		)
	})

	it("pending, synced without name, and junk stay queued", () => {
		expect(classifySubmitResponse({ status: "Pending" }).action).toBe(
			"retry_later",
		)
		expect(classifySubmitResponse({ status: "Synced" }).action).toBe(
			"retry_later",
		)
		expect(classifySubmitResponse(null).action).toBe("retry_later")
		expect(classifySubmitResponse("ok").action).toBe("retry_later")
	})
})

describe("queueUpdateFor", () => {
	it("marks synced rows", () => {
		expect(
			queueUpdateFor({ action: "synced", invoiceName: "X", error: null }, 5),
		).toEqual({
			synced: true,
			server_invoice: "X",
			server_status: "Synced",
			server_error: null,
			synced_at: 5,
		})
	})

	it("keeps the error on stored failures", () => {
		expect(
			queueUpdateFor(
				{ action: "stored_failed", invoiceName: null, error: "bad" },
				5,
			),
		).toMatchObject({
			synced: true,
			server_status: "Failed",
			server_error: "bad",
		})
	})

	it("returns null for retry_later so the row is untouched", () => {
		expect(
			queueUpdateFor({ action: "retry_later", invoiceName: null, error: null }),
		).toBeNull()
	})
})

describe("buildSyncLogRows", () => {
	const local = [
		{
			offline_id: "p1",
			timestamp: 3000,
			synced: false,
			data: { grand_total: 10.5, customer: "A" },
		},
		{
			offline_id: "f1",
			timestamp: 2000,
			synced: true,
			server_status: "Failed",
			server_error: "<b>Customer</b> is disabled",
			data: { grand_total: 20 },
		},
		{
			offline_id: "s1",
			timestamp: 1000,
			synced: true,
			server_status: "Synced",
			server_invoice: "INV-1",
			data: {},
		},
		{
			offline_id: "x",
			timestamp: 4000,
			synced: false,
			superseded: true,
			data: {},
		},
	]

	it("maps local queue rows, newest first, skipping superseded", () => {
		const rows = buildSyncLogRows(local, [])
		expect(rows.map((r) => [r.offlineId, r.status])).toEqual([
			["p1", "Pending"],
			["f1", "Failed"],
			["s1", "Synced"],
		])
		expect(rows[1].error).toBe("Customer is disabled")
		expect(rows[1].canRetry).toBe(true)
		expect(rows[0].canRetry).toBe(false)
		expect(rows[0].total).toBe(10.5)
	})

	it("server rows override local rows with the same offline_id", () => {
		const rows = buildSyncLogRows(local, [
			{
				offline_id: "f1",
				status: "Synced",
				sales_invoice: "INV-9",
				grand_total: 21,
				creation: "2026-11-19 10:00:00",
			},
			{
				offline_id: "srv",
				status: "Failed",
				error: "Stock is short",
				grand_total: 5,
				creation: "2026-11-19 09:00:00",
			},
		])
		const f1 = rows.find((r) => r.offlineId === "f1")
		expect(f1).toMatchObject({
			status: "Synced",
			invoiceName: "INV-9",
			total: 21,
			error: null,
			time: 2000,
		})
		const srv = rows.find((r) => r.offlineId === "srv")
		expect(srv).toMatchObject({
			status: "Failed",
			canRetry: true,
			source: "server",
		})
		expect(srv.time).toBe(Date.parse("2026-11-19T09:00:00"))
	})

	it("handles empty and missing input", () => {
		expect(buildSyncLogRows()).toEqual([])
		expect(buildSyncLogRows([null, {}], [null, {}])).toEqual([])
	})
})

describe("badgeState", () => {
	it("online with nothing queued", () => {
		expect(badgeState({ isOffline: false, pending: 0, failed: 0 })).toEqual({
			tone: "online",
			pending: 0,
			failed: 0,
		})
	})
	it("offline", () => {
		expect(badgeState({ isOffline: true, pending: 2, failed: 0 }).tone).toBe(
			"offline",
		)
	})
	it("pending while online", () => {
		expect(badgeState({ isOffline: false, pending: 2, failed: 0 }).tone).toBe(
			"pending",
		)
	})
	it("failed wins", () => {
		expect(badgeState({ isOffline: true, pending: 2, failed: 1 }).tone).toBe(
			"failed",
		)
	})
	it("clamps bad numbers", () => {
		expect(
			badgeState({ isOffline: false, pending: -1, failed: Number.NaN }),
		).toEqual({
			tone: "online",
			pending: 0,
			failed: 0,
		})
	})
})

describe("plainError", () => {
	it("returns null for empty", () => {
		expect(plainError(null)).toBeNull()
		expect(plainError("")).toBeNull()
		expect(plainError(undefined)).toBeNull()
	})
	it("strips html and entities", () => {
		expect(plainError("Row 1: <strong>ITM-1</strong> &amp; more")).toBe(
			"Row 1: ITM-1 & more",
		)
	})
	it("keeps the last traceback line without the exception class", () => {
		const tb =
			'Traceback (most recent call last):\n  File "x.py", line 1\nfrappe.exceptions.ValidationError: Customer X is disabled'
		expect(plainError(tb)).toBe("Customer X is disabled")
	})
	it("reads Error objects", () => {
		expect(plainError(new Error("Network down"))).toBe("Network down")
	})
	it("truncates long text", () => {
		expect(plainError("a".repeat(500))).toHaveLength(300)
	})
})

describe("shouldAutoSync", () => {
	it("runs only online, idle and with pending invoices", () => {
		expect(
			shouldAutoSync({ isOffline: false, pending: 1, isSyncing: false }),
		).toBe(true)
		expect(
			shouldAutoSync({ isOffline: true, pending: 1, isSyncing: false }),
		).toBe(false)
		expect(
			shouldAutoSync({ isOffline: false, pending: 0, isSyncing: false }),
		).toBe(false)
		expect(
			shouldAutoSync({ isOffline: false, pending: 3, isSyncing: true }),
		).toBe(false)
	})
	it("uses the 30 s interval from the spec", () => {
		expect(AUTO_SYNC_INTERVAL_MS).toBe(30000)
	})
})
