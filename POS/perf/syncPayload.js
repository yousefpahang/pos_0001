// pos_0001 Phase 6: queued demo invoice used by the sync benchmarks (docs/PERFORMANCE.md).
// One walk-in cash sale of one demo item, as the browser queue stores it.

export const PERF_PROFILE = "Main Till"

/**
 * @param {string} offlineId
 * @param {number} n  picks the item (ITM-01000 .. ITM-05999), so stock rows differ
 */
export function syncInvoice(offlineId, n) {
	const item = `ITM-${String(1000 + (n % 5000)).padStart(5, "0")}`
	return {
		doctype: "Sales Invoice",
		is_pos: 1,
		update_stock: 1,
		pos_profile: PERF_PROFILE,
		company: "Demo Trading LLC",
		customer: "Walk-in Customer",
		currency: "AED",
		selling_price_list: "Standard Selling",
		set_warehouse: "Stores - DTL",
		taxes_and_charges: "UAE VAT 5% - DTL",
		items: [
			{
				item_code: item,
				qty: 1,
				rate: 20,
				uom: "Nos",
				warehouse: "Stores - DTL",
			},
		],
		payments: [{ mode_of_payment: "Cash", amount: 21 }],
		grand_total: 21,
		offline_id: offlineId,
	}
}
