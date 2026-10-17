import { and, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { db } from "@/db";
import {
  appointment,
  barber,
  barberService,
  service,
  timeOff,
  workingHours,
} from "@/db/schema";
import { getSettings, type ShopSettings } from "./settings";
import {
  addDaysStr,
  atLocal,
  dayRange,
  minutesOfDay,
  minutesToHHMM,
  toDateStr,
  todayStr,
  weekdayOf,
  type DateStr,
} from "./time";

const MIN = 60_000;

interface Interval {
  start: number; // epoch ms
  end: number;
}

const overlaps = (a: Interval, b: Interval) =>
  a.start < b.end && b.start < a.end;

/** Todo lo que bloquea la agenda de los barberos en un rango de tiempo. */
async function loadBusy(
  barberIds: string[],
  range: { start: Date; end: Date },
  excludeAppointmentId?: string,
) {
  if (barberIds.length === 0) return { appts: [], offs: [] };
  const [appts, offs] = await Promise.all([
    db
      .select({
        id: appointment.id,
        barberId: appointment.barberId,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
      })
      .from(appointment)
      .where(
        and(
          inArray(appointment.barberId, barberIds),
          ne(appointment.status, "cancelled"),
          lt(appointment.startsAt, range.end),
          gt(appointment.endsAt, range.start),
          excludeAppointmentId
            ? ne(appointment.id, excludeAppointmentId)
            : undefined,
        ),
      ),
    db
      .select()
      .from(timeOff)
      .where(
        and(
          inArray(timeOff.barberId, barberIds),
          lt(timeOff.startsAt, range.end),
          gt(timeOff.endsAt, range.start),
        ),
      ),
  ]);
  return { appts, offs };
}

async function loadHours(barberIds: string[], weekday: number) {
  if (barberIds.length === 0) return [];
  return db
    .select()
    .from(workingHours)
    .where(
      and(
        inArray(workingHours.barberId, barberIds),
        eq(workingHours.weekday, weekday),
      ),
    );
}

/** Barberos activos que realizan el servicio. */
export async function barbersForService(serviceId: string) {
  return db
    .select({ id: barber.id, name: barber.name, photoUrl: barber.photoUrl })
    .from(barber)
    .innerJoin(barberService, eq(barberService.barberId, barber.id))
    .where(
      and(eq(barberService.serviceId, serviceId), eq(barber.active, true)),
    );
}

export function bookingWindow(settings: ShopSettings) {
  const today = todayStr();
  return {
    firstDay: today,
    lastDay: addDaysStr(today, settings.maxDaysAhead),
    earliestStart: Date.now() + settings.minLeadMin * MIN,
  };
}

export interface SlotOption {
  /** HH:mm local */
  time: string;
  startsAt: string; // ISO
  barberIds: string[];
}

export async function getAvailableSlots(opts: {
  serviceId: string;
  barberId: string | "any";
  date: DateStr;
  excludeAppointmentId?: string;
}): Promise<SlotOption[]> {
  const settings = await getSettings();
  const window = bookingWindow(settings);
  if (opts.date < window.firstDay || opts.date > window.lastDay) return [];

  const svc = await db.query.service.findFirst({
    where: and(eq(service.id, opts.serviceId), eq(service.active, true)),
  });
  if (!svc) return [];

  const candidates = (await barbersForService(svc.id))
    .map((b) => b.id)
    .filter((id) => opts.barberId === "any" || id === opts.barberId);

  const [hours, busy] = await Promise.all([
    loadHours(candidates, weekdayOf(opts.date)),
    loadBusy(candidates, dayRange(opts.date), opts.excludeAppointmentId),
  ]);

  const byTime = new Map<number, SlotOption>();
  const durMs = svc.durationMin * MIN;

  for (const block of hours) {
    const blocked: Interval[] = [
      ...busy.appts.filter((a) => a.barberId === block.barberId),
      ...busy.offs.filter((o) => o.barberId === block.barberId),
    ].map((x) => ({ start: x.startsAt.getTime(), end: x.endsAt.getTime() }));

    for (
      let m = block.startMin;
      m + svc.durationMin <= block.endMin;
      m += settings.slotStepMin
    ) {
      const start = atLocal(opts.date, m).getTime();
      if (start < window.earliestStart) continue;
      const slot = { start, end: start + durMs };
      if (blocked.some((b) => overlaps(slot, b))) continue;

      const existing = byTime.get(m);
      if (existing) existing.barberIds.push(block.barberId);
      else
        byTime.set(m, {
          time: minutesToHHMM(m),
          startsAt: new Date(start).toISOString(),
          barberIds: [block.barberId],
        });
    }
  }

  return [...byTime.entries()].sort(([a], [b]) => a - b).map(([, s]) => s);
}

/** ¿Puede el barbero atender [start, end)? Respeta horario, citas y bloqueos. */
export async function isBarberFree(
  barberId: string,
  start: Date,
  end: Date,
  excludeAppointmentId?: string,
): Promise<boolean> {
  const date = toDateStr(start);
  const startMin = minutesOfDay(start);
  const endMin = startMin + Math.round((end.getTime() - start.getTime()) / MIN);

  const hours = await loadHours([barberId], weekdayOf(date));
  const insideHours = hours.some(
    (h) => h.startMin <= startMin && endMin <= h.endMin,
  );
  if (!insideHours) return false;

  const busy = await loadBusy([barberId], { start, end }, excludeAppointmentId);
  return busy.appts.length === 0 && busy.offs.length === 0;
}

// ---------------------------------------------------------------------------
// Ocupación (vista pública y panel)
// ---------------------------------------------------------------------------

export interface DayOccupancy {
  date: DateStr;
  /** Minutos laborables (descontando bloqueos). */
  workMin: number;
  busyMin: number;
  /** 0..1 */
  ratio: number;
  /** Bloques en minutos desde medianoche local. */
  blocks: { start: number; end: number; kind: "busy" | "off" }[];
  hours: { start: number; end: number }[];
}

export interface BarberOccupancy {
  barberId: string;
  name: string;
  days: DayOccupancy[];
}

function clipMinutes(iv: Interval, dayStart: number, dayEnd: number) {
  const s = Math.max(iv.start, dayStart);
  const e = Math.min(iv.end, dayEnd);
  if (e <= s) return null;
  return {
    start: Math.round((s - dayStart) / MIN),
    end: Math.round((e - dayStart) / MIN),
  };
}

function overlapMinutes(
  a: { start: number; end: number },
  b: { start: number; end: number },
) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export async function getOccupancy(from: DateStr, days: number) {
  const barbers = await db
    .select({ id: barber.id, name: barber.name })
    .from(barber)
    .where(eq(barber.active, true));
  const ids = barbers.map((b) => b.id);
  const dates = Array.from({ length: days }, (_, i) => addDaysStr(from, i));

  const range = { start: atLocal(from), end: atLocal(addDaysStr(from, days)) };
  const [allHours, busy] = await Promise.all([
    ids.length
      ? db
          .select()
          .from(workingHours)
          .where(inArray(workingHours.barberId, ids))
      : [],
    loadBusy(ids, range),
  ]);

  return barbers.map<BarberOccupancy>((b) => ({
    barberId: b.id,
    name: b.name,
    days: dates.map((date) => {
      const { start, end } = dayRange(date);
      const ds = start.getTime();
      const de = end.getTime();
      const hours = allHours
        .filter((h) => h.barberId === b.id && h.weekday === weekdayOf(date))
        .map((h) => ({ start: h.startMin, end: h.endMin }))
        .sort((x, y) => x.start - y.start);

      const toBlock = (
        x: { startsAt: Date; endsAt: Date },
        kind: "busy" | "off",
      ) => {
        const c = clipMinutes(
          { start: x.startsAt.getTime(), end: x.endsAt.getTime() },
          ds,
          de,
        );
        return c ? { ...c, kind } : null;
      };
      const offs = busy.offs
        .filter((o) => o.barberId === b.id)
        .map((o) => toBlock(o, "off"))
        .filter((x) => x !== null);
      const appts = busy.appts
        .filter((a) => a.barberId === b.id)
        .map((a) => toBlock(a, "busy"))
        .filter((x) => x !== null);

      const totalWork = hours.reduce((n, h) => n + (h.end - h.start), 0);
      const offMin = hours.reduce(
        (n, h) => n + offs.reduce((k, o) => k + overlapMinutes(h, o), 0),
        0,
      );
      const busyMin = hours.reduce(
        (n, h) => n + appts.reduce((k, a) => k + overlapMinutes(h, a), 0),
        0,
      );
      const workMin = Math.max(0, totalWork - offMin);
      return {
        date,
        workMin,
        busyMin,
        ratio: workMin ? Math.min(1, busyMin / workMin) : 1,
        blocks: [...offs, ...appts].sort((x, y) => x.start - y.start),
        hours,
      };
    }),
  }));
}
