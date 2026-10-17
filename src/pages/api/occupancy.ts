import type { APIRoute } from "astro";
import { getOccupancy } from "@/lib/availability";
import { isDateStr, todayStr } from "@/lib/time";

export const GET: APIRoute = async ({ url }) => {
  const from = url.searchParams.get("from") ?? todayStr();
  const days = Math.min(
    14,
    Math.max(1, Number(url.searchParams.get("days") ?? 7)),
  );
  if (!isDateStr(from))
    return Response.json({ error: "Fecha inválida" }, { status: 400 });

  const barbers = await getOccupancy(from, days);
  return Response.json(
    { barbers },
    { headers: { "Cache-Control": "no-store" } },
  );
};
