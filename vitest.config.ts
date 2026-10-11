import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd — the runtime they are about — against the same
// wrangler configuration the worker deploys with. Handlers are called directly
// with a hand-built environment, so no test needs real credentials.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});
