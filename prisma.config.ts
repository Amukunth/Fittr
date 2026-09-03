// Mirrors FittrLanding/waitlist-app/prisma.config.ts: migrations run over
// the direct/session-mode connection, never the transaction-mode pooler.
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// quiet: true suppresses dotenv's stdout logging, which (as of 17.4.2)
// includes unsolicited third-party ad "tips" printed on every load.
loadEnv({ path: "prisma/.env", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DIRECT_URL"] ?? process.env["DATABASE_URL"],
  },
});
