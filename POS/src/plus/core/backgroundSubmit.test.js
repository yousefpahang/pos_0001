import { describe, expect, it } from "vitest"
import {
	backgroundSubmitBlocker,
	canSubmitInBackground,
	invoiceLevelFields,
} from "./backgroundSubmit.js"

const cashSale = {
	targetDoctype: "Sales Invoice",
	grandTotal: 21,
	paidAmount: 50,
	payments: [{ mode_of_payment: "Cash", amount: 50 }],
}

describe("backgroundSubmitBlocker", () => {
	it("lets a fully paid online cash sale print at once", () => {
		expect(backgroundSubmitBlocker(cashSale)).toBeNull()
		expect(canSubmitInBackground(cashSale)).toBe(true)
	})

	it("accepts a split payment that covers the total", () => {
		const sale = {
			grandTotal: 100,
			payments: [
				{ mode_of_payment: "Cash", amount: 40 },
				{ mode_of_payment: "Card", amount: 60 },
			],
		}
		expect(backgroundSubmitBlocker(sale)).toBeNull()
	})

	it("tolerates sub-fils differences", () => {
		expect(
			backgroundSubmitBlocker({ grandTotal: 9.995, paidAmount: 9.99 }),
		).toBeNull()
	})

	it("keeps the waiting path for sales the server must check first", () => {
		expect(backgroundSubmitBlocker({ ...cashSale, enabled: false })).toBe(
			"disabled",
		)
		expect(backgroundSubmitBlocker({ ...cashSale, isOffline: true })).toBe(
			"offline",
		)
		expect(
			backgroundSubmitBlocker({ ...cashSale, targetDoctype: "Sales Order" }),
		).toBe("not_invoice")
		expect(backgroundSubmitBlocker({ ...cashSale, isCreditSale: true })).toBe(
			"credit_sale",
		)
		expect(
			backgroundSubmitBlocker({ ...cashSale, receivableAccount: "Debtors" }),
		).toBe("receivable_account")
		expect(
			backgroundSubmitBlocker({
				...cashSale,
				payments: [{ amount: 50, is_customer_credit: true }],
			}),
		).toBe("customer_credit")
		expect(
			backgroundSubmitBlocker({
				...cashSale,
				payments: [{ amount: 50, is_wallet_payment: true }],
			}),
		).toBe("wallet")
		expect(
			backgroundSubmitBlocker({ ...cashSale, paidAmount: 10, payments: [] }),
		).toBe("not_fully_paid")
		expect(backgroundSubmitBlocker(null)).toBe("no_sale")
	})

	it("sums the payments when no paid amount is given", () => {
		expect(
			backgroundSubmitBlocker({
				grandTotal: 30,
				payments: [{ amount: 10 }, { amount: 10 }],
			}),
		).toBe("not_fully_paid")
	})
})

describe("invoiceLevelFields", () => {
	it("returns the additional discount and coupon only when set", () => {
		expect(
			invoiceLevelFields({ additionalDiscount: 0, couponCode: null }),
		).toEqual({})
		expect(invoiceLevelFields({})).toEqual({})
		expect(
			invoiceLevelFields({ additionalDiscount: 5, couponCode: "SAVE5" }),
		).toEqual({ discount_amount: 5, coupon_code: "SAVE5" })
	})
})
