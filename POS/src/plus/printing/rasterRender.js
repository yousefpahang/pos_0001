// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Draw ops -> canvas -> 1-bit image. Shared by the raster worker and the main-thread
// fallback; the caller supplies the canvas factory.

import { draw, measure } from "./receiptPainter.js"

/**
 * @param {(w: number, h: number) => (OffscreenCanvas|HTMLCanvasElement)} makeCanvas
 * @param {{ ops: import("@/plus/core/receipt").DrawOp[], widthDots: number, logo: CanvasImageSource|null }} job
 * @param {{ toMonochrome: typeof import("@/plus/core/raster").toMonochrome,
 *   trimBottom: typeof import("@/plus/core/raster").trimBottom }} raster
 * @returns {import("@/plus/core/raster").MonoImage}
 */
export function renderMono(makeCanvas, { ops, widthDots, logo }, raster) {
	const probe = makeCanvas(widthDots, 10).getContext("2d")
	const layout = measure(probe, ops, { widthDots, logo })
	const height = Math.max(1, Math.ceil(layout.height))
	const canvas = makeCanvas(widthDots, height)
	const ctx = canvas.getContext("2d")
	draw(ctx, layout, { widthDots, logo })
	const pixels = ctx.getImageData(0, 0, widthDots, height).data
	return raster.trimBottom(
		raster.toMonochrome(pixels, widthDots, height, { threshold: 150 }),
		16,
	)
}
