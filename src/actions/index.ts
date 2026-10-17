import {
  ActionError,
  defineAction,
  type ActionAPIContext,
} from "astro:actions";
import { z } from "astro/zod";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { db } from "@/db";
import {
  APPOINTMENT_STATUSES,
  appointment,
  barber,
  barberService,
  clientNote,
  service,
  shopSettings,
  timeOff,
  user,
  workingHours,
} from "@/db/schema";
import {
  BookingError,
  cancelByClient,
  createAppointment,
  getAppointment,
  reschedule,
  setStatus,
} from "@/lib/booking";
import {
  assertBarberScope,
  requireAdmin,
  requireStaff,
  requireUser,
} from "@/lib/guards";
import { atLocal, hhmmToMinutes, isDateStr } from "@/lib/time";

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const id = z.string().min(1).max(64);
const dateStr = z.string().refine(isDateStr, "Fecha inválida");
const hhmm = z.string().regex(HHMM_RE, "Hora inválida");
const optionalHhmm = z.union([z.literal(""), hhmm]).optional();
const optionalText = (max: number) => z.string().trim().max(max).optional();
const optionalEmail = z.union([z.literal(""), z.email().max(254)]).optional();

/**
 * Envuelve un handler: los errores de dominio pasan como CONFLICT y cualquier
 * otro error inesperado (SQL, etc.) se registra en el servidor y se devuelve
 * genérico. Astro serializa `err.message` al cliente incluso en producción, y
 * los errores de Drizzle incluyen la consulta y sus parámetros.
 */
function safe<I, O>(handler: (input: I, ctx: ActionAPIContext) => Promise<O>) {
  return async (input: I, ctx: ActionAPIContext): Promise<O> => {
    try {
      return await handler(input, ctx);
    } catch (err) {
      if (err instanceof ActionError) throw err;
      if (err instanceof BookingError)
        throw new ActionError({ code: "CONFLICT", message: err.message });
      console.error(err);
      throw new ActionError({
        code: "INTERNAL_SERVER_ERROR",
        message: "No se pudo completar la operación. Inténtalo de nuevo.",
      });
    }
  };
}

const notFound = (message: string) =>
  new ActionError({ code: "NOT_FOUND", message });
const badRequest = (message: string) =>
  new ActionError({ code: "BAD_REQUEST", message });

async function loadOwnedAppointment(ctx: ActionAPIContext, id: string) {
  requireStaff(ctx);
  const appt = await getAppointment(id);
  if (!appt) throw notFound("Cita no encontrada.");
  assertBarberScope(ctx, appt.barberId);
  return appt;
}

/** `barberId` debe ser un barbero activo que ofrezca el servicio (o "any"). */
async function assertBarberOffers(barberId: string, serviceId: string) {
  if (barberId === "any") return;
  const row = await db
    .select({ id: barber.id })
    .from(barber)
    .innerJoin(barberService, eq(barberService.barberId, barber.id))
    .where(
      and(
        eq(barber.id, barberId),
        eq(barber.active, true),
        eq(barberService.serviceId, serviceId),
      ),
    )
    .get();
  if (!row) throw badRequest("Ese barbero no realiza este servicio.");
}

/**
 * Clientes (rol "user") que el personal puede gestionar: el admin, todos; un
 * barbero, solo los que tienen alguna cita con él.
 */
async function assertClientScope(ctx: ActionAPIContext, clientId: string) {
  const staff = requireStaff(ctx);
  const client = await db.query.user.findFirst({
    where: and(eq(user.id, clientId), eq(user.role, "user")),
  });
  if (!client) throw notFound("Cliente no encontrado.");
  if (!staff.isAdmin) {
    const seen = staff.barberId
      ? await db
          .select({ id: appointment.id })
          .from(appointment)
          .where(
            and(
              eq(appointment.clientId, clientId),
              eq(appointment.barberId, staff.barberId),
            ),
          )
          .get()
      : undefined;
    if (!seen) throw notFound("Cliente no encontrado.");
  }
  return staff;
}

