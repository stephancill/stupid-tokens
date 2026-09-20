import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ADMIN_TOKEN: "test-admin-token",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000 },
});
