import { createServer } from "node:net";

import { defineConfig, devices } from "@playwright/test";

// Browser acceptance runs against the production bundle built with the GitHub Pages base path
// and served statically by `vite preview`; there is no dev server and no backend involved.
// The preview port is a free one chosen once by the runner process (or E2E_PORT when set) and
// handed to workers through the environment, so a busy 4173 (e.g. `bun run preview`) is no issue.
const PORT = Number(process.env.E2E_PORT ?? (await findFreePort()));
process.env.E2E_PORT = String(PORT);
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

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("Could not allocate a free port for vite preview."));
        }
      });
    });
  });
}
