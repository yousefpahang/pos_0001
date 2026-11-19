// Playwright config for the Phase 6 benchmark (docs/PERFORMANCE.md). Same site as the e2e
// tests; one worker, no retries, long timeout. Run: yarn perf
import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
	testDir: "./perf",
	timeout: 30 * 60_000,
	expect: { timeout: 15_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		baseURL: process.env.POS_E2E_BASE_URL || "http://localhost:8001",
		trace: "off",
		actionTimeout: 30_000,
		screenshot: "only-on-failure",
		viewport: { width: 1280, height: 800 },
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
})
