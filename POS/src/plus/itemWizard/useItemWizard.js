// Copyright (c) 2026, pos_0001 contributors. License: AGPL-3.0.
// State and server calls of the Item Wizard page (SPEC F13). The price logic itself lives in
// plus/core/itemWizard.js; the server (pos_0001.api.items) checks the same payload again.
import {
	ENTRY_UNITS,
	STEPS,
	defaultSellingUnits,
	normalize,
	payloadErrors,
	unitPrices,
} from "@/plus/core/itemWizard"
import { call } from "@/utils/apiWrapper"
import { computed, reactive, ref, toRaw } from "vue"

const API = "pos_next.pos_0001.api.items"
const EDIT_STEPS = ["buying", "selling", "prices", "barcodes", "review"]
/** Steps the server checks before Next (duplicates, links, PLU). */
const SERVER_STEPS = new Set([
	"basics",
	"buying",
	"selling",
	"prices",
	"barcodes",
	"stock",
])

/** @param {unknown} e */
export function errorText(e) {
	const messages = /** @type {any} */ (e)?.messages
	if (Array.isArray(messages) && messages.length)
		return messages
			.map((m) => String(m).replace(/<br\s*\/?>/g, "\n"))
			.join("\n")
	return String(/** @type {any} */ (e)?.message || e || "")
}

function blankUnit(uom, extra = {}) {
	return {
		uom,
		size: 1,
		size_uom: "",
		priced: 1,
		price: "",
		barcode: "",
		remove: 0,
		existing: 0,
		...extra,
	}
}

function blankForm(defaults) {
	const profile = defaults?.profile || {}
	return {
		preset: "",
		item_code: "",
		item_name: "",
		item_name_ar: "",
		item_group: "",
		brand: "",
		image: "",
		stock_uom: "Kg",
		buying_units: [],
		supplier: "",
		buying_price: "",
		selling_units: defaultSellingUnits("Kg").map((u) =>
			blankUnit(u.uom, { size_uom: u.size_uom }),
		),
		sold_on_scale: 0,
		scale_rule: defaults?.scale_rules?.[0]?.name || "",
		scale_plu: "",
		price_mode: "price",
		base_price: "",
		margin_pct: "",
		prices_include_vat: 1,
		item_tax_template: defaults?.default_item_tax_template || "",
		opening_stock: {
			qty: "",
			uom: "",
			warehouse: profile.warehouse || "",
			cost: "",
		},
	}
}

const asText = (v) => (v === null || v === undefined ? "" : String(v))

/**
 * @param {{mode: "new"|"edit", editItem?: string}} options
 */
