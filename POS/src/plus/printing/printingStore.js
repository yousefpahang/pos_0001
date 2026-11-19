// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Receipt printing for the till (SPEC F9). Holds the printing cache (receipt printer
// profile, company header, footer, logo, cash modes, No Sale permission) in IndexedDB so
// printing works offline, and prints in the profile's mode:
//   raster      -> draw in a Web Worker, 1-bit, GS v 0, raw through QZ
//   escpos_text -> ESC/POS text, raw through QZ
//   qz_html     -> POS Next's QZ HTML printing
//   browser     -> POS Next's browser printing
// Modes that need QZ fall back to the browser when QZ Tray is not running. A till with
// no printer profile keeps POS Next's printing unchanged.

import { DRAWER_KICK, dotsForPaper } from "@/plus/core/escpos"
import { rasterJob } from "@/plus/core/raster"
import {
	QZ_MODES,
	buildReceiptModel,
	isLocalInvoiceName,
	layoutReceipt,
	planPrint,
	shouldKickDrawer,
	textReceipt,
} from "@/plus/core/receipt"
import {
	PrinterUnavailableError,
	ensureQz,
	qzConnected,
	sendRaw,
} from "@/plus/printing/qz"
import { receiptHtml } from "@/plus/core/receiptHtml"
import { printReceiptWindow } from "@/plus/printing/browserReceipt"
import { renderReceiptImage } from "@/plus/printing/rasterClient"
import { getDeviceId } from "@/plus/sync/syncClient"
import { usePOSShiftStore } from "@/stores/posShift"
import { usePOSSyncStore } from "@/stores/posSync"
import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"
import { db } from "@/utils/offline/db"
import { printHTML as qzPrintHTML } from "@/utils/qzTray"
import { getOfflineInvoiceByOfflineId } from "@/utils/offline/sync"
import {
	printInvoice as posNextBrowserPrint,
	silentPrintDoc,
} from "@/utils/printInvoice"
import { defineStore } from "pinia"
import { computed, ref, watch } from "vue"

const log = logger.create("PlusPrinting")
const API = "pos_next.pos_0001.api.printing"
const CACHE_PREFIX = "pos0001_printing_cache::"
const LAST_PREFIX = "pos0001_last_receipt::"
const EVENTS_KEY = "pos0001_drawer_events"
const REFRESH_MS = 5 * 60_000

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

/** Logo URL -> data URL, so the logo prints offline. @param {string|null} url */
async function logoDataUrl(url) {
	if (!url) return null
	try {
		const res = await fetch(url, { credentials: "same-origin" })
		if (!res.ok) return null
		const blob = await res.blob()
		if (blob.size > 512 * 1024) return null
		return await new Promise((resolve) => {
			const reader = new FileReader()
			reader.onload = () => resolve(reader.result)
			reader.onerror = () => resolve(null)
			reader.readAsDataURL(blob)
		})
	} catch {
		return null
	}
}

function newEventId() {
	const rand =
		globalThis.crypto?.randomUUID?.() ||
		`${Date.now()}-${Math.random().toString(36).slice(2)}`
	return `ns-${rand}`.slice(0, 64)
}

