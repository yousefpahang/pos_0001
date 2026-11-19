// Copyright (c) 2026, pos_0001 contributors
// License: AGPL-3.0. See license.txt
//
// Pay -> receipt without waiting for the server (DECISIONS.md item 13, SPEC section 6).
// An online sale that qualifies is saved in POS Next's offline queue, printed from the local
// invoice at once, and sent to the server by the queue in the background (the same path as
// offline sales, with the same offline_id duplicate protection).
// No Vue imports: runs in the browser and Vitest.

/** Amounts below this count as "fully paid" (AED has 2 decimals). */
export const PAID_TOLERANCE = 0.005

/**
 * @typedef {Object} SaleForSubmit
 * @property {boolean} [enabled]          feature switch (default true)
 * @property {boolean} [isOffline]        till is offline (the queue is used anyway)
 * @property {string} [targetDoctype]     "Sales Invoice" or "Sales Order"
 * @property {boolean} [isCreditSale]     credit sale (needs POS Next's credit-limit checks)
 * @property {string|null} [receivableAccount]  "pay on receivable account"
 * @property {number} [grandTotal]
 * @property {number} [paidAmount]
 * @property {Array<{is_customer_credit?: boolean, is_wallet_payment?: boolean, amount?: number}>} [payments]
 */

/**
 * Why an online sale must go through POS Next's normal (waiting) submit, or null when it may be
 * printed at once and submitted in the background.
 *
 * Only plain, fully paid Sales Invoices qualify. Sales Orders, credit and partly paid sales,
 * receivable-account sales and customer-credit or wallet payments keep the normal path: the
 * server checks credit limits and balances there, and the cashier must see a refusal before
 * the customer leaves with a receipt.
 * @param {SaleForSubmit} sale
 * @returns {string|null} reason code, or null when the sale qualifies
 */
export function backgroundSubmitBlocker(sale) {
	if (!sale || typeof sale !== "object") return "no_sale"
	if (sale.enabled === false) return "disabled"
	if (sale.isOffline) return "offline"
	if ((sale.targetDoctype || "Sales Invoice") !== "Sales Invoice")
		return "not_invoice"
	if (sale.isCreditSale) return "credit_sale"
	if (sale.receivableAccount) return "receivable_account"
	const payments = Array.isArray(sale.payments) ? sale.payments : []
	if (payments.some((p) => p?.is_customer_credit)) return "customer_credit"
	if (payments.some((p) => p?.is_wallet_payment)) return "wallet"
	const total = Number(sale.grandTotal) || 0
	const paid = Number(sale.paidAmount)
	const paidAmount = Number.isFinite(paid)
		? paid
		: payments.reduce((sum, p) => sum + (Number(p?.amount) || 0), 0)
	if (total - paidAmount > PAID_TOLERANCE) return "not_fully_paid"
	return null
}

/**
 * True when an online sale may print at once and be submitted in the background.
 * @param {SaleForSubmit} sale
 * @returns {boolean}
 */
export function canSubmitInBackground(sale) {
	return backgroundSubmitBlocker(sale) === null
}

/**
 * Invoice-level fields POS Next's online submit sends but its offline queue payload left out.
 * Without them the server would compute a different total than the receipt shows.
 * Only set values are returned, so offline payloads without a discount stay unchanged.
 * @param {{additionalDiscount?: number, couponCode?: string|null}} cart
 * @returns {{discount_amount?: number, coupon_code?: string}}
 */
export function invoiceLevelFields(cart) {
	/** @type {{discount_amount?: number, coupon_code?: string}} */
	const out = {}
	const discount = Number(cart?.additionalDiscount) || 0
	if (discount > 0) out.discount_amount = discount
	if (cart?.couponCode) out.coupon_code = String(cart.couponCode)
	return out
}
