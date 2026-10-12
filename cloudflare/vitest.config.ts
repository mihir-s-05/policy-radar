import { cloudflareTest,readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins:[cloudflareTest(async()=>({main:"./src/index.ts",miniflare:{compatibilityDate:"2026-10-11",compatibilityFlags:["nodejs_compat"],d1Databases:["DB"],bindings:{TEST_MIGRATIONS:await readD1Migrations("./migrations"),GOV_API_KEY:"test-government-key"}}}))],
  test:{include:["test/**/*.test.ts"],setupFiles:["./test/setup.ts"]},
});
