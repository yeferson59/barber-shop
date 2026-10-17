# Barbería — reservas y gestión

Web para una barbería con reservas online, vista pública de ocupación y panel de gestión.

**Stack:** Astro 7 (SSR, adapter Node) · Tailwind 4 · React (solo el asistente de reservas) · better-auth · Drizzle + SQLite (libSQL).

## Puesta en marcha

```sh
pnpm install
cp .env.example .env        # y cambia BETTER_AUTH_SECRET
pnpm db:migrate             # crea data/barber.db
pnpm db:seed                # datos de ejemplo (borra todo lo existente)
astro dev --background      # http://localhost:4321
```

Usuarios de ejemplo:

| Rol      | Correo                  | Contraseña   |
| -------- | ----------------------- | ------------ |
| Admin    | admin@barberia.test     | admin1234    |
| Barbero  | carlos@barberia.test    | barber1234   |
| Cliente  | cliente@barberia.test   | cliente1234  |

### Variables de entorno

| Variable | Uso |
| --- | --- |
| `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` | Autenticación |
| `DATABASE_URL` | `file:./data/barber.db` en local; una URL `libsql://…` de Turso en producción (+ `DATABASE_AUTH_TOKEN`) |
| `SHOP_TIMEZONE` | Zona horaria de la barbería (p. ej. `America/Bogota`). Las fechas se guardan en UTC |
| `SHOP_CURRENCY` | Moneda para mostrar precios (`COP`, `MXN`, `EUR`…) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Login con Google (opcional; el botón aparece solo si están definidas). Callback: `<BETTER_AUTH_URL>/api/auth/callback/google` |

## Qué incluye

**Público:** landing con servicios, equipo, horario y ocupación de hoy · `/disponibilidad` ocupación por barbero y día · `/agendar` asistente (servicio → barbero o "cualquiera" → fecha → hora) · registro/login con email o Google.

**Cliente:** `/mis-citas` próximas e historial, cancelar y reprogramar hasta *N* horas antes.

**Panel (`/panel`)** — el barbero ve solo su agenda; el admin, todo:
- Agenda diaria: completar, no asistió, cancelar, mover, crear cita manual (cliente por teléfono).
- Clientes: búsqueda, historial, total gastado, notas internas.
- Horarios semanales (con turno partido) y bloqueos / días libres / festivos.
- Solo admin: estadísticas, servicios, barberos (vincular la cuenta de un barbero le da acceso al panel) y ajustes de reservas.

## Estructura

```
src/db/schema.ts         tablas (auth + barbería)
src/lib/availability.ts  cálculo de horarios libres y ocupación
src/lib/booking.ts       crear / reprogramar / cancelar (evita dobles reservas)
src/lib/stats.ts         estadísticas
src/actions/index.ts     todas las mutaciones (Astro Actions)
src/middleware.ts        sesión y protección de rutas por rol
src/pages/               páginas públicas, /mis-citas y /panel
```

## Producción

```sh
pnpm build
pnpm start                  # node --env-file=.env dist/server/entry.mjs
```

La protección contra dobles reservas serializa las escrituras dentro del proceso; ejecuta **una sola instancia** del servidor (o añade un bloqueo en la base de datos si escalas a varias).
