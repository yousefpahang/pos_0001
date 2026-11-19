// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// ESC/POS command builder (SPEC F9). Plain JavaScript, no Vue, no DOM: runs in the
// page, in a Web Worker and in Vitest. Produces bytes (Uint8Array) that are sent raw to
// the printer through QZ Tray.
//
// The text layout helpers (center, leftRight, wrap) are adapted from POS Awesome
// (frontend/src/posapp/services/rawDocumentPrint.ts, GPL-3.0, defendicon fork).

export const ESC = 0x1b
export const GS = 0x1d
export const LF = 0x0a

/** Paper width in mm to printable dots at 203 dpi (Epson / Xprinter defaults). */
export const PAPER_DOTS = Object.freeze({ 80: 576, 58: 384 })
/** Paper width in mm to characters per line in font A (12 x 24 dots). */
export const PAPER_COLUMNS = Object.freeze({ 80: 48, 58: 32 })

/**
 * @param {number|string} paperWidthMm
 * @returns {number}
 */
export function dotsForPaper(paperWidthMm) {
	return PAPER_DOTS[Number(paperWidthMm)] || PAPER_DOTS[80]
}

/**
 * @param {number|string} paperWidthMm
 * @param {number} [override] characters per line set on the printer profile (0 = auto)
 * @returns {number}
 */
export function columnsForPaper(paperWidthMm, override) {
	const n = Math.round(Number(override) || 0)
	if (n >= 24 && n <= 64) return n
	return PAPER_COLUMNS[Number(paperWidthMm)] || PAPER_COLUMNS[80]
}

/**
 * Text that a plain ESC/POS code page can print: ASCII only. Control characters become
 * spaces; anything outside ASCII becomes "?". Arabic needs raster mode.
 * @param {unknown} value
 * @returns {string}
 */
export function asciiText(value) {
	return Array.from(String(value ?? "").normalize("NFC"))
		.map((ch) => {
			const code = ch.codePointAt(0) || 0
			if (code < 32 || code === 127) return " "
			if (code > 126) return "?"
			return ch
		})
		.join("")
}

/** @param {unknown} value */
function clean(value) {
	return asciiText(value).replace(/\s+/g, " ").trim()
}

/**
 * @param {unknown} text
 * @param {number} width
 */
export function center(text, width) {
	const value = clean(text)
	if (!value) return ""
	if (value.length >= width) return value.slice(0, width)
	return " ".repeat(Math.floor((width - value.length) / 2)) + value
}

/**
 * Left text and right text on one line; the left side is cut to make room.
 * @param {unknown} left
 * @param {unknown} right
 * @param {number} width
 */
export function leftRight(left, right, width) {
	const l = clean(left)
	const r = clean(right)
	if (!r) return l.slice(0, width)
	const room = Math.max(0, width - r.length - 1)
	return `${l.slice(0, room).padEnd(room, " ")} ${r}`.slice(0, width)
}

/**
 * Word wrap; words longer than the line are split.
 * @param {unknown} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrap(text, width) {
	const value = clean(text)
	if (!value) return []
	const rows = []
	let current = ""
	for (const word of value.split(" ")) {
		let rest = word
		while (rest.length > width) {
			if (current) {
				rows.push(current)
				current = ""
			}
			rows.push(rest.slice(0, width))
			rest = rest.slice(width)
		}
		if (!rest) continue
		if (!current) current = rest
		else if (`${current} ${rest}`.length <= width) current = `${current} ${rest}`
		else {
			rows.push(current)
			current = rest
		}
	}
	if (current) rows.push(current)
	return rows
}

/** Cash drawer pulse: ESC p m t1 t2 (pin 2 = m 0, 50 ms on, 500 ms off). */
export const DRAWER_KICK = Object.freeze([ESC, 0x70, 0x00, 25, 250])

/**
 * Small chainable builder. Every method appends bytes and returns the builder.
 */
export class EscPosBuilder {
	constructor() {
		/** @type {number[]} */
		this.parts = []
	}

	/** @param {ArrayLike<number>} bytes */
	raw(bytes) {
		for (let i = 0; i < bytes.length; i++) this.parts.push(bytes[i] & 0xff)
		return this
	}

	/** ESC @: reset the printer. */
	init() {
		return this.raw([ESC, 0x40])
	}

	/** @param {"left"|"center"|"right"} align ESC a n */
	align(align) {
		const n = align === "center" ? 1 : align === "right" ? 2 : 0
		return this.raw([ESC, 0x61, n])
	}

	/** @param {boolean} on ESC E n */
	bold(on) {
		return this.raw([ESC, 0x45, on ? 1 : 0])
	}

	/**
	 * GS ! n: character size, 1-8 times wide and high.
	 * @param {number} [width]
	 * @param {number} [height]
	 */
	size(width = 1, height = 1) {
		const w = Math.min(Math.max(Math.round(width), 1), 8) - 1
		const h = Math.min(Math.max(Math.round(height), 1), 8) - 1
		return this.raw([GS, 0x21, (w << 4) | h])
	}

