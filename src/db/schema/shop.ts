import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { id, timestamp, createdAt } from "./columns";
import { user } from "./auth";

// Tablas de la barbería. Solo apuntan hacia `auth` (user), nunca al revés.

export const barber = sqliteTable("barber", {
  id: id(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  bio: text("bio"),
  photoUrl: text("photo_url"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  /** SHA-256 del enlace de invitación pendiente (el token no se guarda). */
  inviteHash: text("invite_hash").unique(),
  inviteExpiresAt: timestamp("invite_expires_at"),
  createdAt: createdAt(),
});

export const service = sqliteTable("service", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  durationMin: integer("duration_min").notNull(),
  priceCents: integer("price_cents").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: createdAt(),
});

export const barberService = sqliteTable(
  "barber_service",
  {
    barberId: text("barber_id")
      .notNull()
      .references(() => barber.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.barberId, t.serviceId] })],
);

/** Horario semanal. weekday: 0 = domingo … 6 = sábado. Minutos desde medianoche (hora local). */
export const workingHours = sqliteTable(
  "working_hours",
  {
    id: id(),
    barberId: text("barber_id")
      .notNull()
      .references(() => barber.id, { onDelete: "cascade" }),
    weekday: integer("weekday").notNull(),
    startMin: integer("start_min").notNull(),
    endMin: integer("end_min").notNull(),
  },
  (t) => [index("working_hours_barber_idx").on(t.barberId, t.weekday)],
);

/** Bloqueos de horas, días libres y vacaciones. */
export const timeOff = sqliteTable(
  "time_off",
  {
    id: id(),
    barberId: text("barber_id")
      .notNull()
      .references(() => barber.id, { onDelete: "cascade" }),
    startsAt: timestamp("starts_at").notNull(),
    endsAt: timestamp("ends_at").notNull(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [index("time_off_barber_idx").on(t.barberId, t.startsAt)],
);

export const APPOINTMENT_STATUSES = [
  "confirmed",
  "completed",
  "cancelled",
  "no_show",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const appointment = sqliteTable(
  "appointment",
  {
    id: id(),
    clientId: text("client_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    barberId: text("barber_id")
      .notNull()
      .references(() => barber.id, { onDelete: "cascade" }),
    serviceId: text("service_id")
      .notNull()
      .references(() => service.id, { onDelete: "restrict" }),
    startsAt: timestamp("starts_at").notNull(),
    endsAt: timestamp("ends_at").notNull(),
    status: text("status")
      .$type<AppointmentStatus>()
      .notNull()
      .default("confirmed"),
    priceCents: integer("price_cents").notNull(),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [
    index("appointment_barber_idx").on(t.barberId, t.startsAt),
    index("appointment_client_idx").on(t.clientId, t.startsAt),
  ],
);

/** Notas internas del negocio sobre un cliente. */
export const clientNote = sqliteTable("client_note", {
  id: id(),
  clientId: text("client_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  authorId: text("author_id").references(() => user.id, {
    onDelete: "set null",
  }),
  body: text("body").notNull(),
  createdAt: createdAt(),
});

/** Fila única (id = 1). */
export const shopSettings = sqliteTable("shop_settings", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().default("Barbería"),
  address: text("address"),
  phone: text("phone"),
  slotStepMin: integer("slot_step_min").notNull().default(15),
  minLeadMin: integer("min_lead_min").notNull().default(60),
  maxDaysAhead: integer("max_days_ahead").notNull().default(30),
  cancelLimitHours: integer("cancel_limit_hours").notNull().default(2),
});
