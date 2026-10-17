import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { barber } from "@/db/schema";

/** Barberos que el usuario actual puede gestionar y el seleccionado (?barbero=). */
export async function scopedBarbers(locals: App.Locals, url: URL) {
  const all = await db
    .select()
    .from(barber)
    .where(eq(barber.active, true))
    .orderBy(asc(barber.name));
  const barbers =
    locals.user?.role === "admin"
      ? all
      : all.filter((b) => b.id === locals.barberId);
  const wanted = url.searchParams.get("barbero");
  const selected = barbers.find((b) => b.id === wanted) ?? barbers[0] ?? null;
  return { barbers, selected };
}
