import { defineConfig, devices } from "@playwright/test";

// Browser acceptance runs against the production bundle built with the GitHub Pages base path
// and served statically by `vite preview`; there is no dev server and no backend involved.
const PORT = 4173;
const BASE_PATH = "/document-search/";

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.e2e\.ts$/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bunx vite build --base=${BASE_PATH} && bunx vite preview --base=${BASE_PATH} --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}${BASE_PATH}`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
