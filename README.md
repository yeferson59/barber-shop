# Barbería — reservas y gestión

Web para una barbería con reservas online, vista pública de ocupación y panel de gestión.

**Stack:** Astro 7 (SSR, adapter Vercel) · Tailwind 4 · React (solo el asistente de reservas) · better-auth · Drizzle + SQLite (libSQL).

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
- Solo admin: estadísticas, servicios, barberos (el admin genera un enlace de invitación de un solo uso; el barbero lo abre con su sesión iniciada y su cuenta queda vinculada, sin depender del correo) y ajustes de reservas.

## Estructura

```
src/config/env.ts        variables de entorno
src/db/index.ts          cliente de la BD y transacciones de escritura
src/db/schema/           tablas: auth.ts (better-auth) ← shop.ts (barbería) ← relations.ts
src/lib/availability.ts  cálculo de horarios libres y ocupación
src/lib/booking.ts       crear / reprogramar / cancelar (evita dobles reservas)
src/lib/stats.ts         estadísticas
src/lib/invite.ts        enlaces de un solo uso (barberos y clientes)
src/actions/index.ts     todas las mutaciones (Astro Actions)
src/middleware.ts        sesión y protección de rutas por rol
src/pages/               páginas públicas, /mis-citas y /panel
```

## Producción

Se despliega en Vercel (`@astrojs/vercel`). Cada petición puede ir a una instancia distinta y efímera, así que:

- **La BD tiene que ser remota.** Crea una base en Turso y define en Vercel `DATABASE_URL=libsql://…` y `DATABASE_AUTH_TOKEN`. Con una URL `file:` la app se niega a arrancar en Vercel.
- **Migra antes de desplegar:** `DATABASE_URL=libsql://… DATABASE_AUTH_TOKEN=… pnpm db:migrate`.
- Define también `BETTER_AUTH_SECRET` (≥ 32 caracteres), `BETTER_AUTH_URL` (la URL pública), `SHOP_TIMEZONE` y `SHOP_CURRENCY`.

Las reservas comprueban disponibilidad y escriben dentro de una transacción `BEGIN IMMEDIATE`, que la BD serializa entre instancias, y el límite de peticiones del login se guarda en la tabla `rate_limit`; ninguno depende de la memoria del proceso.
