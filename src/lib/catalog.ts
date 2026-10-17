import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { barber, barberService, service, workingHours } from "@/db/schema";
import { getSettings } from "./settings";
import {
  addDaysStr,
  fmtDateStr,
  formatPrice,
  todayStr,
  ucfirst,
  weekdayOf,
} from "./time";

// Forma de los datos que recibe el asistente de reservas (BookingWizard).

export interface WizardService {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  price: string;
}

export interface WizardBarber {
  id: string;
  name: string;
  photoUrl: string | null;
  serviceIds: string[];
}

export interface WizardDay {
  date: string;
  weekday: string;
  day: string;
  month: string;
  /** "viernes 16 de octubre" */
  long: string;
  /** Ningún barbero trabaja ese día de la semana */
  closed: boolean;
}

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
    // Solo cuentan los horarios de barberos activos
    db
      .selectDistinct({ weekday: workingHours.weekday })
      .from(workingHours)
      .innerJoin(barber, eq(barber.id, workingHours.barberId))
      .where(eq(barber.active, true)),
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
