// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Raster receipt worker (SPEC F9 `raster` mode): paints the receipt on an OffscreenCanvas,
// converts it to a 1-bit image and sends it back. Keeps the till responsive while a long
// receipt is drawn.

import { toMonochrome, trimBottom } from "../core/raster.js"
import { renderMono } from "./rasterRender.js"

self.onmessage = async (event) => {
	const { id, ops, widthDots, logo } = event.data || {}
	try {
		let bitmap = null
		if (logo) {
			try {
				const blob = await (await fetch(logo)).blob()
				bitmap = await createImageBitmap(blob)
			} catch {
				bitmap = null // print without the logo
			}
		}
		const image = renderMono(
			(w, h) => new OffscreenCanvas(w, h),
			{ ops, widthDots, logo: bitmap },
			{ toMonochrome, trimBottom },
		)
		self.postMessage({ id, ok: true, image }, [image.bits.buffer])
	} catch (error) {
		self.postMessage({ id, ok: false, error: String(error?.message || error) })
	}
}
