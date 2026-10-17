import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { barber, barberService, service, workingHours } from "../db/schema";
import type {
  WizardBarber,
  WizardDay,
  WizardService,
} from "@/components/islands/BookingWizard";
import { getSettings } from "./settings";
import {
  addDaysStr,
  fmtDateStr,
  formatPrice,
  todayStr,
  ucfirst,
  weekdayOf,
} from "./time";

/** Datos que necesita el asistente de reservas. */
export async function getBookingCatalog() {
  const [settings, services, barbers, links, hours] = await Promise.all([
    getSettings(),
    db
      .select()
      .from(service)
      .where(eq(service.active, true))
      .orderBy(asc(service.name)),
    db
      .select()
      .from(barber)
      .where(eq(barber.active, true))
      .orderBy(asc(barber.name)),
    db.select().from(barberService),
    db.selectDistinct({ weekday: workingHours.weekday }).from(workingHours),
  ]);
  const openWeekdays = new Set(hours.map((h) => h.weekday));

  const today = todayStr();
  const days: WizardDay[] = Array.from(
    { length: settings.maxDaysAhead + 1 },
    (_, i) => {
      const date = addDaysStr(today, i);
      return {
        date,
        weekday: i === 0 ? "Hoy" : ucfirst(fmtDateStr(date, "EEE")),
        day: fmtDateStr(date, "d"),
        month: fmtDateStr(date, "MMM"),
        long: fmtDateStr(date, "EEEE d 'de' MMMM"),
        closed: !openWeekdays.has(weekdayOf(date)),
      };
    },
  );

  return {
    services: services.map<WizardService>((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      durationMin: s.durationMin,
      price: formatPrice(s.priceCents),
    })),
    barbers: barbers.map<WizardBarber>((b) => ({
      id: b.id,
      name: b.name,
      photoUrl: b.photoUrl,
      serviceIds: links
        .filter((l) => l.barberId === b.id)
        .map((l) => l.serviceId),
    })),
    days,
  };
}
