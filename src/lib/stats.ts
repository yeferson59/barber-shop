import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { appointment, barber, service, user } from "@/db/schema";
import { getOccupancy } from "./availability";
import { addDaysStr, atLocal, minutesOfDay, toDateStr, todayStr } from "./time";

export async function getStats(days: number) {
  const to = addDaysStr(todayStr(), 1); // incluye hoy
  const from = addDaysStr(to, -days);
  const start = atLocal(from);
  const end = atLocal(to);
  const inRange = and(
    gte(appointment.startsAt, start),
    lt(appointment.startsAt, end),
  );

  const [rows, newClients, occupancy] = await Promise.all([
    db
      .select({
        startsAt: appointment.startsAt,
        status: appointment.status,
        priceCents: appointment.priceCents,
        barberId: appointment.barberId,
        barberName: barber.name,
        serviceId: appointment.serviceId,
        serviceName: service.name,
      })
      .from(appointment)
      .innerJoin(barber, eq(barber.id, appointment.barberId))
      .innerJoin(service, eq(service.id, appointment.serviceId))
      .where(inRange),
    db
      .select({ n: sql<number>`count(*)` })
      .from(user)
      .where(
        and(
          eq(user.role, "user"),
          gte(user.createdAt, start),
          lt(user.createdAt, end),
        ),
      )
      .get(),
    getOccupancy(from, days),
  ]);

  const completed = rows.filter((r) => r.status === "completed");
  const revenue = completed.reduce((n, r) => n + r.priceCents, 0);
  // Las tasas se calculan solo sobre citas ya pasadas
  const past = rows.filter((r) => r.startsAt.getTime() < Date.now());
  const rate = (status: string) =>
    past.length
      ? past.filter((r) => r.status === status).length / past.length
      : 0;

  const daily = Array.from({ length: days }, (_, i) => {
    const date = addDaysStr(from, i);
    const list = rows.filter(
      (r) => r.status !== "cancelled" && toDateStr(r.startsAt) === date,
    );
    return {
      date,
      count: list.length,
      revenue: list
        .filter((r) => r.status === "completed")
        .reduce((n, r) => n + r.priceCents, 0),
    };
  });

  const byService = new Map<
    string,
    { name: string; count: number; revenue: number }
  >();
  for (const r of completed) {
    const s = byService.get(r.serviceId) ?? {
      name: r.serviceName,
      count: 0,
      revenue: 0,
    };
    s.count++;
    s.revenue += r.priceCents;
    byService.set(r.serviceId, s);
  }

  const barbers = occupancy.map((b) => {
    const mine = rows.filter((r) => r.barberId === b.barberId);
    const work = b.days.reduce((n, d) => n + d.workMin, 0);
    const busy = b.days.reduce((n, d) => n + d.busyMin, 0);
    return {
      name: b.name,
      completed: mine.filter((r) => r.status === "completed").length,
      revenue: mine
        .filter((r) => r.status === "completed")
        .reduce((n, r) => n + r.priceCents, 0),
      noShows: mine.filter((r) => r.status === "no_show").length,
      occupancy: work ? busy / work : 0,
    };
  });

  // Horas pico: citas no canceladas por hora de inicio
  const byHour = new Map<number, number>();
  for (const r of rows) {
    if (r.status === "cancelled") continue;
    const h = Math.floor(minutesOfDay(r.startsAt) / 60);
    byHour.set(h, (byHour.get(h) ?? 0) + 1);
  }

  return {
    from,
    to: addDaysStr(to, -1),
    kpis: {
      appointments: rows.filter((r) => r.status !== "cancelled").length,
      completed: completed.length,
      revenue,
      avgTicket: completed.length ? Math.round(revenue / completed.length) : 0,
      cancelRate: rate("cancelled"),
      noShowRate: rate("no_show"),
      newClients: newClients?.n ?? 0,
    },
    daily,
    services: [...byService.values()].sort((a, b) => b.count - a.count),
    barbers,
    hours: [...byHour.entries()]
      .sort(([a], [b]) => a - b)
      .map(([hour, count]) => ({ hour, count })),
  };
}