	/** @param {unknown} value ASCII text, no line feed */
	text(value) {
		const s = asciiText(value)
		for (let i = 0; i < s.length; i++) this.parts.push(s.charCodeAt(i))
		return this
	}

	/** @param {unknown} [value] text then LF */
	line(value = "") {
		return this.text(value).raw([LF])
	}

	/** @param {number} [lines] ESC d n */
	feed(lines = 1) {
		return this.raw([ESC, 0x64, Math.min(Math.max(lines, 0), 255)])
	}

	/**
	 * Feed past the cutter, then GS V (full or partial cut).
	 * @param {{ partial?: boolean, feedLines?: number }} [options]
	 */
	cut({ partial = false, feedLines = 4 } = {}) {
		if (feedLines > 0) this.feed(feedLines)
		return this.raw([GS, 0x56, partial ? 0x01 : 0x00])
	}

	/** ESC p 0 25 250 */
	drawerKick() {
		return this.raw(DRAWER_KICK)
	}

	/**
	 * Printer-native Code128 (code set B): GS h, GS w, GS H, GS k 73.
	 * @param {string} value
	 * @param {{ height?: number, moduleWidth?: number, hri?: boolean }} [options]
	 */
	code128(value, { height = 80, moduleWidth = 2, hri = true } = {}) {
		const data = `{B${asciiText(value)}`
		if (data.length > 255) throw new Error("Code128 value too long")
		this.raw([GS, 0x68, Math.min(Math.max(height, 1), 255)])
		this.raw([GS, 0x77, Math.min(Math.max(moduleWidth, 2), 6)])
		this.raw([GS, 0x48, hri ? 2 : 0])
		this.raw([GS, 0x6b, 73, data.length])
		return this.text(data).raw([LF])
	}

	/**
	 * Printer-native QR code (GS ( k, model 2, error level M).
	 * @param {string} value
	 * @param {{ moduleSize?: number }} [options]
	 */
	qr(value, { moduleSize = 6 } = {}) {
		const data = asciiText(value)
		const len = data.length + 3
		this.raw([GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00]) // model 2
		this.raw([GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, Math.min(Math.max(moduleSize, 1), 16)])
		this.raw([GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31]) // error level M
		this.raw([GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 0x31, 0x50, 0x30])
		this.text(data)
		return this.raw([GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30]).raw([LF])
	}

	/**
	 * GS v 0: print a 1-bit image. Tall images are sent in bands because cheap
	 * printers have small receive buffers.
	 * @param {{ bytesPerRow: number, height: number, bits: Uint8Array }} image
	 * @param {{ bandHeight?: number }} [options]
	 */
	raster(image, { bandHeight = 255 } = {}) {
		const { bytesPerRow, height, bits } = image
		const band = Math.min(Math.max(Math.round(bandHeight), 1), 2047)
		for (let top = 0; top < height; top += band) {
			const rows = Math.min(band, height - top)
			this.raw([
				GS,
				0x76,
				0x30,
				0x00,
				bytesPerRow & 0xff,
				(bytesPerRow >> 8) & 0xff,
				rows & 0xff,
				(rows >> 8) & 0xff,
			])
			this.raw(bits.subarray(top * bytesPerRow, (top + rows) * bytesPerRow))
		}
		return this
	}

	/** @returns {Uint8Array} */
	bytes() {
		return Uint8Array.from(this.parts)
	}
}

/**
 * Repeat a print job: copies 1-3 (SPEC F9).
 * @param {Uint8Array} job
 * @param {number} copies
 * @returns {Uint8Array}
 */
export function repeatCopies(job, copies) {
	const n = clampCopies(copies)
	const out = new Uint8Array(job.length * n)
	for (let i = 0; i < n; i++) out.set(job, i * job.length)
	return out
}

/** @param {unknown} copies */
export function clampCopies(copies) {
	return Math.min(Math.max(Math.round(Number(copies) || 1), 1), 3)
}

/**
 * Join byte arrays.
 * @param {...ArrayLike<number>} chunks
 * @returns {Uint8Array}
 */
export function concatBytes(...chunks) {
	const total = chunks.reduce((n, c) => n + c.length, 0)
	const out = new Uint8Array(total)
	let offset = 0
	for (const c of chunks) {
		out.set(c, offset)
		offset += c.length
	}
	return out
}

/**
 * Base64 for QZ Tray raw printing (`flavor: "base64"`). No Buffer or btoa needed.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toBase64(bytes) {
	const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	let out = ""
	let i = 0
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
		out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63] + abc[(n >> 6) & 63] + abc[n & 63]
	}
	const rest = bytes.length - i
	if (rest === 1) {
		const n = bytes[i] << 16
		out += `${abc[(n >> 18) & 63]}${abc[(n >> 12) & 63]}==`
	} else if (rest === 2) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
		out += `${abc[(n >> 18) & 63]}${abc[(n >> 12) & 63]}${abc[(n >> 6) & 63]}=`
	}
	return out
}

/**
 * Readable hex for snapshots and logs.
 * @param {ArrayLike<number>} bytes
 */
export function toHex(bytes) {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ")
}
