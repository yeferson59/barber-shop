import { sql } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";

// Columnas comunes a todas las tablas.

export const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

export const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

export const createdAt = () =>
  timestamp("created_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`);
