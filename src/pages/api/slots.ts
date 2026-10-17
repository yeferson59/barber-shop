import type { APIRoute } from "astro";
import { getAvailableSlots } from "@/lib/availability";
import { isDateStr } from "@/lib/time";

export const GET: APIRoute = async ({ url }) => {
  const serviceId = url.searchParams.get("serviceId");
  const barberId = url.searchParams.get("barberId") || "any";
  const date = url.searchParams.get("date") ?? "";
  const exclude = url.searchParams.get("exclude") || undefined;
  if (!serviceId || !isDateStr(date))
    return Response.json({ error: "Parámetros inválidos" }, { status: 400 });

  const slots = await getAvailableSlots({
    serviceId,
    barberId,
    date,
    excludeAppointmentId: exclude,
  });
  return Response.json({ slots }, { headers: { "Cache-Control": "no-store" } });
};
