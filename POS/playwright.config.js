// Playwright e2e config (pos_0001, Phase 1). Runs against the dev site, see
// docs/ARCHITECTURE_NOTES.md. Override with POS_E2E_BASE_URL.
import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
	testDir: "./e2e",
	timeout: 120_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		baseURL: process.env.POS_E2E_BASE_URL || "http://localhost:8001",
		trace: "retain-on-failure",
		viewport: { width: 1280, height: 800 },
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
