import { and, eq, gt, lt, ne, sql } from "drizzle-orm";
import { db, writeTx, type Executor } from "@/db";
import {
  appointment,
  barber,
  barberService,
  service,
  type AppointmentStatus,
} from "@/db/schema";
import {
  bookingWindow,
  getAvailableSlots,
  isBarberFree,
} from "./availability";
import { getSettings } from "./settings";
import { dayRange, toDateStr } from "./time";

export class BookingError extends Error {}

// Comprobar disponibilidad y escribir van en la misma transacción de escritura,
// así que no se cuela otra reserva en medio (ni desde otra instancia).
async function exclusive<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
  try {
    return await writeTx(fn);
  } catch (err) {
    if (isBusy(err))
      throw new BookingError(
        "Hay muchas reservas en este momento. Inténtalo de nuevo.",
      );
    throw err;
  }
}

function isBusy(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = e.cause)
    if ((e as { code?: string }).code?.startsWith("SQLITE_BUSY")) return true;
  return false;
}

async function loadService(serviceId: string) {
  const svc = await db.query.service.findFirst({
    where: and(eq(service.id, serviceId), eq(service.active, true)),
  });
  if (!svc)
    throw new BookingError("El servicio no existe o no está disponible.");
  return svc;
}

/**
 * Las reservas de clientes deben caer en un horario que el asistente ofrece
 * (rejilla de `slotStepMin`, dentro del turno); evita horas como 10:07.
 */
async function assertOffered(opts: {
  serviceId: string;
  barberId: string | "any";
  startsAt: Date;
  excludeAppointmentId?: string;
}) {
  const slots = await getAvailableSlots({
    serviceId: opts.serviceId,
    barberId: opts.barberId,
    date: toDateStr(opts.startsAt),
    excludeAppointmentId: opts.excludeAppointmentId,
  });
  const t = opts.startsAt.getTime();
  if (!slots.some((s) => new Date(s.startsAt).getTime() === t))
    throw new BookingError(
      "Ese horario ya no está disponible. Por favor elige otro.",
    );
}

/** Barberos activos que hacen el servicio, ordenados por menos citas ese día. */
async function rankBarbers(serviceId: string, startsAt: Date, q: Executor) {
  const { start, end } = dayRange(toDateStr(startsAt));
  const rows = await q
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

/** "any" → todos ordenados por carga; un id → solo ese, si está activo y hace el servicio. */
async function candidateBarbers(
  serviceId: string,
  wanted: string | "any",
  startsAt: Date,
  q: Executor,
) {
  const ranked = await rankBarbers(serviceId, startsAt, q);
  const candidates =
    wanted === "any" ? ranked : ranked.filter((id) => id === wanted);
  if (candidates.length === 0)
    throw new BookingError("Ese barbero no realiza este servicio.");
  return candidates;
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
    await assertOffered({
      serviceId: svc.id,
      barberId: input.barberId,
      startsAt,
    });
  }

  return exclusive(async (tx) => {
    // Dentro de la transacción: dos peticiones simultáneas del mismo cliente no pasan ambas.
    if (await clientHasOverlap(input.clientId, startsAt, endsAt, undefined, tx))
      throw new BookingError("Ya tienes una cita en ese horario.");

    const candidates = await candidateBarbers(
      svc.id,
      input.barberId,
      startsAt,
      tx,
    );

    for (const barberId of candidates) {
      if (await isBarberFree(barberId, startsAt, endsAt, undefined, tx)) {
        const [created] = await tx
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
    .where(and(eq(appointment.id, id), eq(appointment.status, "confirmed")));
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
  if (appt.status !== "confirmed")
    throw new BookingError("Esta cita ya no se puede modificar.");

  const wanted = input.barberId ?? appt.barberId;
  if (input.clientId) {
    const settings = await getSettings();
    const w = bookingWindow(settings);
    if (
      input.startsAt.getTime() < w.earliestStart ||
      toDateStr(input.startsAt) > w.lastDay
    )
      throw new BookingError(
        "Ese horario está fuera de la ventana de reservas.",
      );
    await assertOffered({
      serviceId: appt.serviceId,
      barberId: wanted,
      startsAt: input.startsAt,
      excludeAppointmentId: appt.id,
    });
  }

  const endsAt = new Date(
    input.startsAt.getTime() + appt.service.durationMin * 60_000,
  );

  return exclusive(async (tx) => {
    if (
      await clientHasOverlap(appt.clientId, input.startsAt, endsAt, appt.id, tx)
    )
      throw new BookingError("El cliente ya tiene otra cita en ese horario.");

    const candidates = await candidateBarbers(
      appt.serviceId,
      wanted,
      input.startsAt,
      tx,
    );
    for (const barberId of candidates) {
      if (await isBarberFree(barberId, input.startsAt, endsAt, appt.id, tx)) {
        await tx
          .update(appointment)
          .set({ barberId, startsAt: input.startsAt, endsAt })
          .where(
            and(
              eq(appointment.id, appt.id),
              eq(appointment.status, "confirmed"),
            ),
          );
        return;
      }
    }
    throw new BookingError("Ese horario no está disponible.");
  });
}

export async function setStatus(id: string, status: AppointmentStatus) {
  if (status === "cancelled") {
    await db.update(appointment).set({ status }).where(eq(appointment.id, id));
    return;
  }
  // Sacar una cita de "cancelada" vuelve a ocupar su hueco, que puede estar ya
  // reservado: se comprueba en la transacción igual que una reserva nueva.
  return exclusive(async (tx) => {
    const appt = await tx.query.appointment.findFirst({
      where: eq(appointment.id, id),
    });
    if (!appt) throw new BookingError("Cita no encontrada.");
    if (appt.status === "cancelled") {
      const clash = await tx
        .select({ id: appointment.id })
        .from(appointment)
        .where(
          and(
            eq(appointment.barberId, appt.barberId),
            ne(appointment.id, appt.id),
            ne(appointment.status, "cancelled"),
            lt(appointment.startsAt, appt.endsAt),
            gt(appointment.endsAt, appt.startsAt),
          ),
        )
        .get();
      if (clash)
        throw new BookingError(
          "El hueco de esta cita ya está ocupado por otra.",
        );
    }
    await tx.update(appointment).set({ status }).where(eq(appointment.id, id));
  });
}

async function clientHasOverlap(
  clientId: string,
  startsAt: Date,
  endsAt: Date,
  excludeAppointmentId?: string,
  q: Executor = db,
) {
  const row = await q
    .select({ id: appointment.id })
    .from(appointment)
    .where(
      and(
        eq(appointment.clientId, clientId),
        eq(appointment.status, "confirmed"),
        lt(appointment.startsAt, endsAt),
        gt(appointment.endsAt, startsAt),
        excludeAppointmentId
          ? ne(appointment.id, excludeAppointmentId)
          : undefined,
      ),
    )
    .get();
  return Boolean(row);
}
