/**
 * Datos de ejemplo. Borra todo y vuelve a crear:
 *   pnpm db:seed
 */
import { hashPassword } from "better-auth/crypto";
import { db } from "@/db";
import {
  account,
  appointment,
  barber,
  barberService,
  clientNote,
  service,
  session,
  shopSettings,
  timeOff,
  user,
  workingHours,
  type Role,
} from "@/db/schema";
import { addDaysStr, atLocal, todayStr, weekdayOf } from "@/lib/time";

async function createUser(
  email: string,
  name: string,
  password: string,
  role: Role,
  phone?: string,
) {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(user).values({
    id,
    email,
    name,
    role,
    phone,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(account).values({
    id: crypto.randomUUID(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: await hashPassword(password),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function main() {
  // Borra todo: no ejecutarlo por accidente contra producción
  const url = process.env.DATABASE_URL || "file:./data/barber.db";
  if (
    (process.env.NODE_ENV === "production" || !url.startsWith("file:")) &&
    process.env.SEED_FORCE !== "1"
  )
    throw new Error(
      `El seed borra todos los datos de ${url}. Usa SEED_FORCE=1 si de verdad quieres hacerlo.`,
    );

  for (const table of [
    appointment,
    timeOff,
    workingHours,
    barberService,
    clientNote,
    barber,
    service,
    session,
    account,
    user,
    shopSettings,
  ]) {
    await db.delete(table);
  }

  await db.insert(shopSettings).values({
    id: 1,
    name: "La Navaja Barber Shop",
    address: "Calle 10 # 20-30",
    phone: "+57 300 000 0000",
  });

  await createUser("admin@barberia.test", "Dueño", "admin1234", "admin");
  const carlosUser = await createUser(
    "carlos@barberia.test",
    "Carlos Ruiz",
    "barber1234",
    "barber",
  );
  const andresUser = await createUser(
    "andres@barberia.test",
    "Andrés Gómez",
    "barber1234",
    "barber",
  );
  const clientIds = await Promise.all([
    createUser("cliente@barberia.test", "Juan Pérez", "cliente1234", "user", "+57 311 111 1111"),
    createUser("maria@barberia.test", "María López", "cliente1234", "user", "+57 322 222 2222"),
    createUser("pedro@barberia.test", "Pedro Díaz", "cliente1234", "user"),
  ]);

  const services = await db
    .insert(service)
    .values([
      { name: "Corte clásico", description: "Corte a tijera o máquina con lavado.", durationMin: 30, priceCents: 25_000_00 },
      { name: "Corte + barba", description: "Corte completo y perfilado de barba con toalla caliente.", durationMin: 60, priceCents: 40_000_00 },
      { name: "Arreglo de barba", description: "Perfilado, rebajado y aceites.", durationMin: 30, priceCents: 18_000_00 },
      { name: "Corte infantil", description: "Para menores de 12 años.", durationMin: 30, priceCents: 20_000_00 },
      { name: "Diseño / líneas", description: "Detalles y diseños con navaja.", durationMin: 15, priceCents: 10_000_00 },
    ])
    .returning();

  const barbers = await db
    .insert(barber)
    .values([
      { name: "Carlos Ruiz", userId: carlosUser, bio: "Especialista en fades y diseños. 8 años de experiencia." },
      { name: "Andrés Gómez", userId: andresUser, bio: "Cortes clásicos y barbas tradicionales." },
    ])
    .returning();

  await db.insert(barberService).values(
    barbers.flatMap((b, i) =>
      services
        // Andrés no hace diseños
        .filter((s) => !(i === 1 && s.name.startsWith("Diseño")))
        .map((s) => ({ barberId: b.id, serviceId: s.id })),
    ),
  );

  // Lunes a sábado 9:00–13:00 y 14:00–19:00
  await db.insert(workingHours).values(
    barbers.flatMap((b) =>
      [1, 2, 3, 4, 5, 6].flatMap((weekday) => [
        { barberId: b.id, weekday, startMin: 9 * 60, endMin: 13 * 60 },
        { barberId: b.id, weekday, startMin: 14 * 60, endMin: 19 * 60 },
      ]),
    ),
  );

  // Citas de ejemplo: pasadas (completadas) y próximas
  const today = todayStr();
  const appts: (typeof appointment.$inferInsert)[] = [];
  for (let offset = -21; offset <= 6; offset++) {
    const date = addDaysStr(today, offset);
    if (weekdayOf(date) === 0) continue;
    for (const [bi, b] of barbers.entries()) {
      const perDay = 3 + ((offset + bi * 2 + 21) % 4);
      for (let k = 0; k < perDay; k++) {
        const svc = services[(k + offset + 21 + bi) % services.length];
        const startMin = 9 * 60 + k * 90 + (k >= 3 ? 60 : 0);
        if (startMin + svc.durationMin > 19 * 60) break;
        const startsAt = atLocal(date, startMin);
        const status =
          offset < 0 ? (k % 7 === 6 ? "no_show" : k % 5 === 4 ? "cancelled" : "completed") : "confirmed";
        appts.push({
          clientId: clientIds[(k + bi) % clientIds.length],
          barberId: b.id,
          serviceId: svc.id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + svc.durationMin * 60_000),
          status,
          priceCents: svc.priceCents,
        });
      }
    }
  }
  await db.insert(appointment).values(appts);

  // Andrés libre el próximo sábado por la tarde
  let saturday = addDaysStr(today, 1);
  while (weekdayOf(saturday) !== 6) saturday = addDaysStr(saturday, 1);
  await db.insert(timeOff).values({
    barberId: barbers[1].id,
    startsAt: atLocal(saturday, 14 * 60),
    endsAt: atLocal(saturday, 19 * 60),
    reason: "Cita médica",
  });

  console.log(`Seed listo: ${services.length} servicios, ${barbers.length} barberos, ${appts.length} citas.`);
  console.log("Admin:    admin@barberia.test / admin1234");
  console.log("Barbero:  carlos@barberia.test / barber1234");
  console.log("Cliente:  cliente@barberia.test / cliente1234");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
