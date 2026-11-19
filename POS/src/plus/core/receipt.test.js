import { describe, expect, it } from "vitest"
import { toHex } from "./escpos.js"
import {
	buildReceiptModel,
	chooseBarcode,
	layoutReceipt,
	money,
	planPrint,
	quantity,
	receiptTextLines,
	shouldKickDrawer,
	textReceipt,
} from "./receipt.js"

const SERVER_DOC = {
	name: "ACC-SINV-2026-00012",
	company: "Demo Trading LLC",
	posting_date: "2026-11-19",
	posting_time: "14:05:33.123",
	pos_profile: "Main Till",
	customer: "CUST-1",
	customer_name: "Walk-in Customer",
	currency: "AED",
	items: [
		{ item_code: "ITM-00001", item_name: "Milk 1L", item_name_ar: "حليب", qty: 2, uom: "Nos", rate: 5.5, amount: 11 },
		{ item_code: "PLU-12345", item_name: "Tomatoes", qty: 1.25, uom: "Kg", rate: 8, amount: 10 },
	],
	net_total: 21,
	taxes: [{ description: "VAT 5%", tax_amount: 1.05 }],
	total_taxes_and_charges: 1.05,
	grand_total: 22.05,
	rounding_adjustment: -0.05,
	rounded_total: 22,
	payments: [
		{ mode_of_payment: "Cash", amount: 30, type: "Cash" },
		{ mode_of_payment: "Card", amount: 0, type: "Bank" },
	],
	paid_amount: 30,
	change_amount: 8,
	outstanding_amount: 0,
	sales_team: [{ sales_person: "Ahmed Ali", allocated_percentage: 100 }],
}

const CTX = {
	company: { name: "Demo Trading LLC", address: "Dubai, UAE", tax_id: "100000000000003" },
	cashModes: ["Cash"],
	footer: "Thank you for shopping",
	cashier: "Cashier One",
}

const OFFLINE_DOC = {
	name: "pos_offline_3f2b8c1e-9a4d-4c7e-b2a1-5d6e7f8091a2",
	is_offline: true,
	pos_profile: "Main Till",
	posting_date: "2026-11-19",
	items: [{ item_code: "ITM-00001", item_name: "Milk 1L", quantity: 1, rate: 5.5 }],
	grand_total: 5.78,
	total_taxes_and_charges: 0.28,
	payments: [{ mode_of_payment: "Card", amount: 5.78 }],
	change_amount: 0,
}

const PRINTER = {
	name: "Till 1 Receipt",
	print_mode: "raster",
	connection: "QZ Local Printer",
	paper_width_mm: 80,
	auto_cut: 1,
	copies: 1,
	drawer_kick: 1,
	receipt_barcode: "Code128",
}

describe("receipt model", () => {
	it("normalises a server invoice", () => {
		const m = buildReceiptModel(SERVER_DOC, CTX)
		expect(m.title).toBe("Tax Invoice")
		expect(m.taxId).toBe("100000000000003")
		expect(m.time).toBe("14:05")
		expect(m.lines).toHaveLength(2)
		expect(m.lines[0]).toMatchObject({ name: "Milk 1L", nameAr: "حليب", qty: 2, amount: 11 })
		expect(m.total).toBe(22)
		expect(m.roundingAdjustment).toBe(-0.05)
		expect(m.payments).toEqual([{ mode: "Cash", amount: 30, isCash: true }])
		expect(m.change).toBe(8)
		expect(m.salesPersons).toEqual(["Ahmed Ali"])
		expect(m.barcodeValue).toBe("ACC-SINV-2026-00012")
		expect(m.offline).toBe(false)
	})

	it("normalises an offline queue invoice", () => {
		const m = buildReceiptModel(OFFLINE_DOC, { cashModes: ["Cash"] })
		expect(m.offline).toBe(true)
		expect(m.lines[0]).toMatchObject({ qty: 1, amount: 5.5 })
		expect(m.net).toBe(5.5)
		expect(m.total).toBe(5.78)
		expect(m.payments[0].isCash).toBe(false)
		expect(m.paid).toBe(5.78)
		expect(m.outstanding).toBe(0)
	})

	it("returns are credit notes that reference the original", () => {
		const m = buildReceiptModel(
			{ ...SERVER_DOC, is_return: 1, return_against: "ACC-SINV-2026-00001", grand_total: -22.05, rounded_total: -22 },
			CTX,
		)
		expect(m.title).toBe("Credit Note")
		expect(m.total).toBe(-22)
		expect(receiptTextLines(m, 48).body.join("\n")).toContain("ACC-SINV-2026-00001")
	})

	it("uses the translator", () => {
		const m = buildReceiptModel(SERVER_DOC, { ...CTX, t: (s) => `<${s}>` })
		expect(m.title).toBe("<Tax Invoice>")
	})

	it("formats money and quantities", () => {
		expect(money(1.005 + 0)).toBe("1.00")
		expect(money(-0.001)).toBe("0.00")
		expect(money("9.9")).toBe("9.90")
		expect(quantity(1.25)).toBe("1.25")
		expect(quantity(0.2614)).toBe("0.261")
		expect(quantity(2)).toBe("2")
	})
})

