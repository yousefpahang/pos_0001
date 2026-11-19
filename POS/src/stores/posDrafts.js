// pos_0001 (SPEC F7, DECISIONS.md item 6): held carts are server drafts when online and local
// copies while offline. This store keeps POS Next's API and delegates to
// plus/heldCarts/heldCartStore.js (see docs/UPSTREAM_PATCHES.md).
import { asLegacyDraft } from "@/plus/core/heldCarts";
import { usePlusHeldCartStore } from "@/plus/heldCarts/heldCartStore";
import { useToast } from "@/composables/useToast";
import { defineStore } from "pinia";
import { computed } from "vue";

export const usePOSDraftsStore = defineStore("posDrafts", () => {
	// Use custom toast
	const { showSuccess, showError, showWarning } = useToast();
	const held = usePlusHeldCartStore();

	// State
	const draftsCount = computed(() => held.count);
	const drafts = computed(() => held.entries.map(asLegacyDraft));

	// Actions
	async function updateDraftsCount() {
		held.start();
		await held.refresh();
	}

	async function loadDrafts() {
		held.start();
		await held.refresh();
	}

	/**
	 * Hold the cart. `options`: { note, salesTeam, invoice } (pos_0001).
	 * The 5th argument (draft id) is kept for POS Next callers; a resumed cart is already
	 * claimed, so every hold creates a new held cart.
	 */
	async function saveDraftInvoice(
		invoiceItems,
		customer,
		posProfile,
		appliedOffers = [],
		_draftId = null,
		options = {}
	) {
		if (invoiceItems.length === 0) {
			showWarning(__("Cannot save an empty cart as draft"));
			return null;
		}

		try {
			const result = await held.hold({
				items: invoiceItems,
				customer,
				appliedOffers,
				salesTeam: options.salesTeam || [],
				invoice: options.invoice || { pos_profile: posProfile, items: [] },
				note: options.note || null,
			});
			if (result.stored === "server") {
				showSuccess(__("Cart held. Any till of this POS Profile can resume it."));
			} else if (result.error) {
				showWarning(
					__("Cart held on this till only. The server refused it: {0}", [result.error])
				);
			} else {
				showSuccess(__("Cart held on this till. It is uploaded when the network is back."));
			}
			return { draft_id: result.holdId, ...result };
		} catch (error) {
			console.error("Error saving draft:", error);
			showError(__("Failed to save draft"));
			return null;
		}
	}

	async function loadDraft(draft) {
		try {
			const cart = await held.resume(draft);
			showSuccess(__("Held cart resumed"));
			return cart;
		} catch (error) {
			console.error("Error loading draft:", error);
			showError(error?.message || __("Failed to load draft"));
			held.refresh();
			throw error;
		}
	}

	async function deleteDraftById(draftId) {
		try {
			const removed = await held.remove(draftId);
			if (removed) showSuccess(__("Draft deleted successfully"));
		} catch (error) {
			console.error("Error deleting draft:", error);
			showError(error?.message || __("Failed to delete draft"));
		}
	}

	return {
		// State
		draftsCount,
		drafts,

		// Actions
		updateDraftsCount,
		loadDrafts,
		saveDraftInvoice,
		loadDraft,
		deleteDraft: deleteDraftById,
	};
});
