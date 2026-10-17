import { relations, sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });

const createdAt = () =>
  timestamp("created_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

// ---------------------------------------------------------------------------
// better-auth (core + admin plugin + campo extra `phone`)
// ---------------------------------------------------------------------------

export type Role = "admin" | "barber" | "user";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .default(false),
  image: text("image"),
  phone: text("phone"),
  role: text("role").$type<Role>().default("user"),
  banned: integer("banned", { mode: "boolean" }).default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at")
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// Límite de peticiones de better-auth: en BD para que valga entre instancias.
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});

// ---------------------------------------------------------------------------
// Barbería
// ---------------------------------------------------------------------------

export const barber = sqliteTable("barber", {
  id: id(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  bio: text("bio"),
  photoUrl: text("photo_url"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
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

// ---------------------------------------------------------------------------
// Relaciones
// ---------------------------------------------------------------------------

export const userRelations = relations(user, ({ many }) => ({
  appointments: many(appointment),
}));

export const barberRelations = relations(barber, ({ one, many }) => ({
  user: one(user, { fields: [barber.userId], references: [user.id] }),
  services: many(barberService),
  workingHours: many(workingHours),
  timeOff: many(timeOff),
  appointments: many(appointment),
}));

export const serviceRelations = relations(service, ({ many }) => ({
  barbers: many(barberService),
}));

export const barberServiceRelations = relations(barberService, ({ one }) => ({
  barber: one(barber, {
    fields: [barberService.barberId],
    references: [barber.id],
  }),
  service: one(service, {
    fields: [barberService.serviceId],
    references: [service.id],
  }),
}));

export const workingHoursRelations = relations(workingHours, ({ one }) => ({
  barber: one(barber, {
    fields: [workingHours.barberId],
    references: [barber.id],
  }),
}));

export const timeOffRelations = relations(timeOff, ({ one }) => ({
  barber: one(barber, { fields: [timeOff.barberId], references: [barber.id] }),
}));

export const appointmentRelations = relations(appointment, ({ one }) => ({
  client: one(user, { fields: [appointment.clientId], references: [user.id] }),
  barber: one(barber, {
    fields: [appointment.barberId],
    references: [barber.id],
  }),
  service: one(service, {
    fields: [appointment.serviceId],
    references: [service.id],
  }),
}));
