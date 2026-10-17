import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL || "file:./data/barber.db";

export default defineConfig({
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dialect: url.startsWith("file:") ? "sqlite" : "turso",
  dbCredentials: { url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined },
});
