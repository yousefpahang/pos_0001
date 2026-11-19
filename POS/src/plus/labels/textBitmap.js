// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Arabic (or any) text as a 1-bit bitmap for thermal labels (SPEC F4). The browser's text
// engine shapes Arabic and lays it out right to left; label printer fonts cannot.

import { packBits } from "@/plus/core/labels"

const FONT =
	"'Noto Naskh Arabic', 'Noto Sans Arabic', 'DejaVu Sans', Tahoma, Arial, sans-serif"

/** @param {number} w @param {number} h */
function makeCanvas(w, h) {
	if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h)
	const canvas = document.createElement("canvas")
	canvas.width = w
	canvas.height = h
	return canvas
}

/**
 * Draw text right to left, shrink it to fit maxWidth, threshold to 1-bit.
 * @type {import("@/plus/core/labels").BitmapRenderer}
 */
export function canvasTextBitmap(text, height, maxWidth) {
	const probe = makeCanvas(8, 8).getContext("2d")
	let size = Math.max(Math.round(height), 8)
	probe.font = `${size}px ${FONT}`
	probe.direction = "rtl"
	let width = Math.ceil(probe.measureText(text).width)
	if (width > maxWidth) {
		size = Math.max(8, Math.floor((size * maxWidth) / width))
		probe.font = `${size}px ${FONT}`
		width = Math.ceil(probe.measureText(text).width)
	}
	width = Math.max(1, Math.min(width, Math.round(maxWidth)))
	const h = Math.max(Math.round(height), 1)
	const canvas = makeCanvas(width, h)
	const ctx = canvas.getContext("2d")
	ctx.fillStyle = "#fff"
	ctx.fillRect(0, 0, width, h)
	ctx.fillStyle = "#000"
	ctx.font = `${size}px ${FONT}`
	ctx.direction = "rtl"
	ctx.textAlign = "right"
	ctx.textBaseline = "middle"
	ctx.fillText(text, width, h / 2)
	const pixels = ctx.getImageData(0, 0, width, h).data
	return packBits(width, h, (x, y) => {
		const i = (y * width + x) * 4
		return (
			pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114 < 128
		)
	})
}
