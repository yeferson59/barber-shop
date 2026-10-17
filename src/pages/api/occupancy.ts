import type { APIRoute } from "astro";
import { getOccupancy } from "@/lib/availability";
import { isDateStr, todayStr } from "@/lib/time";

export const GET: APIRoute = async ({ url }) => {
  const from = url.searchParams.get("from") ?? todayStr();
  // Entero entre 1 y 14; "abc" o vacío caen al valor por defecto (antes NaN → 500)
  const rawDays = Number.parseInt(url.searchParams.get("days") ?? "", 10);
  const days = Number.isNaN(rawDays) ? 7 : Math.min(14, Math.max(1, rawDays));
  if (!isDateStr(from))
    return Response.json({ error: "Fecha inválida" }, { status: 400 });

  const barbers = await getOccupancy(from, days);
  return Response.json(
    { barbers },
    { headers: { "Cache-Control": "no-store" } },
  );
};
