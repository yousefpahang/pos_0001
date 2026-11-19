import { describe, expect, it } from "vitest"
import {
	buildScaleItem,
	generateScaleBarcode,
	normalizeRule,
	parseScaleBarcode,
	pluCandidates,
	priceLine,
	roundTo,
	ruleErrors,
} from "./scaleBarcode.js"
import { RULE_A, RULE_B } from "./scaleRules.fixture.js"

const RULES = [RULE_A, RULE_B]

const ITEM = {
	item_code: "PLU-12345",
	item_name: "Tomato (per kg) 12345",
	stock_uom: "Kg",
	uom: "Kg",
	rate: 12,
	price_list_rate: 12,
	uom_prices: { Kg: 12 },
	item_uoms: [],
}

describe("SPEC F5 test vectors", () => {
	it("2012345012509 -> rule A, qty 1.250 kg", () => {
		const p = parseScaleBarcode("2012345012509", RULES)
		expect(p.ok).toBe(true)
		expect(p.rule.name).toBe("Rule A")
		expect(p.plu).toBe("12345")
		expect(p.value).toBe(1.25)
		const { item } = buildScaleItem(ITEM, p)
		expect(item.resolved_qty).toBe(1.25)
		expect(item.uom).toBe("Kg")
	})

	it("2012345007505 -> rule A, qty 0.750 kg", () => {
		const p = parseScaleBarcode("2012345007505", RULES)
		expect(p.rule.name).toBe("Rule A")
		expect(buildScaleItem(ITEM, p).item.resolved_qty).toBe(0.75)
	})

	it("2212345025008 -> rule B, amount AED 25.00", () => {
		const p = parseScaleBarcode("2212345025008", RULES)
		expect(p.rule.name).toBe("Rule B")
		expect(p.value).toBe(25)
		const { item } = buildScaleItem(ITEM, p)
		expect(roundTo(item.resolved_qty * item.rate, 2)).toBe(25)
		expect(item.resolved_qty).toBe(2.083)
	})

	it("2212345009992 -> rule B, amount AED 9.99", () => {
		const p = parseScaleBarcode("2212345009992", RULES)
		expect(p.value).toBe(9.99)
		const { item } = buildScaleItem(ITEM, p)
		expect(roundTo(item.resolved_qty * item.rate, 2)).toBe(9.99)
		expect(item.resolved_qty).toBe(0.833)
	})

	it("2012345012508 -> wrong check digit error when Validate", () => {
		const p = parseScaleBarcode("2012345012508", RULES)
		expect(p.ok).toBe(false)
		expect(p.error).toBe("check_digit")
	})

	it("2012345012508 parses when the rule ignores check digits", () => {
		const p = parseScaleBarcode("2012345012508", [{ ...RULE_A, check_digit_mode: "Ignore" }])
		expect(p.ok).toBe(true)
		expect(p.value).toBe(1.25)
	})
})

describe("rule matching", () => {
	it("returns null when no prefix or length matches", () => {
		expect(parseScaleBarcode("6290000000017", RULES)).toBeNull()
		expect(parseScaleBarcode("201234501250", RULES)).toBeNull()
		expect(parseScaleBarcode("abc", RULES)).toBeNull()
		expect(parseScaleBarcode("", RULES)).toBeNull()
	})

	it("tries lower priority first", () => {
		const a = { ...RULE_A, name: "late", priority: 20 }
		const b = { ...RULE_A, name: "early", priority: 5, value_type: "Price", decimals: 2 }
		expect(parseScaleBarcode("2012345012509", [a, b]).rule.name).toBe("early")
	})

	it("accepts UPC-A length rules", () => {
		const rule = { ...RULE_A, prefix: "2", total_length: 12, item_code_start: 2, value_start: 7 }
		const code = generateScaleBarcode(rule, "12345", 1.25)
		expect(code).toHaveLength(12)
		expect(parseScaleBarcode(code, [rule]).value).toBe(1.25)
	})

	it("skips invalid rules", () => {
		expect(normalizeRule({ ...RULE_A, prefix: "2a" })).toBeNull()
		expect(normalizeRule({ ...RULE_A, value_start: 10 })).toBeNull() // runs into check digit
		expect(normalizeRule({ ...RULE_A, item_code_start: 2 })).toBeNull() // overlaps prefix
		expect(ruleErrors(normalizeRule(RULE_A) || RULE_A)).toEqual([])
		expect(normalizeRule({ ...RULE_A, total_length: "13", decimals: "3" }).total_length).toBe(13)
	})

	it("PLU candidates drop leading zeros", () => {
		expect(pluCandidates("00123")).toEqual(["00123", "123"])
		expect(pluCandidates("12345")).toEqual(["12345"])
		expect(pluCandidates("00000")).toEqual(["00000", "0"])
	})
})