describe("receipt barcode", () => {
	it("Code128 for server names, QR when too wide or asked for", () => {
		expect(chooseBarcode("ACC-SINV-2026-00012", "Code128", 576)).toBe("code128")
		expect(chooseBarcode(OFFLINE_DOC.name, "Code128", 576)).toBe("qr")
		expect(chooseBarcode("ACC-SINV-2026-00012", "QR", 576)).toBe("qr")
		expect(chooseBarcode("ACC-SINV-2026-00012", "None", 576)).toBe(null)
		expect(chooseBarcode("", "Code128", 576)).toBe(null)
	})
})

describe("escpos_text receipt", () => {
	it("byte snapshot of a fixed receipt (80 mm, cash, cut, drawer)", () => {
		const m = buildReceiptModel(SERVER_DOC, CTX)
		const bytes = textReceipt(m, { paperWidthMm: 80, drawer: true, cut: true, copies: 1, barcode: "Code128" })
		expect(toHex(bytes)).toMatchSnapshot()
		const hex = toHex(bytes)
		expect(hex.startsWith("1b 40 1b 70 00 19 fa")).toBe(true)
		expect(hex.endsWith("1b 64 04 1d 56 00")).toBe(true)
		expect(hex).toContain("1d 6b 49") // Code128
	})

	it("byte snapshot of a 58 mm offline receipt with QR and no cut", () => {
		const m = buildReceiptModel(OFFLINE_DOC, { cashModes: ["Cash"] })
		const bytes = textReceipt(m, { paperWidthMm: 58, cut: false, barcode: "Code128" })
		expect(toHex(bytes)).toMatchSnapshot()
		const hex = toHex(bytes)
		expect(hex).toContain("1d 28 6b") // QR
		expect(hex).not.toContain("1d 56")
		expect(hex).not.toContain("1b 70")
	})

	it("lines fit the paper and copies repeat the job", () => {
		const m = buildReceiptModel(SERVER_DOC, CTX)
		const { head, body } = receiptTextLines(m, 32)
		for (const row of [...head, ...body]) expect(row.length).toBeLessThanOrEqual(32)
		const one = textReceipt(m, { paperWidthMm: 58, drawer: true })
		const three = textReceipt(m, { paperWidthMm: 58, drawer: true, copies: 3 })
		expect(toHex(three).split("1b 70 00 19 fa").length - 1).toBe(1)
		expect(toHex(three).split("1d 56 00").length - 1).toBe(3)
		expect(three.length).toBeGreaterThan(one.length * 2)
	})
})

describe("raster layout", () => {
	it("keeps Arabic names as text for the canvas and adds the barcode", () => {
		const m = buildReceiptModel(SERVER_DOC, { ...CTX, logo: "data:image/png;base64,AA==" })
		const ops = layoutReceipt(m, { widthDots: 576, barcode: "Code128" })
		expect(ops[0]).toEqual({ type: "logo" })
		expect(ops).toContainEqual({ type: "text", text: "حليب", align: "right", size: "md" })
		const code = ops.find((o) => o.type === "code128")
		expect(code.label).toBe("ACC-SINV-2026-00012")
		expect(code.widths.reduce((a, b) => a + b, 0) * code.moduleWidth).toBeLessThanOrEqual(576)
		const total = ops.find((o) => o.type === "pair" && o.left === "TOTAL")
		expect(total.right).toBe("AED 22.00")
	})

	it("offline receipt gets a QR code that fits 58 mm", () => {
		const m = buildReceiptModel(OFFLINE_DOC, {})
		const qr = layoutReceipt(m, { widthDots: 384 }).find((o) => o.type === "qr")
		expect(qr.modules.length * qr.moduleSize).toBeLessThanOrEqual(384)
		expect(layoutReceipt(m, { widthDots: 384, barcode: "None" }).some((o) => o.type === "qr")).toBe(false)
	})
})

describe("print plan and drawer", () => {
	it("keeps POS Next printing when the till has no printer profile", () => {
		expect(planPrint(null, { qzConnected: true }).mode).toBe("pos_next")
	})

	it("runs the profile's mode when QZ is connected", () => {
		for (const mode of ["raster", "escpos_text", "qz_html", "browser"]) {
			expect(planPrint({ ...PRINTER, print_mode: mode }, { qzConnected: true })).toEqual({
				mode,
				fallback: false,
				reason: null,
			})
		}
	})

	it("falls back to the browser when QZ is down or the network printer has no address", () => {
		expect(planPrint(PRINTER, { qzConnected: false })).toEqual({
			mode: "browser",
			fallback: true,
			reason: "qz_not_connected",
		})
		expect(planPrint({ ...PRINTER, print_mode: "browser" }, { qzConnected: false }).fallback).toBe(false)
		expect(
			planPrint({ ...PRINTER, connection: "Network", network_host: "" }, { qzConnected: true }).reason,
		).toBe("no_network_host")
	})

	it("opens the drawer for cash sales only, never on reprints", () => {
		const cash = buildReceiptModel(SERVER_DOC, CTX)
		const card = buildReceiptModel(OFFLINE_DOC, CTX)
		expect(shouldKickDrawer(PRINTER, cash, { reason: "sale" })).toBe(true)
		expect(shouldKickDrawer(PRINTER, card, { reason: "sale" })).toBe(false)
		expect(shouldKickDrawer(PRINTER, cash, { reason: "reprint" })).toBe(false)
		expect(shouldKickDrawer({ ...PRINTER, drawer_kick: 0 }, cash, { reason: "sale" })).toBe(false)
		expect(shouldKickDrawer(null, cash, { reason: "sale" })).toBe(false)
	})
})
