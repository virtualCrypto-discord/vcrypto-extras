import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd — the runtime they are about — against the same
// wrangler configuration the worker deploys with. Handlers are called directly
// with a hand-built environment, so no test needs real credentials.
//
// The migrations are read here and handed to the tests as a binding; the setup
// file applies them to each test's own copy of the database.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
