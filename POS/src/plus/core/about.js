// Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
// About / Source code entry (SPEC section 2): defaults and parsing of the cached answer.

/**
 * @typedef {Object} AboutInfo
 * @property {string} version         pos_0001 release
 * @property {string} license         license name
 * @property {string} source_url      where users get the source of this version
 */

/** @type {AboutInfo} */
export const DEFAULT_ABOUT = Object.freeze({
	version: "1.0.0",
	license: "AGPL-3.0",
	source_url: "https://github.com/yousefpahang/pos_0001",
})

/**
 * Parse the cached About answer. Anything missing or not an http(s) link falls back to the defaults,
 * so the menu always offers a working source link.
 * @param {string|null|undefined} raw JSON from localStorage
 * @returns {AboutInfo}
 */
export function parseAbout(raw) {
	let data = {}
	try {
		data = raw ? JSON.parse(raw) || {} : {}
	} catch {
		data = {}
	}
	const url =
		typeof data.source_url === "string" &&
		/^https?:\/\//i.test(data.source_url.trim())
			? data.source_url.trim()
			: DEFAULT_ABOUT.source_url
	return {
		version:
			typeof data.version === "string" && data.version
				? data.version
				: DEFAULT_ABOUT.version,
		license:
			typeof data.license === "string" && data.license
				? data.license
				: DEFAULT_ABOUT.license,
		source_url: url,
	}
}
