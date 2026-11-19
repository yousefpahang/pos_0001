import { describe, expect, it } from "vitest"
import { SHORTCUTS, resolveShortcut } from "./shortcuts"
import { createScannerCapture, isEditableTarget } from "./scannerCapture"

describe("shortcut map", () => {
	it("lists every SPEC section 6 shortcut once", () => {
		const keys = SHORTCUTS.map((s) => s.keys.join("+"))
		for (const k of [
			"F2",
			"F3",
			"F4",
			"F6",
			"F8",
			"F9",
			"Ctrl+S",
			"Esc",
			"Del",
			"+",
			"-",
			"?",
		]) {
			expect(keys).toContain(k)
		}
		expect(new Set(SHORTCUTS.map((s) => s.action)).size).toBe(SHORTCUTS.length)
	})

	it("maps function keys everywhere, also while typing", () => {
		expect(resolveShortcut({ key: "F2" })).toBe("search")
		expect(resolveShortcut({ key: "F4" }, { typing: true })).toBe("pay")
		expect(resolveShortcut({ key: "F8" })).toBe("hold")
		expect(resolveShortcut({ key: "F6" })).toBe("salesPerson")
		expect(resolveShortcut({ key: "F3" })).toBe("customer")
		expect(resolveShortcut({ key: "s", ctrlKey: true }, { typing: true })).toBe(
			"saveDraft",
		)
		expect(resolveShortcut({ key: "S", metaKey: true })).toBe("saveDraft")
	})

	it("leaves line keys and ? to text fields", () => {
		expect(resolveShortcut({ key: "Delete" })).toBe("removeLine")
		expect(resolveShortcut({ key: "Delete" }, { typing: true })).toBeNull()
		expect(resolveShortcut({ key: "+" })).toBe("qtyUp")
		expect(resolveShortcut({ key: "-" }, { typing: true })).toBeNull()
		expect(resolveShortcut({ key: "?" })).toBe("help")
		expect(resolveShortcut({ key: "?" }, { typing: true })).toBeNull()
	})

	it("does nothing while a dialog is open, for F9 / Esc (handled elsewhere) or other keys", () => {
		expect(resolveShortcut({ key: "F4" }, { dialogOpen: true })).toBeNull()
		expect(
			resolveShortcut({ key: "s", ctrlKey: true }, { dialogOpen: true }),
		).toBeNull()
		expect(resolveShortcut({ key: "F9" })).toBeNull()
		expect(resolveShortcut({ key: "Escape" })).toBeNull()
		expect(resolveShortcut({ key: "a" })).toBeNull()
		expect(resolveShortcut({ key: "c", ctrlKey: true })).toBeNull()
		expect(resolveShortcut({ key: "F2", altKey: true })).toBeNull()
	})

	it("repeats only quantity keys", () => {
		expect(resolveShortcut({ key: "+", repeat: true })).toBe("qtyUp")
		expect(resolveShortcut({ key: "F8", repeat: true })).toBeNull()
	})
})

describe("scanner capture", () => {
	const feedAll = (cap, code, gap, start = 1000) => {
		let t = start
		let result
		for (const key of code) {
			result = cap.feed({ key, time: t })
			t += gap
		}
		return { result, t }
	}

	it("recognises fast keys ending with Enter as a scan", () => {
		const cap = createScannerCapture()
		const { t } = feedAll(cap, "6290000000016", 8)
		expect(cap.feed({ key: "Enter", time: t })).toEqual({
			type: "scan",
			code: "6290000000016",
		})
		expect(cap.buffer).toBe("")
	})

	it("ignores a person typing (keys more than 30 ms apart)", () => {
		const cap = createScannerCapture()
		const { t } = feedAll(cap, "12345", 120)
		expect(cap.feed({ key: "Enter", time: t })).toEqual({ type: "none" })
	})

	it("starts over after a pause, so a slow first key does not end up in the code", () => {
		const cap = createScannerCapture()
		cap.feed({ key: "x", time: 0 })
		const { t } = feedAll(cap, "629000", 10, 500)
		expect(cap.feed({ key: "Enter", time: t - 5 })).toEqual({
			type: "scan",
			code: "629000",
		})
	})

	it("needs a minimum length, a fast Enter, and no modifiers", () => {
		const cap = createScannerCapture()
		feedAll(cap, "12", 5)
		expect(cap.feed({ key: "Enter", time: 1010 })).toEqual({ type: "none" })
		const { t } = feedAll(cap, "123456", 5, 2000)
		expect(cap.feed({ key: "Enter", time: t + 200 })).toEqual({ type: "none" })
		feedAll(cap, "1234", 5, 3000)
		expect(cap.feed({ key: "s", time: 3021, ctrl: true })).toEqual({
			type: "none",
		})
		expect(cap.buffer).toBe("")
	})

	it("keeps Shift between scanner keys (upper-case codes) and honours a custom gap", () => {
		const cap = createScannerCapture({ maxGapMs: 50, minLength: 3 })
		cap.feed({ key: "A", time: 0 })
		cap.feed({ key: "Shift", time: 20 })
		cap.feed({ key: "B", time: 40 })
		cap.feed({ key: "1", time: 85 })
		expect(cap.feed({ key: "Tab", time: 100 })).toEqual({
			type: "scan",
			code: "AB1",
		})
	})

	it("knows which elements take typing", () => {
		expect(isEditableTarget({ tagName: "INPUT", type: "text" })).toBe(true)
		expect(isEditableTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false)
		expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true)
		expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(
			true,
		)
		expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false)
		expect(isEditableTarget(null)).toBe(false)
	})
})
