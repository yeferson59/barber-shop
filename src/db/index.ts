import { createClient, type ResultSet } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { env } from "@/config/env";
import * as schema from "./schema";

const url = env.DATABASE_URL || "file:./data/barber.db";

// En Vercel cada invocación corre en una instancia efímera: un fichero local
// se pierde y no se comparte entre instancias.
if (env.VERCEL && url.startsWith("file:"))
  throw new Error(
    "En Vercel DATABASE_URL debe apuntar a una BD remota (libsql://… de Turso), no a un fichero local.",
  );

const client = createClient({
  url,
  authToken: env.DATABASE_AUTH_TOKEN || undefined,
  // Solo afecta a `file:`: espera al bloqueo de escritura en vez de fallar al instante.
  timeout: 5000,
});

export const db = drizzle(client, { schema });

/** `db` o una transacción: para funciones que deben poder leer dentro de una. */
export type Executor = BaseSQLiteDatabase<"async", ResultSet, typeof schema>;

// Transacción de escritura (BEGIN IMMEDIATE): la BD bloquea a cualquier otro
// escritor, también de otras instancias del servidor. Dentro de un mismo
// proceso, además, se encolan: con `file:` el cliente es síncrono y esperar el
// bloqueo congelaría el proceso que lo tiene.
let queue: Promise<unknown> = Promise.resolve();
export function writeTx<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
  const run = queue.then(
    () => db.transaction(fn),
    () => db.transaction(fn),
  );
  queue = run.catch(() => {});
  return run;
}
