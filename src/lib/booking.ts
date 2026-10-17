import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  appointment,
  barber,
  barberService,
  service,
  type AppointmentStatus,
} from "@/db/schema";
import { bookingWindow, isBarberFree } from "./availability";
import { getSettings } from "./settings";
import { dayRange, toDateStr } from "./time";

export class BookingError extends Error {}

// Las escrituras de reservas pasan por esta cola: comprobar disponibilidad e
// insertar ocurren sin que otra reserva se cuele en medio (evita doble reserva).
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function loadService(serviceId: string) {
  const svc = await db.query.service.findFirst({
    where: and(eq(service.id, serviceId), eq(service.active, true)),
  });
  if (!svc)
    throw new BookingError("El servicio no existe o no está disponible.");
  return svc;
}

/** Barberos activos que hacen el servicio, ordenados por menos citas ese día. */
async function rankBarbers(serviceId: string, startsAt: Date) {
  const { start, end } = dayRange(toDateStr(startsAt));
  const rows = await db
    .select({
      id: barber.id,
      load: sql<number>`(
        select count(*) from ${appointment}
        where ${appointment.barberId} = ${barber.id}
          and ${appointment.status} != 'cancelled'
          and ${appointment.startsAt} >= ${start.getTime()}
          and ${appointment.startsAt} < ${end.getTime()}
      )`,
    })
    .from(barber)
    .innerJoin(barberService, eq(barberService.barberId, barber.id))
    .where(
      and(eq(barberService.serviceId, serviceId), eq(barber.active, true)),
    );
  return rows.sort((a, b) => a.load - b.load).map((r) => r.id);
}

export async function createAppointment(input: {
  clientId: string;
  serviceId: string;
  barberId: string | "any";
  startsAt: Date;
  notes?: string;
  /** Las citas creadas desde el panel ignoran antelación mínima y ventana. */
  fromStaff?: boolean;
}) {
  const settings = await getSettings();
  const svc = await loadService(input.serviceId);
  const startsAt = input.startsAt;
  const endsAt = new Date(startsAt.getTime() + svc.durationMin * 60_000);

  if (!input.fromStaff) {
    const w = bookingWindow(settings);
    if (startsAt.getTime() < w.earliestStart)
      throw new BookingError(
        `Las citas se reservan con al menos ${settings.minLeadMin} minutos de antelación.`,
      );
    if (toDateStr(startsAt) > w.lastDay)
      throw new BookingError(
        `Solo se puede reservar con ${settings.maxDaysAhead} días de antelación.`,
      );
  }

  if (await clientHasOverlap(input.clientId, startsAt, endsAt))
    throw new BookingError("Ya tienes una cita en ese horario.");

  return exclusive(async () => {
    const candidates =
      input.barberId === "any"
        ? await rankBarbers(svc.id, startsAt)
        : (await rankBarbers(svc.id, startsAt)).filter(
            (id) => id === input.barberId,
          );
    if (candidates.length === 0)
      throw new BookingError("Ese barbero no realiza este servicio.");

    for (const barberId of candidates) {
      if (await isBarberFree(barberId, startsAt, endsAt)) {
        const [created] = await db
          .insert(appointment)
          .values({
            clientId: input.clientId,
            barberId,
            serviceId: svc.id,
            startsAt,
            endsAt,
            priceCents: svc.priceCents,
            notes: input.notes || null,
          })
          .returning();
        return created;
      }
    }
    throw new BookingError(
      "Ese horario ya no está disponible. Por favor elige otro.",
    );
  });
}

export async function getAppointment(id: string) {
  return db.query.appointment.findFirst({
    where: eq(appointment.id, id),
    with: { service: true, barber: true, client: true },
  });
}

/** El cliente solo puede cancelar/reprogramar sus citas futuras y antes del límite. */
async function assertClientCanChange(id: string, clientId: string) {
  const appt = await getAppointment(id);
  if (!appt || appt.clientId !== clientId)
    throw new BookingError("Cita no encontrada.");
  if (appt.status !== "confirmed")
    throw new BookingError("Esta cita ya no se puede modificar.");
  const settings = await getSettings();
  const limit = appt.startsAt.getTime() - settings.cancelLimitHours * 3_600_000;
  if (Date.now() > limit)
    throw new BookingError(
      `Solo puedes modificar la cita hasta ${settings.cancelLimitHours} h antes. Llámanos si necesitas ayuda.`,
    );
  return appt;
}

export async function cancelByClient(id: string, clientId: string) {
  await assertClientCanChange(id, clientId);
  await db
    .update(appointment)
    .set({ status: "cancelled" })
    .where(eq(appointment.id, id));
}

export async function reschedule(input: {
  id: string;
  startsAt: Date;
  barberId?: string | "any";
  /** Si se pasa, valida que la cita sea de este cliente y respete los límites. */
  clientId?: string;
}) {
  const appt = input.clientId
    ? await assertClientCanChange(input.id, input.clientId)
    : await getAppointment(input.id);
  if (!appt) throw new BookingError("Cita no encontrada.");

  const settings = await getSettings();
  if (input.clientId) {
    const w = bookingWindow(settings);
    if (
      input.startsAt.getTime() < w.earliestStart ||
      toDateStr(input.startsAt) > w.lastDay
    )
      throw new BookingError(
        "Ese horario está fuera de la ventana de reservas.",
      );
  }

  const endsAt = new Date(
    input.startsAt.getTime() + appt.service.durationMin * 60_000,
  );
  const wanted = input.barberId ?? appt.barberId;

  return exclusive(async () => {
    const candidates =
      wanted === "any"
        ? await rankBarbers(appt.serviceId, input.startsAt)
        : [wanted];
    for (const barberId of candidates) {
      if (await isBarberFree(barberId, input.startsAt, endsAt, appt.id)) {
        await db
          .update(appointment)
          .set({ barberId, startsAt: input.startsAt, endsAt })
          .where(eq(appointment.id, appt.id));
        return;
      }
    }
    throw new BookingError("Ese horario no está disponible.");
  });
}

export async function setStatus(id: string, status: AppointmentStatus) {
  await db.update(appointment).set({ status }).where(eq(appointment.id, id));
}

async function clientHasOverlap(
  clientId: string,
  startsAt: Date,
  endsAt: Date,
) {
  const row = await db
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        eq(appointment.clientId, clientId),
        eq(appointment.status, "confirmed"),
        lt(appointment.startsAt, endsAt),
        gt(appointment.endsAt, startsAt),
      ),
    )
    .get();
  return Boolean(row);
}
