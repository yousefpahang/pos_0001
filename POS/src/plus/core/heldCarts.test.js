import { describe, expect, it } from "vitest"
import {
	asLegacyDraft,
	buildDraftInvoice,
	buildLocalRecord,
	cartTotal,
	cleanNote,
	isExpired,
	makeHoldId,
	mergeHeldLists,
	pendingUploads,
	restoreCart,
	snapshotCart,
	uploadOutcome,
} from "./heldCarts"

const NOW = new Date("2026-11-19T10:00:00Z")

function record(overrides = {}) {
	return buildLocalRecord({
		holdId: "HOLD-aaaaaaaa-1",
		posProfile: "Main Till",
		cart: snapshotCart({
			items: [{ item_code: "A", item_name: "A", quantity: 2, rate: 10.5 }],
			customer: { name: "CUST-1", customer_name: "Ali" },
			salesTeam: [
				{
					sales_person: "Ahmed Ali",
					allocated_percentage: 100,
					commission_rate: 2,
				},
			],
		}),
		invoice: buildDraftInvoice({
			posProfile: "Main Till",
			customer: "CUST-1",
			items: [],
		}),
		note: "  back in 5 min  ",
		user: "cashier@pos.test",
		deviceId: "dev-12345678",
		now: NOW,
		...overrides,
	})
}

