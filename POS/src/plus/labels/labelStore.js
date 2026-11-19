// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Barcode label printing (SPEC F4) for the till and the desk page pos-labels. Keeps the
// label cache (templates, label printer, VAT, price list) in IndexedDB so labels print
// offline. Raw templates (ZPL / EPL / TSPL) go to the label printer through QZ Tray; PDF
// templates print an A4 sheet through the browser, or as a PDF from the server.

import {
	LabelRowError,
	RAW_LANGUAGES,
	formatDate,
	renderPdfHtml,
	renderRaw,
	resolveRow,
	withBarcodeTypes,
} from "@/plus/core/labels"
import { canvasTextBitmap } from "@/plus/labels/textBitmap"
import { PrinterUnavailableError, sendRaw } from "@/plus/printing/qz"
import { getScanCache } from "@/plus/scan/scanCache"
import { getDeviceId } from "@/plus/sync/syncClient"
import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"
import { isOffline } from "@/utils/offline"
import { db } from "@/utils/offline/db"
import { defineStore } from "pinia"
import { computed, ref } from "vue"

const log = logger.create("PlusLabels")
const API = "pos_next.pos_0001.api.labels"
const CACHE_PREFIX = "pos0001_label_cache::"
const SEARCH_LIMIT = 20

/** @param {string} text @param {unknown[]} [args] */
function t(text, args) {
	return typeof __ === "function" ? __(text, args) : text
}

async function readSetting(key) {
	try {
		return (await db.settings.get(key))?.value ?? null
	} catch (error) {
		log.warn("Could not read", key, error)
		return null
	}
}

async function writeSetting(key, value) {
	try {
		await db.settings.put({ key, value })
	} catch (error) {
		log.warn("Could not write", key, error)
	}
}

/**
 * Cashier message for a row that cannot be printed.
 * @param {unknown} error
 * @param {string} itemCode
 */
export function rowErrorMessage(error, itemCode) {
	if (error instanceof LabelRowError) {
		const d = error.details || {}
		switch (error.code) {
			case "qty":
				return t("Label quantity must be between 1 and {0}.", [d.max])
			case "uom":
				return t("Item {0} has no UOM {1}.", [d.item_code, d.uom])
			case "plu":
				return t(
					"Item {0} has no scale code that fits rule {1} ({2} digits).",
					[d.item_code, d.rule, d.digits],
				)
			case "scale_value":
				return t("Enter the weight or price for the scale label of {0}.", [
					d.item_code,
				])
			case "rule":
				return t("Scale barcode rule {0} is not available offline.", [d.rule])
			default:
				break
		}
	}
	if (error?.message === "not_cached")
		return t(
			"Item {0} is not stored on this till. Connect to the server to print it.",
			[itemCode],
		)
	return String(error?.messages?.[0] || error?.message || error)
}

/** Print an HTML document through a hidden frame (A4 sheets, browser print dialog). */
function printHtml(html) {
	return new Promise((resolve, reject) => {
		const frame = document.createElement("iframe")
		frame.setAttribute("aria-hidden", "true")
		frame.style.cssText =
			"position:fixed;right:0;bottom:0;width:0;height:0;border:0"
		frame.onload = () => {
			try {
				frame.contentWindow.focus()
				frame.contentWindow.print()
				resolve(true)
			} catch (error) {
				reject(error)
			} finally {
				setTimeout(() => frame.remove(), 60_000)
			}
		}
		frame.srcdoc = html
		document.body.appendChild(frame)
	})
}

