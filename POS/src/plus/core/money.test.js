import { describe, expect, it } from "vitest"
import {
	AED_ARABIC,
	amount2,
	baseLang,
	currencySymbol,
	formatMoney,
} from "./money.js"

describe("AED formatting (SPEC section 7)", () => {
	it("uses AED in English and د.إ in Arabic by default", () => {
		expect(currencySymbol("AED", { lang: "en" })).toBe("AED")
		expect(currencySymbol("AED", { lang: "ar" })).toBe(AED_ARABIC)
		expect(currencySymbol("aed", { lang: "ar-AE" })).toBe(AED_ARABIC)
		expect(currencySymbol("AED", {})).toBe("AED")
		expect(currencySymbol("AED", { lang: "ar", mode: "By language" })).toBe(
			AED_ARABIC,
		)
	})

	it("a fixed setting wins over the language", () => {
		expect(currencySymbol("AED", { lang: "ar", mode: "AED" })).toBe("AED")
		expect(currencySymbol("AED", { lang: "en", mode: AED_ARABIC })).toBe(
			AED_ARABIC,
		)
	})

	it("other currencies keep their code", () => {
		expect(currencySymbol("usd", { lang: "ar" })).toBe("USD")
		expect(currencySymbol("", { lang: "ar" })).toBe("")
	})

	it("always prints 2 decimals with Western digits", () => {
		expect(amount2(12.5)).toBe("12.50")
		expect(amount2("9.999")).toBe("10.00")
		expect(amount2(1.005)).toBe("1.01")
		expect(amount2(-2.345)).toBe("-2.35")
		expect(amount2(-0.001)).toBe("0.00")
		expect(amount2("x")).toBe("0.00")
		expect(formatMoney(12.5, "AED", { lang: "en" })).toBe("AED 12.50")
		expect(formatMoney(12.5, "AED", { lang: "ar" })).toBe(`12.50 ${AED_ARABIC}`)
		expect(formatMoney(3, "", {})).toBe("3.00")
	})

	it("reads the language part of a locale", () => {
		expect(baseLang("ar-AE")).toBe("ar")
		expect(baseLang("EN_us")).toBe("en")
		expect(baseLang(null)).toBe("en")
	})
})
