import { describe, expect, it } from "vitest"
import { itemDisplayName } from "./itemName.js"

describe("item display name", () => {
	const item = { item_code: "ITM-1", item_name: "Rice", item_name_ar: " أرز " }

	it("Arabic name on an Arabic till, item name otherwise", () => {
		expect(itemDisplayName(item, "ar")).toBe("أرز")
		expect(itemDisplayName(item, "ar-AE")).toBe("أرز")
		expect(itemDisplayName(item, "en")).toBe("Rice")
		expect(itemDisplayName(item, null)).toBe("Rice")
	})

	it("falls back when there is no Arabic name", () => {
		expect(itemDisplayName({ item_name: "Milk" }, "ar")).toBe("Milk")
		expect(itemDisplayName({ item_code: "X-1" }, "ar")).toBe("X-1")
		expect(itemDisplayName(null, "ar")).toBe("")
	})
})
