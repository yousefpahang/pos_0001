import { describe, expect, it } from "vitest"
import {
	addSalesPerson,
	allocationTotal,
	defaultSelection,
	findByBarcode,
	matchesSalesPerson,
	normalizeAllocation,
	removeSalesPerson,
	resolveMode,
	setShare,
	splitEvenly,
	toSalesTeam,
	validateSelection,
} from "./salesPerson"

const A = { name: "Ahmed Ali", sales_person_name: "Ahmed Ali", commission_rate: 1, barcode: "SP0001" }
const B = { name: "Fatima Hassan", sales_person_name: "Fatima Hassan", commission_rate: 1.5, barcode: "SP0002" }
const C = { name: "Omar Khalid", sales_person_name: "Omar Khalid", commission_rate: 2, barcode: null }
const sum = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100

describe("resolveMode", () => {
	it.each([
		[["Optional", "Disabled"], "Optional", false],
		[["Optional", "Multiple"], "Optional", true],
		[["Mandatory", "Single"], "Mandatory", false],
		[["Mandatory", undefined], "Mandatory", false],
		[["Off", "Disabled"], "Off", false],
		[["Off", "Single"], "Mandatory", false],
		[["Off", "Multiple"], "Mandatory", true],
		[[null, null], "Off", false],
	])("%j -> %s", (args, mode, multiple) => {
		const r = resolveMode(...args)
		expect(r.mode).toBe(mode)
		expect(r.multiple).toBe(multiple)
		expect(r.enabled).toBe(mode !== "Off")
		expect(r.required).toBe(mode === "Mandatory")
	})
})

describe("allocation", () => {
	it("splits evenly to exactly 100", () => {
		expect(splitEvenly(3)).toEqual([33.34, 33.33, 33.33])
		expect(splitEvenly(0)).toEqual([])
		for (let n = 1; n <= 12; n++) expect(sum(splitEvenly(n))).toBe(100)
	})

	it("fixes drift but not real mistakes (same as the Python mirror)", () => {
		expect(normalizeAllocation([33.333, 33.333, 33.333])).toEqual([33.33, 33.33, 33.34])
		expect(sum(normalizeAllocation([100 / 3, 100 / 3, 100 / 3]))).toBe(100)
		expect(sum(normalizeAllocation([50, 30]))).toBe(80)
		expect(normalizeAllocation([])).toEqual([])
	})

	it("adds, removes and re-splits in multiple mode", () => {
		let sel = addSalesPerson([], A, true)
		expect(sel).toEqual([
			{ sales_person: A.name, sales_person_name: A.name, allocated_percentage: 100, commission_rate: 1 },
		])
		sel = addSalesPerson(sel, B, true)
		sel = addSalesPerson(sel, C, true)
		expect(sel.map((m) => m.allocated_percentage)).toEqual([33.34, 33.33, 33.33])
		expect(addSalesPerson(sel, A, true)).toBe(sel) // no duplicate
		sel = removeSalesPerson(sel, B.name)
		expect(sel.map((m) => [m.sales_person, m.allocated_percentage])).toEqual([
			[A.name, 50],
			[C.name, 50],
		])
	})

	it("single mode replaces the selection", () => {
		const sel = addSalesPerson(addSalesPerson([], A, false), B, false)
		expect(sel.map((m) => [m.sales_person, m.allocated_percentage])).toEqual([[B.name, 100]])
	})

	it("setShare gives the rest to the other person when there are two", () => {
		const sel = setShare(addSalesPerson(addSalesPerson([], A, true), B, true), A.name, 70)
		expect(sel.map((m) => m.allocated_percentage)).toEqual([70, 30])
		expect(setShare(sel, A.name, 150)[0].allocated_percentage).toBe(100)
		const three = setShare(addSalesPerson(sel, C, true), A.name, 50)
		// Three people: only the edited share changes; the cashier sees the total is off.
		expect(allocationTotal(three)).toBe(116.66)
	})

	it("toSalesTeam always totals 100 for an even split", () => {
		const team = toSalesTeam([
			{ sales_person: A.name, allocated_percentage: 100 / 3 },
			{ sales_person: B.name, allocated_percentage: 100 / 3 },
			{ sales_person: C.name, allocated_percentage: 100 / 3 },
			{ sales_person: "", allocated_percentage: 0 },
		])
		expect(team).toHaveLength(3)
		expect(sum(team.map((m) => m.allocated_percentage))).toBe(100)
	})
})

describe("search and barcode", () => {
	it("matches names partly and barcodes exactly", () => {
		expect(matchesSalesPerson(A, "ahm")).toBe(true)
		expect(matchesSalesPerson(A, "sp0001")).toBe(true)
		expect(matchesSalesPerson(A, "SP000")).toBe(false)
		expect(matchesSalesPerson(A, "")).toBe(true)
	})

	it("finds a badge barcode", () => {
		expect(findByBarcode([A, B, C], " SP0002 ")).toBe(B)
		expect(findByBarcode([A, B, C], "SP9999")).toBeNull()
		expect(findByBarcode([A, C], "")).toBeNull()
	})
})

describe("defaultSelection", () => {
	it("pre-selects the cashier's default when it is in the list", () => {
		expect(defaultSelection({ default_sales_person: B.name, sales_persons: [A, B] })).toEqual([
			{ sales_person: B.name, sales_person_name: B.name, allocated_percentage: 100, commission_rate: 1.5 },
		])
		expect(defaultSelection({ default_sales_person: "Gone", sales_persons: [A] })).toEqual([])
		expect(defaultSelection({ sales_persons: [A] })).toEqual([])
		expect(defaultSelection(null)).toEqual([])
	})
})

describe("validateSelection", () => {
	const mandatory = resolveMode("Mandatory", "Multiple")
	const optional = resolveMode("Optional", "Multiple")
	const off = resolveMode("Off", "Disabled")
	const one = [{ sales_person: A.name, allocated_percentage: 100 }]

	it("Mandatory needs someone", () => {
		expect(validateSelection({ mode: mandatory, selection: [], available: 3 })).toEqual({
			valid: false,
			reason: "required",
		})
		expect(validateSelection({ mode: mandatory, selection: one, available: 3 }).valid).toBe(true)
	})

	it("Mandatory with nobody to pick does not block the till", () => {
		expect(validateSelection({ mode: mandatory, selection: [], available: 0 }).valid).toBe(true)
	})

	it("Optional and Off allow no one", () => {
		expect(validateSelection({ mode: optional, selection: [], available: 3 }).valid).toBe(true)
		expect(validateSelection({ mode: off, selection: [], available: 3 }).valid).toBe(true)
	})

	it("a split must total 100", () => {
		const bad = [
			{ sales_person: A.name, allocated_percentage: 50 },
			{ sales_person: B.name, allocated_percentage: 30 },
		]
		expect(validateSelection({ mode: optional, selection: bad, available: 3 })).toEqual({
			valid: false,
			reason: "total",
		})
		const drift = [
			{ sales_person: A.name, allocated_percentage: 33.33 },
			{ sales_person: B.name, allocated_percentage: 33.33 },
			{ sales_person: C.name, allocated_percentage: 33.33 },
		]
		expect(validateSelection({ mode: optional, selection: drift, available: 3 }).valid).toBe(true)
	})
})