export function useItemWizard(options) {
	const steps = options.mode === "edit" ? EDIT_STEPS : [...STEPS]
	const step = ref(steps[0])
	const visited = ref(new Set([steps[0]]))
	const profiles = ref([])
	const profile = ref("")
	const defaults = ref(null)
	const form = reactive(blankForm(null))
	const busy = ref(false)
	const loadError = ref("")
	const issues = ref({ errors: [], warnings: [] })
	const serverPreview = ref(null)
	const result = ref(null)
	const autoCode = ref(true)

	// JSON round trip reads every field through the reactive proxy, so edits re-compute.
	const payload = computed(() => ({
		...JSON.parse(JSON.stringify(form)),
		pos_profile: profile.value,
	}))
	const normalized = computed(() => normalize(payload.value))
	const vatRate = computed(() => {
		const t = defaults.value?.tax_templates?.find(
			(x) => x.name === form.item_tax_template,
		)
		if (t) return Number(t.rate) || 0
		return Number(defaults.value?.profile?.vat_rate) || 0
	})
	const profileInclusive = computed(() =>
		defaults.value?.profile?.prices_include_vat ? 1 : 0,
	)
	const calc = computed(() =>
		unitPrices(normalized.value, vatRate.value, profileInclusive.value),
	)
	const entryUnit = computed(() => ENTRY_UNITS[form.stock_uom] || null)
	const stepIndex = computed(() => steps.indexOf(step.value))
	const knownUnits = computed(() => {
		const names = [form.stock_uom]
		if (entryUnit.value) names.push(entryUnit.value.uom)
		for (const u of form.buying_units) if (u.uom) names.push(u.uom)
		for (const u of form.selling_units) if (u.uom) names.push(u.uom)
		return [...new Set(names)]
	})

	function applyPayload(p) {
		const fresh = blankForm(defaults.value)
		Object.assign(form, fresh)
		if (!p) return
		for (const key of Object.keys(fresh)) {
			if (p[key] === undefined || p[key] === null) continue
			if (key === "buying_units")
				form.buying_units = p.buying_units.map((u) => ({
					uom: u.uom,
					size: asText(u.size),
					parent_uom: u.parent_uom || p.stock_uom || "",
				}))
			else if (key === "selling_units")
				form.selling_units = p.selling_units.map((u) =>
					blankUnit(u.uom, {
						size: asText(u.size ?? 1),
						size_uom: u.size_uom || p.stock_uom || "",
						priced: u.priced === 0 ? 0 : 1,
						price: asText(u.price),
						barcode: u.barcode || "",
						margin: u.margin ?? null,
						existing: u.existing ? 1 : 0,
					}),
				)
			else if (key === "opening_stock")
				form.opening_stock = { ...fresh.opening_stock, ...p.opening_stock }
			else if (["buying_price", "base_price", "margin_pct"].includes(key))
				form[key] = asText(p[key])
			else form[key] = p[key]
		}
		if (!form.item_tax_template)
			form.item_tax_template = defaults.value?.default_item_tax_template || ""
		if (form.sold_on_scale && !form.scale_rule)
			form.scale_rule = defaults.value?.scale_rules?.[0]?.name || ""
		autoCode.value = !form.item_code
	}

	async function loadProfiles() {
		profiles.value = (await call(`${API}.get_wizard_profiles`)) || []
		// Last profile used here, else the one the labels page used, else the first real one
		// (POS Next's own test profiles start with "_").
		const wanted = [
			localStorage.getItem("pos0001_wizard_profile"),
			localStorage.getItem("pos0001_label_profile"),
		]
		profile.value =
			wanted
				.map((n) => profiles.value.find((p) => p.name === n)?.name)
				.find(Boolean) ||
			profiles.value.find((p) => !p.name.startsWith("_"))?.name ||
			profiles.value[0]?.name ||
			""
	}

	async function loadDefaults(extra = {}) {
		if (!profile.value) return null
		localStorage.setItem("pos0001_wizard_profile", profile.value)
		const out = await call(`${API}.wizard_defaults`, {
			pos_profile: profile.value,
			...extra,
		})
		defaults.value = out
		return out
	}

	async function init() {
		busy.value = true
		loadError.value = ""
		try {
			await loadProfiles()
			if (!profile.value) {
				loadError.value = __("You may not create items for any POS Profile.")
				return
			}
			if (options.mode === "edit") {
				const out = await loadDefaults({ edit: options.editItem })
				applyPayload(out.payload)
			} else {
				await loadDefaults()
				applyPayload(null)
			}
		} catch (e) {
			loadError.value = errorText(e)
		} finally {
			busy.value = false
		}
	}

	async function changeProfile(name) {
		profile.value = name
		busy.value = true
		try {
			const keep = structuredClone(toRaw(form))
			await loadDefaults(
				options.mode === "edit" ? { edit: options.editItem } : {},
			)
			applyPayload(options.mode === "edit" ? defaults.value.payload : keep)
		} catch (e) {
			loadError.value = errorText(e)
		} finally {
			busy.value = false
		}
	}

	async function start(kind, value) {
		if (busy.value) return
		busy.value = true
		issues.value = { errors: [], warnings: [] }
		try {
			if (kind === "preset") {
				const out = await loadDefaults({ preset: value })
				applyPayload(out.payload)
			} else if (kind === "copy") {
				const out = await loadDefaults({ copy_from: value })
				applyPayload(out.payload)
			} else applyPayload(null)
			goTo("basics", true)
			await suggestCode()
		} catch (e) {
			issues.value = {
				errors: [{ code: "server", message: errorText(e) }],
				warnings: [],
			}
		} finally {
			busy.value = false
		}
	}

	async function suggestCode() {
		if (
			!autoCode.value ||
			defaults.value?.item_naming_by_series ||
			options.mode === "edit"
		)
			return
		try {
			const out = await call(`${API}.suggest_item_code`, {
				pos_profile: profile.value,
				item_group: form.item_group || null,
			})
			if (autoCode.value) form.item_code = out?.item_code || ""
		} catch {
			// The server suggests again on Create when the code is empty.
		}
	}

	function goTo(target, force = false) {
		if (!steps.includes(target)) return
		if (!force && !visited.value.has(target)) return
		step.value = target
		visited.value = new Set([...visited.value, target])
		issues.value = { errors: [], warnings: [] }
	}

	async function checkStep(name) {
		const local = payloadErrors(normalized.value, [name])
		if (options.mode === "edit" && name === "buying")
			return {
				errors: local.filter((e) => e.code !== "buying_is_stock_unit"),
				warnings: [],
			}
		if (local.length) return { errors: local, warnings: [] }
		if (!SERVER_STEPS.has(name)) return { errors: [], warnings: [] }
		const out = await call(`${API}.wizard_validate`, {
			payload: JSON.stringify(payload.value),
			steps: JSON.stringify([name]),
			item_code: options.mode === "edit" ? options.editItem : null,
		})
		return { errors: out?.errors || [], warnings: out?.warnings || [] }
	}

	async function next() {
		if (busy.value) return false
		busy.value = true
		try {
			const checked = await checkStep(step.value)
			issues.value = checked
			if (checked.errors.length) return false
			const target = steps[stepIndex.value + 1]
			if (target) goTo(target, true)
			if (target === "stock" && !form.opening_stock.uom)
				form.opening_stock.uom = calc.value.purchase_uom
			return true
		} catch (e) {
			issues.value = {
				errors: [{ code: "server", message: errorText(e) }],
				warnings: [],
			}
			return false
		} finally {
			busy.value = false
		}
	}

	function back() {
		const target = steps[stepIndex.value - 1]
		if (target) goTo(target, true)
	}

	let previewTimer = null
	function schedulePreview() {
		clearTimeout(previewTimer)
		previewTimer = setTimeout(async () => {
			const sent = JSON.stringify(payload.value)
			try {
				const out = await call(`${API}.wizard_preview`, { payload: sent })
				if (JSON.stringify(payload.value) === sent) serverPreview.value = out
			} catch {
				serverPreview.value = null
			}
		}, 400)
	}

	async function generateBarcode(unit) {
		const exclude = form.selling_units.map((u) => u.barcode).filter(Boolean)
		const out = await call(`${API}.generate_internal_barcode`, {
			pos_profile: profile.value,
			uom: unit.uom,
			exclude: JSON.stringify(exclude),
		})
		unit.barcode = out?.barcode || ""
	}

	async function submit() {
		busy.value = true
		issues.value = { errors: [], warnings: [] }
		try {
			for (const name of steps.filter((s) => s !== "start" && s !== "review")) {
				const checked = await checkStep(name)
				if (checked.errors.length) {
					goTo(name, true)
					issues.value = checked
					return null
				}
			}
			const out =
				options.mode === "edit"
					? await call(`${API}.wizard_update_packaging`, {
							item_code: options.editItem,
							payload: JSON.stringify(payload.value),
						})
					: await call(`${API}.wizard_create`, {
							payload: JSON.stringify(payload.value),
						})
			result.value = out
			return out
		} catch (e) {
			issues.value = {
				errors: [{ code: "server", message: errorText(e) }],
				warnings: [],
			}
			return null
		} finally {
			busy.value = false
		}
	}

	/** "Create another like this": same units and prices, new name, code and barcodes. */
	async function another() {
		const keep = structuredClone(toRaw(form))
		applyPayload({
			...keep,
			item_code: "",
			item_name: "",
			item_name_ar: "",
			image: "",
			scale_plu: "",
			selling_units: keep.selling_units.map((u) => ({ ...u, barcode: "" })),
		})
		result.value = null
		visited.value = new Set(["start", "basics"])
		goTo("basics", true)
		await loadDefaults()
		await suggestCode()
	}

	async function savePreset(name) {
		return call(`${API}.save_wizard_preset`, {
			pos_profile: profile.value,
			preset_name: name,
			payload: JSON.stringify(payload.value),
		})
	}

	async function searchItems(query) {
		return (
			(await call(`${API}.search_items`, {
				pos_profile: profile.value,
				query,
			})) || []
		)
	}

	async function importCsv(content) {
		return call(`${API}.import_wizard_csv`, {
			pos_profile: profile.value,
			content,
		})
	}

	async function csvTemplate() {
		return call(`${API}.wizard_csv_template`, { pos_profile: profile.value })
	}

	function addBuyingUnit() {
		const parent = form.buying_units.length
			? form.buying_units[form.buying_units.length - 1].uom
			: form.stock_uom
		form.buying_units.push({
			uom: "",
			size: "",
			parent_uom: parent || form.stock_uom,
		})
	}

	function addSellingUnit() {
		form.selling_units.push(blankUnit("", { size_uom: form.stock_uom }))
	}

	function setStockUom(uom) {
		const old = form.stock_uom
		form.stock_uom = uom
		for (const u of form.selling_units) {
			if (u.uom === old) u.uom = uom
			if (u.size_uom === old) u.size_uom = uom
		}
		for (const u of form.buying_units)
			if (u.parent_uom === old) u.parent_uom = uom
		if (!ENTRY_UNITS[uom]) form.sold_on_scale = 0
	}

	return {
		steps,
		step,
		visited,
		stepIndex,
		profiles,
		profile,
		defaults,
		form,
		busy,
		loadError,
		issues,
		serverPreview,
		result,
		autoCode,
		payload,
		normalized,
		calc,
		vatRate,
		entryUnit,
		knownUnits,
		init,
		changeProfile,
		start,
		suggestCode,
		goTo,
		next,
		back,
		schedulePreview,
		generateBarcode,
		submit,
		another,
		savePreset,
		searchItems,
		importCsv,
		csvTemplate,
		addBuyingUnit,
		addSellingUnit,
		setStockUom,
	}
}
