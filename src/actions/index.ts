import {
  ActionError,
  defineAction,
  type ActionAPIContext,
} from "astro:actions";
import { z } from "astro/zod";
import { and, eq, ne } from "drizzle-orm";
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

const dateStr = z.string().refine(isDateStr, "Fecha inválida");
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Hora inválida");

/** Convierte errores de dominio en errores de acción legibles. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BookingError)
      throw new ActionError({ code: "CONFLICT", message: err.message });
    throw err;
  }
}

async function loadOwnedAppointment(ctx: ActionAPIContext, id: string) {
  const appt = await getAppointment(id);
  if (!appt)
    throw new ActionError({
      code: "NOT_FOUND",
      message: "Cita no encontrada.",
    });
  assertBarberScope(ctx, appt.barberId);
  return appt;
}

export const server = {
  // -------------------------------------------------------------------------
  // Clientes
  // -------------------------------------------------------------------------
  booking: {
    create: defineAction({
      input: z.object({
        serviceId: z.string(),
        barberId: z.string(),
        startsAt: z.iso.datetime(),
        notes: z.string().max(500).optional(),
      }),
      handler: async (input, ctx) => {
        const u = requireUser(ctx);
        const created = await run(() =>
          createAppointment({
            clientId: u.id,
            serviceId: input.serviceId,
            barberId: input.barberId,
            startsAt: new Date(input.startsAt),
            notes: input.notes,
          }),
        );
        return { id: created.id };
      },
    }),

    cancel: defineAction({
      accept: "form",
      input: z.object({ id: z.string() }),
      handler: async ({ id }, ctx) => {
        const u = requireUser(ctx);
        await run(() => cancelByClient(id, u.id));
        return { ok: true };
      },
    }),

    reschedule: defineAction({
      input: z.object({
        id: z.string(),
        barberId: z.string(),
        startsAt: z.iso.datetime(),
      }),
      handler: async (input, ctx) => {
        const u = requireUser(ctx);
        await run(() =>
          reschedule({
            id: input.id,
            barberId: input.barberId,
            startsAt: new Date(input.startsAt),
            clientId: u.id,
          }),
        );
        return { ok: true };
      },
    }),
  },

  // -------------------------------------------------------------------------
  // Panel: agenda y clientes
  // -------------------------------------------------------------------------
  agenda: {
    setStatus: defineAction({
      accept: "form",
      input: z.object({ id: z.string(), status: z.enum(APPOINTMENT_STATUSES) }),
      handler: async ({ id, status }, ctx) => {
        await loadOwnedAppointment(ctx, id);
        await setStatus(id, status);
        return { ok: true };
      },
    }),

    reschedule: defineAction({
      accept: "form",
      input: z.object({
        id: z.string(),
        barberId: z.string(),
        date: dateStr,
        time: hhmm,
      }),
      handler: async (input, ctx) => {
        await loadOwnedAppointment(ctx, input.id);
        assertBarberScope(ctx, input.barberId);
        await run(() =>
          reschedule({
            id: input.id,
            barberId: input.barberId,
            startsAt: atLocal(input.date, hhmmToMinutes(input.time)),
          }),
        );
        return { ok: true };
      },
    }),

    /** Cita creada por el personal (cliente que llama o llega sin reserva). */
    createManual: defineAction({
      accept: "form",
      input: z.object({
        clientId: z.string().optional(),
        name: z.string().trim().optional(),
        phone: z.string().trim().optional(),
        email: z.string().trim().optional(),
        serviceId: z.string(),
        barberId: z.string(),
        date: dateStr,
        time: hhmm,
        notes: z.string().optional(),
      }),
      handler: async (input, ctx) => {
        assertBarberScope(ctx, input.barberId);
        let clientId = input.clientId;
        if (!clientId) {
          const email = input.email?.toLowerCase();
          const existing = email
            ? await db.query.user.findFirst({ where: eq(user.email, email) })
            : undefined;
          if (existing) clientId = existing.id;
          else {
            if (!input.name)
              throw new ActionError({
                code: "BAD_REQUEST",
                message: "Indica el nombre del cliente.",
              });
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
          }
        }
        const created = await run(() =>
          createAppointment({
            clientId: clientId!,
            serviceId: input.serviceId,
            barberId: input.barberId,
            startsAt: atLocal(input.date, hhmmToMinutes(input.time)),
            notes: input.notes,
            fromStaff: true,
          }),
        );
        return { id: created.id };
      },
    }),
  },

  clients: {
    addNote: defineAction({
      accept: "form",
      input: z.object({
        clientId: z.string(),
        body: z.string().trim().min(1).max(2000),
      }),
      handler: async ({ clientId, body }, ctx) => {
        const { user: author } = requireStaff(ctx);
        await db
          .insert(clientNote)
          .values({ clientId, body, authorId: author.id });
        return { ok: true };
      },
    }),

    updateProfile: defineAction({
      accept: "form",
      input: z.object({
        clientId: z.string(),
        name: z.string().trim().min(1),
        phone: z.string().trim().optional(),
      }),
      handler: async ({ clientId, name, phone }, ctx) => {
        requireStaff(ctx);
        await db
          .update(user)
          .set({ name, phone: phone || null, updatedAt: new Date() })
          .where(eq(user.id, clientId));
        return { ok: true };
      },
    }),
  },

  // -------------------------------------------------------------------------
  // Panel: catálogo y equipo (admin)
  // -------------------------------------------------------------------------
  services: {
    save: defineAction({
      accept: "form",
      input: z.object({
        id: z.string().optional(),
        name: z.string().trim().min(1),
        description: z.string().trim().optional(),
        durationMin: z.coerce.number().int().min(5).max(480),
        price: z.coerce.number().min(0),
        active: z.boolean().optional(),
      }),
      handler: async (input, ctx) => {
        requireAdmin(ctx);
        const values = {
          name: input.name,
          description: input.description || null,
          durationMin: input.durationMin,
          priceCents: Math.round(input.price * 100),
          active: input.active ?? false,
        };
        if (input.id)
          await db.update(service).set(values).where(eq(service.id, input.id));
        else {
          const [svc] = await db
            .insert(service)
            .values({ ...values, active: true })
            .returning();
          // Por defecto todos los barberos lo ofrecen
          const barbers = await db.select({ id: barber.id }).from(barber);
          if (barbers.length)
            await db
              .insert(barberService)
              .values(
                barbers.map((b) => ({ barberId: b.id, serviceId: svc.id })),
              );
        }
        return { ok: true };
      },
    }),

    delete: defineAction({
      accept: "form",
      input: z.object({ id: z.string() }),
      handler: async ({ id }, ctx) => {
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
      },
    }),
  },

  barbers: {
    save: defineAction({
      accept: "form",
      input: z.object({
        id: z.string().optional(),
        name: z.string().trim().min(1),
        bio: z.string().trim().optional(),
        photoUrl: z.string().trim().optional(),
        email: z.string().trim().optional(),
        active: z.boolean().optional(),
        serviceIds: z.array(z.string()).optional(),
      }),
      handler: async (input, ctx) => {
        requireAdmin(ctx);
        let userId: string | null = null;
        if (input.email) {
          const linked = await db.query.user.findFirst({
            where: eq(user.email, input.email.toLowerCase()),
          });
          if (!linked)
            throw new ActionError({
              code: "NOT_FOUND",
              message: `No existe una cuenta con ${input.email}. El barbero debe registrarse primero.`,
            });
          userId = linked.id;
          if (linked.role !== "admin")
            await db
              .update(user)
              .set({ role: "barber" })
              .where(eq(user.id, linked.id));
        }
        const values = {
          name: input.name,
          bio: input.bio || null,
          photoUrl: input.photoUrl || null,
          userId,
          active: input.id ? (input.active ?? false) : true,
        };
        let barberId = input.id;
        if (barberId) {
          const prev = await db.query.barber.findFirst({
            where: eq(barber.id, barberId),
          });
          // Si se desvincula una cuenta, vuelve a ser cliente
          if (prev?.userId && prev.userId !== userId)
            await db
              .update(user)
              .set({ role: "user" })
              .where(and(eq(user.id, prev.userId), ne(user.role, "admin")));
          await db.update(barber).set(values).where(eq(barber.id, barberId));
        } else {
          const [created] = await db.insert(barber).values(values).returning();
          barberId = created.id;
        }
        await db
          .delete(barberService)
          .where(eq(barberService.barberId, barberId));
        if (input.serviceIds?.length)
          await db.insert(barberService).values(
            input.serviceIds.map((serviceId) => ({
              barberId: barberId!,
              serviceId,
            })),
          );
        return { id: barberId };
      },
    }),
  },

  // -------------------------------------------------------------------------
  // Panel: horarios, bloqueos y ajustes
  // -------------------------------------------------------------------------
  schedule: {
    /** Campos `d{weekday}_{n}_start` / `d{weekday}_{n}_end`, n = 1 | 2 (turno partido). */
    save: defineAction({
      accept: "form",
      handler: async (form, ctx) => {
        const barberId = String(form.get("barberId") ?? "");
        assertBarberScope(ctx, barberId);
        const rows: (typeof workingHours.$inferInsert)[] = [];
        for (let weekday = 0; weekday < 7; weekday++) {
          for (const n of [1, 2]) {
            const s = String(form.get(`d${weekday}_${n}_start`) ?? "");
            const e = String(form.get(`d${weekday}_${n}_end`) ?? "");
            if (!s || !e) continue;
            const startMin = hhmmToMinutes(s);
            const endMin = hhmmToMinutes(e);
            if (endMin <= startMin)
              throw new ActionError({
                code: "BAD_REQUEST",
                message: "Cada turno debe terminar después de empezar.",
              });
            rows.push({ barberId, weekday, startMin, endMin });
          }
        }
        await db
          .delete(workingHours)
          .where(eq(workingHours.barberId, barberId));
        if (rows.length) await db.insert(workingHours).values(rows);
        return { ok: true };
      },
    }),
  },

  timeOff: {
    create: defineAction({
      accept: "form",
      input: z.object({
        barberId: z.string(),
        startDate: dateStr,
        endDate: dateStr,
        startTime: z.string().optional(),
        endTime: z.string().optional(),
        reason: z.string().trim().optional(),
      }),
      handler: async (input, ctx) => {
        let barberIds = [input.barberId];
        if (input.barberId === "all") {
          requireAdmin(ctx);
          barberIds = (await db.select({ id: barber.id }).from(barber)).map(
            (b) => b.id,
          );
        } else assertBarberScope(ctx, input.barberId);
        const startsAt = atLocal(
          input.startDate,
          input.startTime ? hhmmToMinutes(input.startTime) : 0,
        );
        const endsAt = atLocal(
          input.endDate,
          input.endTime ? hhmmToMinutes(input.endTime) : 24 * 60,
        );
        if (endsAt <= startsAt)
          throw new ActionError({
            code: "BAD_REQUEST",
            message: "El fin debe ser posterior al inicio.",
          });
        await db.insert(timeOff).values(
          barberIds.map((barberId) => ({
            barberId,
            startsAt,
            endsAt,
            reason: input.reason || null,
          })),
        );
        return { ok: true };
      },
    }),

    delete: defineAction({
      accept: "form",
      input: z.object({ id: z.string() }),
      handler: async ({ id }, ctx) => {
        const row = await db.query.timeOff.findFirst({
          where: eq(timeOff.id, id),
        });
        if (!row) return { ok: true };
        assertBarberScope(ctx, row.barberId);
        await db.delete(timeOff).where(eq(timeOff.id, id));
        return { ok: true };
      },
    }),
  },

  settings: {
    save: defineAction({
      accept: "form",
      input: z.object({
        name: z.string().trim().min(1),
        address: z.string().trim().optional(),
        phone: z.string().trim().optional(),
        slotStepMin: z.coerce.number().int().min(5).max(120),
        minLeadMin: z.coerce.number().int().min(0),
        maxDaysAhead: z.coerce.number().int().min(1).max(365),
        cancelLimitHours: z.coerce.number().int().min(0),
      }),
      handler: async (input, ctx) => {
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
      },
    }),
  },
};
