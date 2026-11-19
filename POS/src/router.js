import { shiftState } from "@/composables/useShift";
import { userResource } from "@/data/user";
import { createRouter, createWebHistory } from "vue-router";
import { session } from "./data/session";

const routes = [
	{
		path: "/",
		name: "POSSale",
		component: () => import("@/pages/POSSale.vue"),
	},
	// pos_0001: barcode label printing page (desk page pos-labels shows it)
	{
		path: "/labels",
		name: "Labels",
		component: () => import("@/plus/pages/LabelsPage.vue"),
	},
	// pos_0001: Item Wizard (SPEC F13): new item, and edit packaging of an existing one
	{
		path: "/items/new",
		name: "ItemWizard",
		component: () => import("@/plus/pages/ItemWizardPage.vue"),
	},
	{
		path: "/items/edit",
		name: "ItemWizardEdit",
		component: () => import("@/plus/pages/ItemWizardPage.vue"),
	},
	{
		name: "Login",
		path: "/account/login",
		component: () => import("@/pages/Login.vue"),
	},
	// Catch-all route
	{
		path: "/:pathMatch(.*)*",
		redirect: "/",
	},
];

const router = createRouter({
	history: createWebHistory("/pos"),
	routes,
});

router.beforeEach((to, from, next) => {
	// Check authentication status (session.user is already set in main.js before app mount)
	const isLoggedIn = session.isLoggedIn;

	// Only log during development
	if (import.meta.env.DEV) {
		console.log(`[Router] ${to.name} (from: ${from.name || "initial"}), auth: ${isLoggedIn}`);
	}

	// Redirect logic
	if (to.name === "Login" && isLoggedIn) {
		next({ name: "POSSale" });
	} else if (to.name !== "Login" && !isLoggedIn) {
		next({ name: "Login" });
	} else {
		next();
	}
});

export default router;
