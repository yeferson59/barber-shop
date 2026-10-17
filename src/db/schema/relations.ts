import { relations } from "drizzle-orm";
import { user } from "./auth";
import {
  appointment,
  barber,
  barberService,
  service,
  timeOff,
  workingHours,
} from "./shop";

// Relaciones para las consultas `db.query.*.findMany({ with })`. Drizzle las
// pide en los dos sentidos (user → appointments y appointment → client), pero
// son solo declaraciones: este archivo importa las tablas y nadie lo importa a él
// salvo el índice.

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
