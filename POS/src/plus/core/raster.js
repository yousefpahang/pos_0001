// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Raster receipts (SPEC F9 `raster` mode): RGBA pixels from a canvas to a 1-bit image,
// then to ESC/POS GS v 0 bands. Plain JavaScript, used by the raster Web Worker.

import { EscPosBuilder, clampCopies, concatBytes } from "./escpos.js"

/**
 * @typedef {Object} MonoImage
 * @property {number} width        pixels
 * @property {number} height       pixels
 * @property {number} bytesPerRow  ceil(width / 8)
 * @property {Uint8Array} bits     1 = black, most significant bit is the leftmost pixel
 */

/**
 * Convert RGBA pixels (canvas ImageData layout) to a 1-bit image. Transparent pixels
 * count as white paper.
 * @param {Uint8ClampedArray|Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{ threshold?: number, dither?: boolean }} [options]
 * @returns {MonoImage}
 */
export function toMonochrome(rgba, width, height, { threshold = 128, dither = false } = {}) {
	if (rgba.length < width * height * 4) throw new Error("Pixel buffer is too small")
	const bytesPerRow = Math.ceil(width / 8)
	const bits = new Uint8Array(bytesPerRow * height)
	const lum = new Float32Array(width * height)
	for (let p = 0, i = 0; p < width * height; p++, i += 4) {
		const a = rgba[i + 3] / 255
		const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
		lum[p] = 255 - a * (255 - l)
	}
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const p = y * width + x
			const old = lum[p]
			const black = old < threshold
			if (black) bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7)
			if (dither) {
				// Floyd-Steinberg error diffusion (for logos and photos).
				const err = old - (black ? 0 : 255)
				if (x + 1 < width) lum[p + 1] += (err * 7) / 16
				if (y + 1 < height) {
					if (x > 0) lum[p + width - 1] += (err * 3) / 16
					lum[p + width] += (err * 5) / 16
					if (x + 1 < width) lum[p + width + 1] += err / 16
				}
			}
		}
	}
	return { width, height, bytesPerRow, bits }
}

/**
 * Drop blank rows at the bottom (the canvas is drawn taller than needed).
 * @param {MonoImage} image
 * @param {number} [keep] blank rows to leave under the last black row
 * @returns {MonoImage}
 */
export function trimBottom(image, keep = 8) {
	const { bytesPerRow, bits } = image
	let last = -1
	for (let y = image.height - 1; y >= 0 && last < 0; y--) {
		for (let b = 0; b < bytesPerRow; b++) {
			if (bits[y * bytesPerRow + b]) {
				last = y
				break
			}
		}
	}
	const height = Math.min(image.height, Math.max(1, last + 1 + keep))
	return { ...image, height, bits: bits.slice(0, height * bytesPerRow) }
}

/**
 * Full raster print job: reset, optional drawer kick (first copy only), image bands,
 * optional cut, repeated for copies.
 * @param {MonoImage} image
 * @param {{ cut?: boolean, drawer?: boolean, copies?: number, bandHeight?: number }} [options]
 * @returns {Uint8Array}
 */
export function rasterJob(image, { cut = true, drawer = false, copies = 1, bandHeight = 255 } = {}) {
	const jobs = []
	const n = clampCopies(copies)
	for (let i = 0; i < n; i++) {
		const b = new EscPosBuilder().init()
		if (drawer && i === 0) b.drawerKick()
		b.raster(image, { bandHeight })
		if (cut) b.cut()
		else b.feed(4)
		jobs.push(b.bytes())
	}
	return concatBytes(...jobs)
}