export const usePlusLabelStore = defineStore("plusLabels", () => {
	const profile = ref(/** @type {string|null} */ (null))
	const cache = ref(/** @type {Record<string, any>|null} */ (null))
	const loading = ref(false)
	const busy = ref(false)

	const templates = computed(() => cache.value?.templates || [])
	const printer = computed(() => cache.value?.printer || null)
	const canPrint = computed(() => Boolean(cache.value?.can_print))

	async function fetchCache(name) {
		if (isOffline()) return null
		try {
			const data = await call(`${API}.get_label_cache`, {
				pos_profile: name,
				device_id: getDeviceId(),
			})
			if (!data) return null
			const value = { ...data, loaded_at: Date.now() }
			await writeSetting(CACHE_PREFIX + name, value)
			return value
		} catch (error) {
			log.warn("Could not refresh the label cache", error)
			return null
		}
	}

	/**
	 * Load for a POS Profile: stored copy first (offline), then the server.
	 * @param {string} name
	 */
	async function load(name) {
		if (!name) return
		if (profile.value !== name) {
			profile.value = name
			cache.value = null
		}
		loading.value = true
		try {
			const stored = await readSetting(CACHE_PREFIX + name)
			if (stored && profile.value === name) cache.value = stored
			const fresh = await fetchCache(name)
			if (fresh && profile.value === name) cache.value = fresh
		} finally {
			loading.value = false
		}
	}

	function template(name) {
		return templates.value.find((tpl) => tpl.name === name) || null
	}

	async function scanCache() {
		return (profile.value && (await getScanCache(profile.value))) || {}
	}

	/** Scale rules the till knows (POS Scale Barcode Rule, from the scan cache). */
	async function scaleRules() {
		return (await scanCache()).rules || []
	}

	/**
	 * Resolve rows: on the server when online (exact prices and VAT), else from the
	 * browser cache. Each result is a row or {error}.
	 * @param {Array<Record<string, any>>} rows
	 */
	async function resolveRows(rows) {
		if (!rows.length) return []
		if (!isOffline()) {
			try {
				return await call(`${API}.resolve_rows`, {
					rows: JSON.stringify(rows),
					pos_profile: profile.value,
				})
			} catch (error) {
				if (rows.length === 1)
					return [{ error: rowErrorMessage(error, rows[0].item_code) }]
				// One bad row fails the whole call: resolve one by one.
				const out = []
				for (const row of rows) out.push((await resolveRows([row]))[0])
				return out
			}
		}
		const scan = await scanCache()
		const out = []
		for (const row of rows) {
			try {
				const item = await db.items.get(row.item_code)
				if (!item) throw new Error("not_cached")
				out.push(resolveRow(row, item, cache.value || {}, scan))
			} catch (error) {
				out.push({ error: rowErrorMessage(error, row.item_code) })
			}
		}
		return out
	}

	/**
	 * Items to add: exact barcode first, then code or name.
	 * @param {string} query
	 */
	async function searchItems(query) {
		const q = String(query || "").trim()
		if (!q) return []
		if (!isOffline()) {
			try {
				return (
					(await call(`${API}.search_items`, {
						query: q,
						pos_profile: profile.value,
					})) || []
				)
			} catch (error) {
				log.warn("Label item search failed, using the till cache", error)
			}
		}
		const found = new Map()
		try {
			const scan = await scanCache()
			const byUom = scan.uom_barcodes?.[q]
			const exact = byUom
				? await db.items.get(byUom.item_code)
				: await db.items.where("barcodes").equals(q).first()
			if (exact)
				found.set(exact.item_code, {
					item_code: exact.item_code,
					uom: byUom?.uom,
				})
			const lower = q.toLowerCase()
			for (const index of ["item_code", "item_name"]) {
				if (found.size >= SEARCH_LIMIT) break
				const items = await db.items
					.where(index)
					.startsWithIgnoreCase(lower)
					.limit(SEARCH_LIMIT)
					.toArray()
				for (const item of items) {
					if (!item.disabled && !found.has(item.item_code))
						found.set(item.item_code, { item_code: item.item_code })
				}
			}
		} catch (error) {
			log.warn("Cached item search failed", error)
		}
		const rows = [...found.values()]
			.slice(0, SEARCH_LIMIT)
			.map((r) => ({ ...r, qty: 1 }))
		return (await resolveRows(rows)).filter((r) => !r.error)
	}

	/** Rows of a Purchase Receipt or Stock Entry (needs the server). */
	async function fromDocument(doctype, name) {
		return call(`${API}.items_from_document`, {
			doctype,
			name,
			pos_profile: profile.value,
		})
	}

	function base() {
		const c = cache.value || {}
		return {
			currency: c.currency || "",
			company: c.company || "",
			date: formatDate(new Date(), c.date_format),
		}
	}

	/**
	 * Print labels. Raw templates go to the label printer through QZ Tray; PDF templates
	 * open the browser print dialog with the A4 sheet.
	 * @param {string} templateName
	 * @param {Array<Record<string, any>>} rows resolved rows
	 * @returns {Promise<{mode: "raw"|"browser", labels: number}>}
	 */
	async function print(templateName, rows) {
		const tpl = template(templateName)
		if (!tpl) throw new Error(t("Choose a label template."))
		if (!rows.length)
			throw new Error(t("Add at least one item to print labels."))
		const typed = withBarcodeTypes(tpl, rows)
		const labels = typed.reduce((n, r) => n + (Number(r.qty) || 1), 0)
		busy.value = true
		try {
			if (RAW_LANGUAGES.includes(tpl.language)) {
				const p = printer.value
				if (!p)
					throw new PrinterUnavailableError(
						t(
							"No label printer is set for this till. Use an A4 template or ask a manager to set one.",
						),
						"no_printer",
					)
				if (p.label_language && p.label_language !== tpl.language)
					throw new Error(
						t("Template {0} is {1}, but the label printer {2} expects {3}.", [
							tpl.name,
							tpl.language,
							p.printer_name,
							p.label_language,
						]),
					)
				const bytes = renderRaw(tpl, typed, base(), canvasTextBitmap)
				await sendRaw(bytes, p)
				return { mode: "raw", labels }
			}
			await printHtml(renderPdfHtml(tpl, typed, base()))
			return { mode: "browser", labels }
		} finally {
			busy.value = false
		}
	}

	/** A4 sheet as a PDF made on the server (online). */
	async function downloadPdf(templateName, rows) {
		busy.value = true
		try {
			const out = await call(`${API}.render`, {
				template: templateName,
				rows: JSON.stringify(
					rows.map((r) => ({
						item_code: r.item_code,
						uom: r.uom,
						qty: r.qty,
						price: r.price_override ?? null,
						scale_rule: r.scale_rule || null,
						scale_value: r.scale_value || null,
					})),
				),
				pos_profile: profile.value,
			})
			if (out?.file_url) window.open(out.file_url, "_blank")
			return out
		} finally {
			busy.value = false
		}
	}

	return {
		profile,
		cache,
		loading,
		busy,
		templates,
		printer,
		canPrint,
		load,
		template,
		scaleRules,
		resolveRows,
		searchItems,
		fromDocument,
		print,
		downloadPdf,
	}
})
