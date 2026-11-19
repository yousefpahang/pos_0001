// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Runs raster rendering in the Web Worker; falls back to the main thread when the
// browser has no OffscreenCanvas or the worker fails.

import { toMonochrome, trimBottom } from "@/plus/core/raster"
import { renderMono } from "@/plus/printing/rasterRender"
import { logger } from "@/utils/logger"

const log = logger.create("RasterPrint")
const TIMEOUT_MS = 8000

/** @type {Worker|null} */
let worker = null
let seq = 0
/** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
const pending = new Map()

function getWorker() {
	if (worker) return worker
	if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined")
		return null
	try {
		worker = new Worker(new URL("./raster.worker.js", import.meta.url), {
			type: "module",
		})
		worker.onmessage = (event) => {
			const { id, ok, image, error } = event.data || {}
			const job = pending.get(id)
			if (!job) return
			pending.delete(id)
			clearTimeout(job.timer)
			if (ok) job.resolve(image)
			else job.reject(new Error(error))
		}
		worker.onerror = (event) => {
			log.warn("Raster worker failed", event?.message || event)
			for (const job of pending.values()) {
				clearTimeout(job.timer)
				job.reject(new Error("Raster worker failed"))
			}
			pending.clear()
			worker?.terminate()
			worker = null
		}
		return worker
	} catch (error) {
		log.warn("Raster worker unavailable", error)
		return null
	}
}

/** @param {string|null} dataUrl */
async function loadImage(dataUrl) {
	if (!dataUrl || typeof Image === "undefined") return null
	return new Promise((resolve) => {
		const img = new Image()
		img.onload = () => resolve(img)
		img.onerror = () => resolve(null)
		img.src = dataUrl
	})
}

/**
 * @param {{ ops: import("@/plus/core/receipt").DrawOp[], widthDots: number, logo: string|null }} job
 */
async function renderOnMainThread(job) {
	const logo = await loadImage(job.logo)
	return renderMono(
		(w, h) => {
			const c = document.createElement("canvas")
			c.width = w
			c.height = h
			return c
		},
		{ ops: job.ops, widthDots: job.widthDots, logo },
		{ toMonochrome, trimBottom },
	)
}

/**
 * Render draw ops to a 1-bit image.
 * @param {{ ops: import("@/plus/core/receipt").DrawOp[], widthDots: number, logo: string|null }} job
 * @returns {Promise<import("@/plus/core/raster").MonoImage>}
 */
export async function renderReceiptImage(job) {
	const w = getWorker()
	if (w) {
		try {
			return await new Promise((resolve, reject) => {
				const id = ++seq
				const timer = setTimeout(() => {
					pending.delete(id)
					reject(new Error("Raster worker timed out"))
				}, TIMEOUT_MS)
				pending.set(id, { resolve, reject, timer })
				w.postMessage({ id, ...job })
			})
		} catch (error) {
			log.warn("Raster worker error, drawing on the main thread", error)
		}
	}
	return renderOnMainThread(job)
}
