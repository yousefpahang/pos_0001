// Vitest config kept apart from vite.config.js so unit tests do not load the PWA and
// build plugins. Added by pos_0001 (Phase 1).
import path from "node:path"
import { fileURLToPath } from "node:url"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vitest/config"

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	plugins: [vue()],
	resolve: {
		alias: { "@": path.resolve(root, "src") },
	},
	test: {
		include: ["src/**/*.{test,spec}.js"],
		exclude: ["node_modules/**", "e2e/**"],
		environment: "node",
	},
})