export const usePlusPrintingStore = defineStore("plusPrinting", () => {
	const posShift = usePOSShiftStore()
	const posSync = usePOSSyncStore()

	const profile = ref(/** @type {string|null} */ (null))
	const cache = ref(/** @type {Record<string, any>|null} */ (null))
	const busy = ref(false)
	const lastResult = ref(
		/** @type {{mode: string, fallback: boolean, ok: boolean, error?: string, at: number}|null} */ (
			null
		),
	)
	const pendingEvents = ref(0)
	let timer = null
	let shortcutsInstalled = false

	const printer = computed(() => cache.value?.printer || null)
	/** True when pos_0001 prints receipts for this till (a printer profile is set). */
	const active = computed(() => Boolean(printer.value))
	const needsQz = computed(() =>
		Boolean(printer.value && QZ_MODES.includes(printer.value.print_mode)),
	)
	const canNoSale = computed(() =>
		Boolean(cache.value?.can_no_sale && printer.value),
	)
	/** none (no printer profile), ok, down (QZ needed but not connected) */
	const status = computed(() => {
		if (!printer.value) return "none"
		if (needsQz.value && !qzConnected.value) return "down"
		return "ok"
	})

	async function fetchCache(name) {
		if (posSync.isOffline) return null
		try {
			const data = await call(`${API}.get_printing_cache`, {
				pos_profile: name,
				device_id: getDeviceId(),
			})
			if (!data) return null
			const previous = cache.value
			const logo =
				data.logo_url && previous?.logo_url === data.logo_url && previous?.logo
					? previous.logo
					: await logoDataUrl(data.logo_url)
			const value = { ...data, logo, loaded_at: Date.now() }
			await writeSetting(CACHE_PREFIX + name, value)
			return value
		} catch (error) {
			log.warn("Could not refresh the printing cache", error)
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
		const stored = await readSetting(CACHE_PREFIX + name)
		if (stored && profile.value === name) cache.value = stored
		const fresh = await fetchCache(name)
		if (fresh && profile.value === name) cache.value = fresh
		if (needsQz.value && !qzConnected.value) ensureQz().catch(() => {})
		if (!timer) {
			timer = setInterval(async () => {
				if (!profile.value) return
				const next = await fetchCache(profile.value)
				if (next) cache.value = next
			}, REFRESH_MS)
		}
		installShortcuts()
		flushDrawerEvents()
	}

	/** Connect QZ Tray again (badge button). */
	async function reconnect() {
		return ensureQz()
	}

	/**
	 * Find the invoice data to print.
	 * @param {Record<string, any>} invoice
	 */
	async function resolveDoc(invoice) {
		if (Array.isArray(invoice?.items) && invoice.items.length) {
			return withLocalDetails(invoice)
		}
		const name = invoice?.name
		if (!name) throw new Error(t("Invoice to print is missing."))
		if (!isLocalInvoiceName(name) && !posSync.isOffline) {
			const data = await call(`${API}.get_receipt_data`, { invoice: name })
			if (data?.items?.length) return data
		}
		const last = await readSetting(LAST_PREFIX + (profile.value || ""))
		if (last?.name === name) return last
		throw new Error(
			posSync.isOffline
				? t(
						"This receipt is not stored on the till. Reprint it when the till is online.",
					)
				: t("Invoice {0} could not be loaded for printing.", [name]),
		)
	}

	/**
	 * POS Next's offline receipt doc has no time or sales team; take the sales team from
	 * the queued invoice and the time from the clock (the receipt prints at the sale).
	 * @param {Record<string, any>} doc
	 */
	async function withLocalDetails(doc) {
		if (!isLocalInvoiceName(doc.name)) return doc
		const out = { ...doc }
		if (!out.posting_time)
			out.posting_time = new Date().toTimeString().slice(0, 8)
		if (!out.currency) out.currency = posShift.profileCurrency
		if (!out.sales_team?.length) {
			try {
				const queued = await getOfflineInvoiceByOfflineId(doc.name)
				if (queued?.sales_team?.length) out.sales_team = queued.sales_team
			} catch (error) {
				log.debug("No queued invoice for", doc.name, error)
			}
		}
		return out
	}

	/**
	 * Arabic item names (Item `item_name_ar`, SPEC section 7) for lines that lack one:
	 * from the cached items, then the label cache.
	 * @param {Record<string, any>} doc
	 * @returns {Promise<Record<string, string>>}
	 */
	async function arabicNamesFor(doc) {
		const codes = [
			...new Set(
				(doc.items || [])
					.filter((i) => i?.item_code && !i.item_name_ar)
					.map((i) => i.item_code),
			),
		]
		if (!codes.length) return {}
		const names = {}
		try {
			const rows = await db.items.bulkGet(codes)
			for (const row of rows)
				if (row?.item_name_ar) names[row.item_code] = row.item_name_ar
		} catch (error) {
			log.debug("Could not read Arabic names", error)
		}
		if (codes.some((c) => !names[c])) {
			const labels = await readSetting(
				`pos0001_label_cache::${profile.value || ""}`,
			)
			for (const c of codes)
				if (!names[c] && labels?.ar_names?.[c]) names[c] = labels.ar_names[c]
		}
		return names
	}

	/** @param {Record<string, any>} doc @param {boolean} reprint */
	async function modelFor(doc, reprint) {
		const c = cache.value || {}
		return buildReceiptModel(doc, {
			currency: posShift.profileCurrency,
			company: c.company,
			cashModes: c.cash_modes,
			footer: c.footer,
			logo: c.logo,
			cashier: doc.cashier || c.cashier,
			reprint,
			titleMode: c.invoice_title,
			symbolMode: c.currency_symbol,
			lang:
				typeof document !== "undefined" ? document.documentElement.lang : "en",
			arabicNames: await arabicNamesFor(doc),
		})
	}

	/**
	 * Run one print job in a given mode.
	 * @param {string} mode
	 * @param {Record<string, any>} doc
	 * @param {ReturnType<typeof buildReceiptModel>} model
	 * @param {{ drawer: boolean }} job
	 */
	async function runMode(mode, doc, model, { drawer }) {
		const p = printer.value
		const copies = Math.min(Math.max(Number(p.copies) || 1, 1), 3)
		if (mode === "raster") {
			const widthDots = dotsForPaper(p.paper_width_mm)
			const ops = layoutReceipt(model, {
				widthDots,
				barcode: p.receipt_barcode,
			})
			const image = await renderReceiptImage({
				ops,
				widthDots,
				logo: model.logo,
			})
			await sendRaw(
				rasterJob(image, { cut: Boolean(Number(p.auto_cut)), drawer, copies }),
				p,
			)
			return
		}
		if (mode === "escpos_text") {
			const bytes = textReceipt(model, {
				paperWidthMm: p.paper_width_mm,
				columns: p.characters_per_line,
				cut: Boolean(Number(p.auto_cut)),
				drawer,
				copies,
				barcode: p.receipt_barcode,
			})
			await sendRaw(bytes, p)
			return
		}
		if (mode === "qz_html") {
			if (drawer) await sendRaw(Uint8Array.from(DRAWER_KICK), p)
			const printerName = p.qz_printer || undefined
			for (let i = 0; i < copies; i++) {
				// Local invoices: the bilingual receipt from local data (works offline).
				if (isLocalInvoiceName(doc.name))
					await qzPrintHTML(
						receiptHtml(model, {
							paperWidthMm: p.paper_width_mm,
							barcode: p.receipt_barcode,
						}),
						printerName,
						{ width: Number(p.paper_width_mm) === 58 ? 58 : 80 },
					)
				else
					await silentPrintDoc(
						"Sales Invoice",
						doc.name,
						p.print_format || cache.value?.print_format,
						printerName,
					)
			}
			return
		}
		// browser: the cashier confirms the print dialog; the drawer opens only when QZ is up.
		if (drawer) {
			if (qzConnected.value) {
				await sendRaw(Uint8Array.from(DRAWER_KICK), p).catch((error) =>
					log.warn("Drawer kick failed", error),
				)
			} else {
				window.frappe?.show_alert?.({
					message: t("Cash drawer did not open: QZ Tray is not running."),
					indicator: "orange",
				})
			}
		}
		if (isLocalInvoiceName(doc.name) || posSync.isOffline)
			printReceiptWindow(
				receiptHtml(model, {
					paperWidthMm: p.paper_width_mm,
					barcode: p.receipt_barcode,
					autoPrint: true,
				}),
			)
		else
			await posNextBrowserPrint(
				{ name: doc.name, doctype: "Sales Invoice" },
				p.print_format || cache.value?.print_format,
			)
	}

	/**
	 * Print a receipt. `reason` "sale" may open the drawer; "reprint" never does.
	 * @param {Record<string, any>} invoice
	 * @param {{ reason?: "sale"|"reprint"|"test" }} [options]
	 * @returns {Promise<{mode: string, fallback: boolean}>}
	 */
	async function printInvoice(invoice, { reason = "reprint" } = {}) {
		if (!printer.value)
			throw new Error(t("No receipt printer is set for this till."))
		busy.value = true
		const started = Date.now()
		try {
			if (needsQz.value && !qzConnected.value)
				await ensureQz().catch(() => false)
			const doc = await resolveDoc(invoice)
			const model = await modelFor(doc, reason === "reprint")
			const drawer = shouldKickDrawer(printer.value, model, { reason })
			let plan = planPrint(printer.value, { qzConnected: qzConnected.value })
			try {
				await runMode(plan.mode, doc, model, { drawer })
			} catch (error) {
				if (plan.mode === "browser") throw error
				log.warn(`Print in ${plan.mode} failed, using the browser`, error)
				plan = {
					mode: "browser",
					fallback: true,
					reason: error?.code || "print_failed",
				}
				await runMode("browser", doc, model, { drawer: false })
			}
			if (reason !== "test" && !doc.is_test) {
				// Plain copy: the doc may be a reactive proxy (e.g. POS Next's offline print
				// snapshot in the UI store), which IndexedDB cannot store.
				await writeSetting(
					LAST_PREFIX + (profile.value || ""),
					JSON.parse(JSON.stringify(doc)),
				)
			}
			lastResult.value = {
				mode: plan.mode,
				fallback: plan.fallback,
				ok: true,
				at: Date.now(),
			}
			log.info(
				`Receipt ${doc.name} printed in ${plan.mode} (${Date.now() - started} ms)`,
			)
			return { mode: plan.mode, fallback: plan.fallback }
		} catch (error) {
			lastResult.value = {
				mode: printer.value?.print_mode || "",
				fallback: false,
				ok: false,
				error: String(error?.message || error),
				at: Date.now(),
			}
			throw error
		} finally {
			busy.value = false
		}
	}

	/** F9: reprint the last receipt printed on this till. */
	async function reprintLast() {
		const last = await readSetting(LAST_PREFIX + (profile.value || ""))
		if (!last) throw new Error(t("No receipt to reprint yet."))
		return printInvoice(last, { reason: "reprint" })
	}

	/** Test page from the badge menu. */
	async function testPrint() {
		const doc = {
			name: "TEST-0001",
			is_test: true,
			posting_date: new Date().toISOString().slice(0, 10),
			posting_time: new Date().toTimeString().slice(0, 5),
			pos_profile: profile.value,
			customer_name: t("Test print"),
			items: [
				{
					item_name: t("Test item"),
					item_name_ar: "منتج تجريبي",
					qty: 1,
					uom: "Nos",
					rate: 10,
					amount: 10,
				},
			],
			net_total: 10,
			total_taxes_and_charges: 0.5,
			grand_total: 10.5,
			payments: [{ mode_of_payment: t("Test"), amount: 10.5 }],
		}
		return printInvoice(doc, { reason: "test" })
	}

	async function queueEvent(event) {
		const list = (await readSetting(EVENTS_KEY)) || []
		list.push(event)
		await writeSetting(EVENTS_KEY, list.slice(-500))
		pendingEvents.value = list.length
	}

	/** Upload No Sale events stored on the till. */
	async function flushDrawerEvents() {
		const list = (await readSetting(EVENTS_KEY)) || []
		pendingEvents.value = list.length
		if (!list.length || posSync.isOffline) return
		try {
			const results =
				(await call(`${API}.log_drawer_events`, {
					events: JSON.stringify(list.slice(0, 200)),
				})) || []
			const done = new Set(
				results.filter((r) => r.status === "Stored").map((r) => r.event_id),
			)
			const rest = ((await readSetting(EVENTS_KEY)) || []).filter(
				(e) => !done.has(e.event_id),
			)
			await writeSetting(EVENTS_KEY, rest)
			pendingEvents.value = rest.length
		} catch (error) {
			log.warn("Could not upload drawer events", error)
		}
	}

	/**
	 * No Sale: open the drawer without a sale (permission from the cache, works offline).
	 * Every opening is logged; offline events are uploaded later.
	 * @param {string} [reason]
	 */
	async function noSale(reason = "") {
		if (!canNoSale.value)
			throw new Error(
				t("You are not allowed to open the cash drawer without a sale."),
			)
		const p = printer.value
		if (p.print_mode === "browser" && !qzConnected.value) {
			throw new PrinterUnavailableError(
				t("The cash drawer opens through QZ Tray, which is not running."),
				"qz_not_connected",
			)
		}
		await sendRaw(Uint8Array.from(DRAWER_KICK), p)
		await queueEvent({
			event_id: newEventId(),
			opened_at: Date.now(),
			pos_profile: profile.value,
			device_id: getDeviceId(),
			pos_opening_shift: posShift.currentShift?.name || null,
			was_offline: posSync.isOffline ? 1 : 0,
			reason: String(reason || "").slice(0, 500),
		})
		flushDrawerEvents()
	}

	function installShortcuts() {
		if (shortcutsInstalled || typeof window === "undefined") return
		shortcutsInstalled = true
		window.addEventListener("keydown", (event) => {
			if (event.key !== "F9" || event.repeat || !active.value) return
			event.preventDefault()
			reprintLast().catch((error) => {
				window.frappe?.show_alert?.({
					message: String(error?.message || error),
					indicator: "red",
				})
			})
		})
	}

	watch(
		() => posSync.isOffline,
		(offline) => {
			if (!offline) flushDrawerEvents()
		},
	)

	return {
		profile,
		cache,
		printer,
		active,
		needsQz,
		canNoSale,
		status,
		busy,
		lastResult,
		pendingEvents,
		qzConnected,
		load,
		reconnect,
		printInvoice,
		reprintLast,
		testPrint,
		noSale,
		flushDrawerEvents,
	}
})