describe("held carts", () => {
	it("makes hold ids the server accepts", () => {
		expect(makeHoldId(() => "123e4567-e89b-12d3-a456-426614174000")).toBe(
			"HOLD-123e4567-e89b-12d3-a456-426614174000",
		)
		expect(makeHoldId()).toMatch(/^HOLD-[A-Za-z0-9-]{8,59}$/)
		expect(makeHoldId()).not.toBe(makeHoldId())
	})

	it("cleans notes", () => {
		expect(cleanNote("  hi ")).toBe("hi")
		expect(cleanNote("   ")).toBeNull()
		expect(cleanNote(null)).toBeNull()
		expect(cleanNote("x".repeat(600))).toHaveLength(500)
	})

	it("snapshots a cart without Vue proxies and keeps only team fields it needs", () => {
		const snap = snapshotCart({
			items: [{ item_code: "A", quantity: 1 }],
			customer: "CUST-1",
			appliedOffers: [{ name: "OFF" }],
			salesTeam: [
				{ sales_person: "X", allocated_percentage: "60", commission_rate: 5 },
			],
		})
		expect(snap).toEqual({
			items: [{ item_code: "A", quantity: 1 }],
			customer: "CUST-1",
			applied_offers: [{ name: "OFF" }],
			sales_team: [
				{ sales_person: "X", sales_person_name: "X", allocated_percentage: 60 },
			],
		})
	})

	it("builds a local record that starts as local with time, note and cashier", () => {
		const r = record()
		expect(r.draft_id).toBe(r.hold_id)
		expect(r.server_state).toBe("local")
		expect(r.held_at).toBe(NOW.toISOString())
		expect(r.note).toBe("back in 5 min")
		expect(r.held_by).toBe("cashier@pos.test")
		expect(r.invoice).toMatchObject({
			doctype: "Sales Invoice",
			is_pos: 1,
			pos_profile: "Main Till",
		})
		expect(r.invoice.payments).toBeUndefined()
	})

	it("adds up cart totals from amounts or qty x rate", () => {
		expect(cartTotal([{ quantity: 3, rate: 1.1 }])).toBe(3.3)
		expect(
			cartTotal([
				{ amount: 9.99, quantity: 1, rate: 1 },
				{ qty: 2, rate: 0.5 },
			]),
		).toBe(10.99)
		expect(cartTotal([])).toBe(0)
	})

	it("merges local and server lists newest first, server wins for the same hold id", () => {
		const local = record({
			holdId: "HOLD-local-0001",
			now: new Date("2026-11-19T09:00:00Z"),
		})
		const dup = record({
			holdId: "HOLD-shared-001",
			now: new Date("2026-11-19T09:30:00Z"),
		})
		const server = [
			{
				name: "HOLD-shared-001",
				hold_id: "HOLD-shared-001",
				held_at: "2026-11-19 13:30:00",
				held_at_utc: "2026-11-19T09:30:00Z",
				grand_total: 22.05,
				customer_name: "Ali",
				held_by_name: "Cashier",
				device_name: "Till 2",
				items: [{ item_name: "A", qty: 2, rate: 10.5, amount: 21 }],
			},
			{
				name: "HOLD-server-002",
				hold_id: "HOLD-server-002",
				held_at_utc: "2026-11-19T09:45:00Z",
				grand_total: 5,
			},
		]
		const list = mergeHeldLists([local, dup], server)
		expect(list.map((e) => e.hold_id)).toEqual([
			"HOLD-server-002",
			"HOLD-shared-001",
			"HOLD-local-0001",
		])
		const shared = list[1]
		expect(shared.source).toBe("server")
		expect(shared.till).toBe("Till 2")
		expect(shared.held_by).toBe("Cashier")
		expect(shared.item_count).toBe(1)
		expect(shared.items[0].quantity).toBe(2)
		const mine = list[2]
		expect(mine.source).toBe("local")
		expect(mine.total).toBe(21)
		expect(mine.customer_name).toBe("Ali")
	})

	it("shows a refused cart as error with its reason", () => {
		const r = {
			...record(),
			server_state: "error",
			error: "Customer is disabled",
		}
		const [entry] = mergeHeldLists([r], [])
		expect(entry.source).toBe("error")
		expect(entry.error).toBe("Customer is disabled")
	})

	it("uploads local and refused carts of this profile only", () => {
		const a = record({ holdId: "HOLD-aaaaaaaa" })
		const b = { ...record({ holdId: "HOLD-bbbbbbbb" }), server_state: "error" }
		const c = record({ holdId: "HOLD-cccccccc", posProfile: "Express Till" })
		const d = { ...record({ holdId: "HOLD-dddddddd" }), hold_id: undefined }
		expect(
			pendingUploads([a, b, c, d], "Main Till").map((r) => r.hold_id),
		).toEqual(["HOLD-aaaaaaaa", "HOLD-bbbbbbbb"])
	})

	it("leaves the browser only when the server confirms", () => {
		expect(uploadOutcome({ status: "Held", held: {} })).toEqual({
			action: "remove",
		})
		expect(uploadOutcome({ status: "Resumed" })).toEqual({ action: "remove" })
		expect(uploadOutcome({ status: "Failed", error: "No price" })).toEqual({
			action: "keep",
			error: "No price",
		})
		expect(uploadOutcome(null)).toEqual({ action: "keep", error: null })
		expect(uploadOutcome({ status: "Weird" })).toEqual({
			action: "keep",
			error: null,
		})
	})

	it("expires local copies after the retention days, never when 0", () => {
		const r = record({ now: new Date("2026-11-15T09:00:00Z") })
		expect(isExpired(r, 3, NOW)).toBe(true)
		expect(isExpired(r, 5, NOW)).toBe(false)
		expect(isExpired(r, 0, NOW)).toBe(false)
		expect(isExpired({}, 3, NOW)).toBe(false)
	})

	it("restores a cart defensively and maps entries to POS Next's draft shape", () => {
		expect(restoreCart(null)).toEqual({
			items: [],
			customer: null,
			applied_offers: [],
			sales_team: [],
		})
		const r = record()
		expect(restoreCart(r).sales_team[0].sales_person).toBe("Ahmed Ali")
		const [entry] = mergeHeldLists([r], [])
		const legacy = asLegacyDraft(entry)
		expect(legacy.draft_id).toBe(r.hold_id)
		expect(legacy.created_at).toBe(r.held_at)
		expect(legacy.items).toHaveLength(1)
	})
})