describe("priceLine", () => {
	it("keeps the printed amount exact", () => {
		const bad = []
		for (const price of [0.5, 1, 9.99, 25, 33.33, 99.99, 123.45, 999.99]) {
			for (const rate of [0.99, 3.5, 7.25, 12, 18.75, 39.99, 120]) {
				const line = priceLine(price, rate)
				const ok =
					line.exact &&
					roundTo(line.qty * line.rate, 2) === price &&
					line.amount === price &&
					Math.abs(line.qty - price / rate) / (price / rate) < 0.01 + 0.002 / (price / rate)
				if (!ok) bad.push({ price, rate, ...line })
			}
		}
		expect(bad).toEqual([])
	})

	it("returns null without a positive rate", () => {
		expect(priceLine(10, 0)).toBeNull()
		expect(priceLine(0, 10)).toBeNull()
	})
})

describe("generateScaleBarcode", () => {
	it("round-trips the F5 vectors", () => {
		expect(generateScaleBarcode(RULE_A, "12345", 1.25)).toBe("2012345012509")
		expect(generateScaleBarcode(RULE_A, "12345", 0.75)).toBe("2012345007505")
		expect(generateScaleBarcode(RULE_B, "12345", 25)).toBe("2212345025008")
		expect(generateScaleBarcode(RULE_B, "12345", 9.99)).toBe("2212345009992")
	})

	it("pads short PLUs and rejects values that do not fit", () => {
		expect(generateScaleBarcode(RULE_A, "123", 0.5)).toBe(
			generateScaleBarcode(RULE_A, "00123", 0.5),
		)
		expect(() => generateScaleBarcode(RULE_A, "123456", 1)).toThrow()
		expect(() => generateScaleBarcode(RULE_A, "12345", 100)).toThrow()
	})
})

describe("buildScaleItem", () => {
	it("errors when the item is not sold in the rule UOM", () => {
		const nos = { ...ITEM, stock_uom: "Nos", uom: "Nos", uom_prices: { Nos: 5 } }
		const out = buildScaleItem(nos, parseScaleBarcode("2012345012509", RULES))
		expect(out.error).toEqual({
			code: "uom",
			item_code: "PLU-12345",
			item_name: "Tomato (per kg) 12345",
			uom: "Kg",
		})
	})

	it("uses a Kg conversion when the stock UOM is grams", () => {
		const gram = {
			...ITEM,
			stock_uom: "Gram",
			uom: "Gram",
			rate: 0.012,
			price_list_rate: 0.012,
			uom_prices: {},
			item_uoms: [{ uom: "Kg", conversion_factor: 1000 }],
		}
		const { item } = buildScaleItem(gram, parseScaleBarcode("2012345012509", RULES))
		expect(item.uom).toBe("Kg")
		expect(item.conversion_factor).toBe(1000)
		expect(item.rate).toBe(12)
		expect(item.resolved_qty).toBe(1.25)
	})

	it("errors on a price label for an item with no price", () => {
		const free = { ...ITEM, rate: 0, price_list_rate: 0, uom_prices: {} }
		const out = buildScaleItem(free, parseScaleBarcode("2212345009992", RULES))
		expect(out.error.code).toBe("no_price")
	})

	it("marks the line so it is never merged and is re-validated", () => {
		const p = parseScaleBarcode("2012345012509", RULES)
		const one = buildScaleItem(ITEM, p, { lineId: "a" }).item
		const two = buildScaleItem(ITEM, p, { lineId: "b" }).item
		expect(one.pos0001_scale_barcode).toBe("2012345012509")
		expect(one.resolved_barcode_type).toBe("Weighted")
		expect(one.pos0001_line_id).not.toBe(two.pos0001_line_id)
	})
})