export const server = {
  // -------------------------------------------------------------------------
  // Clientes
  // -------------------------------------------------------------------------
  booking: {
    create: defineAction({
      input: z.object({
        serviceId: id,
        barberId: id,
        startsAt: z.iso.datetime(),
        notes: optionalText(500),
      }),
      handler: safe(async (input, ctx) => {
        const u = requireUser(ctx);
        // createAppointment ya exige barbero activo que ofrezca el servicio
        const created = await createAppointment({
          clientId: u.id,
          serviceId: input.serviceId,
          barberId: input.barberId,
          startsAt: new Date(input.startsAt),
          notes: input.notes,
        });
        return { id: created.id };
      }),
    }),

    cancel: defineAction({
      accept: "form",
      input: z.object({ id }),
      handler: safe(async ({ id }, ctx) => {
        const u = requireUser(ctx);
        await cancelByClient(id, u.id);
        return { ok: true };
      }),
    }),

    reschedule: defineAction({
      input: z.object({
        id,
        barberId: id,
        startsAt: z.iso.datetime(),
      }),
      handler: safe(async (input, ctx) => {
        const u = requireUser(ctx);
        const appt = await getAppointment(input.id);
        if (!appt || appt.clientId !== u.id) throw notFound("Cita no encontrada.");
        await assertBarberOffers(input.barberId, appt.serviceId);
        await reschedule({
          id: input.id,
          barberId: input.barberId,
          startsAt: new Date(input.startsAt),
          clientId: u.id,
        });
        return { ok: true };
      }),
    }),
  },

  // -------------------------------------------------------------------------
  // Panel: agenda y clientes
  // -------------------------------------------------------------------------
  agenda: {
    setStatus: defineAction({
      accept: "form",
      input: z.object({ id, status: z.enum(APPOINTMENT_STATUSES) }),
      handler: safe(async ({ id, status }, ctx) => {
        await loadOwnedAppointment(ctx, id);
        // setStatus comprueba solapes al reactivar una cita cancelada
        await setStatus(id, status);
        return { ok: true };
      }),
    }),

    reschedule: defineAction({
      accept: "form",
      input: z.object({
        id,
        barberId: id,
        date: dateStr,
        time: hhmm,
      }),
      handler: safe(async (input, ctx) => {
        const appt = await loadOwnedAppointment(ctx, input.id);
        assertBarberScope(ctx, input.barberId);
        await assertBarberOffers(input.barberId, appt.serviceId);
        await reschedule({
          id: input.id,
          barberId: input.barberId,
          startsAt: atLocal(input.date, hhmmToMinutes(input.time)),
        });
        return { ok: true };
      }),
    }),

    /** Cita creada por el personal (cliente que llama o llega sin reserva). */
    createManual: defineAction({
      accept: "form",
      input: z.object({
        clientId: id.optional(),
        name: optionalText(100),
        phone: optionalText(30),
        email: optionalEmail,
        serviceId: id,
        barberId: id,
        date: dateStr,
        time: hhmm,
        notes: optionalText(500),
      }),
      handler: safe(async (input, ctx) => {
        assertBarberScope(ctx, input.barberId);
        let clientId = input.clientId;
        let createdClient = false;
        if (clientId) {
          const known = await db.query.user.findFirst({
            where: and(eq(user.id, clientId), eq(user.role, "user")),
          });
          if (!known) throw notFound("Cliente no encontrado.");
        } else {
          const email = input.email?.toLowerCase();
          const existing = email
            ? await db.query.user.findFirst({ where: eq(user.email, email) })
            : undefined;
          if (existing) {
            if (existing.role !== "user")
              throw badRequest(
                "Ese correo pertenece a una cuenta del equipo, no a un cliente.",
              );
            clientId = existing.id;
          } else {
            if (!input.name) throw badRequest("Indica el nombre del cliente.");
            clientId = crypto.randomUUID();
            await db.insert(user).values({
              id: clientId,
              name: input.name,
              phone: input.phone || null,
              email: email || `sin-correo-${clientId}@clientes.local`,
              role: "user",
              createdAt: new Date(),
              updatedAt: new Date(),
            });
            createdClient = true;
          }
        }
        try {
          const created = await createAppointment({
            clientId,
            serviceId: input.serviceId,
            barberId: input.barberId,
            startsAt: atLocal(input.date, hhmmToMinutes(input.time)),
            notes: input.notes,
            fromStaff: true,
          });
          return { id: created.id };
        } catch (err) {
          // No dejar clientes huérfanos si la cita no se pudo crear
          if (createdClient)
            await db.delete(user).where(eq(user.id, clientId));
          throw err;
        }
      }),
    }),
  },

  clients: {
    addNote: defineAction({
      accept: "form",
      input: z.object({
        clientId: id,
        body: z.string().trim().min(1).max(2000),
      }),
      handler: safe(async ({ clientId, body }, ctx) => {
        const { user: author } = await assertClientScope(ctx, clientId);
        await db
          .insert(clientNote)
          .values({ clientId, body, authorId: author.id });
        return { ok: true };
      }),
    }),

    updateProfile: defineAction({
      accept: "form",
      input: z.object({
        clientId: id,
        name: z.string().trim().min(1).max(100),
        phone: optionalText(30),
      }),
      handler: safe(async ({ clientId, name, phone }, ctx) => {
        await assertClientScope(ctx, clientId);
        await db
          .update(user)
          .set({ name, phone: phone || null, updatedAt: new Date() })
          .where(eq(user.id, clientId));
        return { ok: true };
      }),
    }),
  },

  // -------------------------------------------------------------------------
  // Panel: catálogo y equipo (admin)
  // -------------------------------------------------------------------------
  services: {
    save: defineAction({
      accept: "form",
      input: z.object({
        id: id.optional(),
        name: z.string().trim().min(1).max(100),
        description: optionalText(500),
        durationMin: z.coerce.number().int().min(5).max(480),
        price: z.coerce.number().min(0).max(100_000_000),
        active: z.boolean().optional(),
      }),
      handler: safe(async (input, ctx) => {
        requireAdmin(ctx);
        const values = {
          name: input.name,
          description: input.description || null,
          durationMin: input.durationMin,
          priceCents: Math.round(input.price * 100),
          active: input.active ?? false,
        };
        if (input.id) {
          const updated = await db
            .update(service)
            .set(values)
            .where(eq(service.id, input.id))
            .returning({ id: service.id });
          if (!updated.length) throw notFound("Servicio no encontrado.");
          return { ok: true };
        }
        // Por defecto todos los barberos lo ofrecen (en un solo lote atómico)
        const serviceId = crypto.randomUUID();
        const barbers = await db.select({ id: barber.id }).from(barber);
        const writes: BatchItem<"sqlite">[] = [];
        if (barbers.length)
          writes.push(
            db
              .insert(barberService)
              .values(barbers.map((b) => ({ barberId: b.id, serviceId }))),
          );
        await db.batch([
          db.insert(service).values({ ...values, id: serviceId, active: true }),
          ...writes,
        ]);
        return { ok: true };
      }),
    }),

    delete: defineAction({
      accept: "form",
      input: z.object({ id }),
      handler: safe(async ({ id }, ctx) => {
        requireAdmin(ctx);
        const used = await db
          .select({ id: appointment.id })
          .from(appointment)
          .where(eq(appointment.serviceId, id))
          .get();
        // Con historial no se borra: se desactiva para conservar estadísticas
        if (used)
          await db
            .update(service)
            .set({ active: false })
            .where(eq(service.id, id));
        else await db.delete(service).where(eq(service.id, id));
        return { ok: true, deactivated: Boolean(used) };
      }),
    }),
  },

  barbers: {
    save: defineAction({
      accept: "form",
      input: z.object({
        id: id.optional(),
        name: z.string().trim().min(1).max(100),
        bio: optionalText(500),
        photoUrl: z
          .union([
            z.literal(""),
            z
              .string()
              .trim()
              .max(500)
              .regex(/^(https?:\/\/|\/(?!\/))\S+$/, "URL de foto inválida"),
          ])
          .optional(),
        email: optionalEmail,
        active: z.boolean().optional(),
        serviceIds: z.array(id).max(100).optional(),
      }),
      handler: safe(async (input, ctx) => {
        requireAdmin(ctx);
        const prev = input.id
          ? await db.query.barber.findFirst({ where: eq(barber.id, input.id) })
          : undefined;
        if (input.id && !prev) throw notFound("Barbero no encontrado.");

        const writes: BatchItem<"sqlite">[] = [];
        let userId: string | null = null;
        if (input.email) {
          const linked = await db.query.user.findFirst({
            where: eq(user.email, input.email.toLowerCase()),
          });
          if (!linked)
            throw notFound(
              `No existe una cuenta con ${input.email}. El barbero debe registrarse primero.`,
            );
          const other = await db.query.barber.findFirst({
            where: and(
              eq(barber.userId, linked.id),
              input.id ? ne(barber.id, input.id) : undefined,
            ),
          });
          if (other)
            throw badRequest(
              `Esa cuenta ya está vinculada al barbero ${other.name}.`,
            );
          userId = linked.id;
          if (linked.role !== "admin")
            writes.push(
              db
                .update(user)
                .set({ role: "barber" })
                .where(eq(user.id, linked.id)),
            );
        }
        // Si se desvincula una cuenta, vuelve a ser cliente
        if (prev?.userId && prev.userId !== userId)
          writes.push(
            db
              .update(user)
              .set({ role: "user" })
              .where(and(eq(user.id, prev.userId), ne(user.role, "admin"))),
          );

        const barberId = prev?.id ?? crypto.randomUUID();
        const values = {
          name: input.name,
          bio: input.bio || null,
          photoUrl: input.photoUrl || null,
          userId,
          active: prev ? (input.active ?? false) : true,
        };
        writes.push(
          prev
            ? db.update(barber).set(values).where(eq(barber.id, barberId))
            : db.insert(barber).values({ ...values, id: barberId }),
          db.delete(barberService).where(eq(barberService.barberId, barberId)),
        );
        const serviceIds = input.serviceIds?.length
          ? (
              await db
                .select({ id: service.id })
                .from(service)
                .where(inArray(service.id, input.serviceIds))
            ).map((s) => s.id)
          : [];
        if (serviceIds.length)
          writes.push(
            db
              .insert(barberService)
              .values(serviceIds.map((serviceId) => ({ barberId, serviceId }))),
          );
        const [first, ...rest] = writes;
        await db.batch([first, ...rest]);
        return { id: barberId };
      }),
    }),
  },

  // -------------------------------------------------------------------------
  // Panel: horarios, bloqueos y ajustes
  // -------------------------------------------------------------------------
  schedule: {
    /** Campos `d{weekday}_{n}_start` / `d{weekday}_{n}_end`, n = 1 | 2 (turno partido). */
    save: defineAction({
      accept: "form",
      handler: safe(async (form: FormData, ctx) => {
        const barberId = String(form.get("barberId") ?? "");
        assertBarberScope(ctx, barberId);
        const exists = await db.query.barber.findFirst({
          where: eq(barber.id, barberId),
        });
        if (!exists) throw notFound("Barbero no encontrado.");
        const rows: (typeof workingHours.$inferInsert)[] = [];
        for (let weekday = 0; weekday < 7; weekday++) {
          const shifts: { startMin: number; endMin: number }[] = [];
          for (const n of [1, 2]) {
            const s = String(form.get(`d${weekday}_${n}_start`) ?? "");
            const e = String(form.get(`d${weekday}_${n}_end`) ?? "");
            if (!s && !e) continue;
            if (!HHMM_RE.test(s) || !HHMM_RE.test(e))
              throw badRequest(
                "Cada turno necesita hora de inicio y de fin válidas.",
              );
            const startMin = hhmmToMinutes(s);
            const endMin = hhmmToMinutes(e);
            if (endMin <= startMin)
              throw badRequest("Cada turno debe terminar después de empezar.");
            shifts.push({ startMin, endMin });
          }
          shifts.sort((a, b) => a.startMin - b.startMin);
          if (shifts.length === 2 && shifts[1].startMin < shifts[0].endMin)
            throw badRequest("Los dos turnos de un día no pueden solaparse.");
          for (const sh of shifts) rows.push({ barberId, weekday, ...sh });
        }
        const clear = db
          .delete(workingHours)
          .where(eq(workingHours.barberId, barberId));
        // Borrar e insertar en un único lote atómico
        if (rows.length)
          await db.batch([clear, db.insert(workingHours).values(rows)]);
        else await clear;
        return { ok: true };
      }),
    }),
  },

  timeOff: {
    create: defineAction({
      accept: "form",
      input: z.object({
        barberId: id,
        startDate: dateStr,
        endDate: dateStr,
        startTime: optionalHhmm,
        endTime: optionalHhmm,
        reason: optionalText(200),
      }),
      handler: safe(async (input, ctx) => {
        let barberIds = [input.barberId];
        if (input.barberId === "all") {
          requireAdmin(ctx);
          barberIds = (await db.select({ id: barber.id }).from(barber)).map(
            (b) => b.id,
          );
          if (!barberIds.length) throw badRequest("No hay barberos.");
        } else {
          assertBarberScope(ctx, input.barberId);
          const exists = await db.query.barber.findFirst({
            where: eq(barber.id, input.barberId),
          });
          if (!exists) throw notFound("Barbero no encontrado.");
        }
        // Sin hora de inicio: desde el comienzo del primer día; sin hora de
        // fin: hasta el final del último día.
        const startsAt = atLocal(
          input.startDate,
          input.startTime ? hhmmToMinutes(input.startTime) : 0,
        );
        const endsAt = atLocal(
          input.endDate,
          input.endTime ? hhmmToMinutes(input.endTime) : 24 * 60,
        );
        if (endsAt <= startsAt)
          throw badRequest("El fin debe ser posterior al inicio.");
        if (endsAt.getTime() - startsAt.getTime() > 366 * 24 * 3_600_000)
          throw badRequest("Un bloqueo no puede durar más de un año.");
        await db.insert(timeOff).values(
          barberIds.map((barberId) => ({
            barberId,
            startsAt,
            endsAt,
            reason: input.reason || null,
          })),
        );
        return { ok: true };
      }),
    }),

    delete: defineAction({
      accept: "form",
      input: z.object({ id }),
      handler: safe(async ({ id }, ctx) => {
        requireStaff(ctx);
        const row = await db.query.timeOff.findFirst({
          where: eq(timeOff.id, id),
        });
        if (!row) return { ok: true };
        assertBarberScope(ctx, row.barberId);
        await db.delete(timeOff).where(eq(timeOff.id, id));
        return { ok: true };
      }),
    }),
  },

  settings: {
    save: defineAction({
      accept: "form",
      input: z.object({
        name: z.string().trim().min(1).max(100),
        address: optionalText(200),
        phone: optionalText(30),
        slotStepMin: z.coerce.number().int().min(5).max(120),
        minLeadMin: z.coerce.number().int().min(0).max(7 * 24 * 60),
        maxDaysAhead: z.coerce.number().int().min(1).max(365),
        cancelLimitHours: z.coerce.number().int().min(0).max(30 * 24),
      }),
      handler: safe(async (input, ctx) => {
        requireAdmin(ctx);
        const values = {
          ...input,
          address: input.address || null,
          phone: input.phone || null,
        };
        await db
          .insert(shopSettings)
          .values({ id: 1, ...values })
          .onConflictDoUpdate({ target: shopSettings.id, set: values });
        return { ok: true };
      }),
    }),
  },
};
