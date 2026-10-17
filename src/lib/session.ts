import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { db } from "@/db";
import { barber } from "@/db/schema";

/** Carga usuario, sesión y barbero vinculado en `locals`. */
export async function loadSession(locals: App.Locals, headers: Headers) {
  const result = await auth.api.getSession({ headers });
  locals.user = result?.user ?? null;
  locals.session = result?.session ?? null;
  locals.barberId = null;

  if (locals.user?.role === "barber") {
    const row = await db.query.barber.findFirst({
      where: eq(barber.userId, locals.user.id),
    });
    locals.barberId = row?.id ?? null;
  }
  return locals;
}
