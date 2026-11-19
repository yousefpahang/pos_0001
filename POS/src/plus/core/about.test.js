import { describe, expect, it } from "vitest"
import { DEFAULT_ABOUT, parseAbout } from "./about.js"

describe("parseAbout", () => {
	it("returns defaults with nothing cached", () => {
		expect(parseAbout(null)).toEqual({ ...DEFAULT_ABOUT })
		expect(parseAbout("not json")).toEqual({ ...DEFAULT_ABOUT })
	})

	it("keeps a cached answer", () => {
		const raw = JSON.stringify({
			version: "1.0.1",
			license: "AGPL-3.0",
			source_url: "https://example.com/src",
		})
		expect(parseAbout(raw)).toEqual({
			version: "1.0.1",
			license: "AGPL-3.0",
			source_url: "https://example.com/src",
		})
	})

	it("never offers a non-http link", () => {
		const raw = JSON.stringify({ source_url: "javascript:alert(1)" })
		expect(parseAbout(raw).source_url).toBe(DEFAULT_ABOUT.source_url)
		expect(parseAbout(JSON.stringify({ source_url: "" })).source_url).toBe(
			DEFAULT_ABOUT.source_url,
		)
	})
})
