import { TZDate, tz } from "@date-fns/tz";
import { addDays, format } from "date-fns";
import { es } from "date-fns/locale";
import { env } from "./env";

export const SHOP_TZ = env.SHOP_TIMEZONE || "America/Bogota";

/** Fecha local de la barbería en formato YYYY-MM-DD. */
export type DateStr = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateStr(value: string): value is DateStr {
  return DATE_RE.test(value);
}

function parts(date: DateStr) {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
}

/** Instante (UTC) correspondiente a `date` + `minutes` en la zona horaria de la barbería. */
export function atLocal(date: DateStr, minutes = 0): Date {
  const { y, m, d } = parts(date);
  const local = new TZDate(y, m - 1, d, 0, minutes, 0, SHOP_TZ);
  return new Date(local.getTime());
}

/** [inicio, fin) del día local. */
export function dayRange(date: DateStr): { start: Date; end: Date } {
  return { start: atLocal(date), end: atLocal(addDaysStr(date, 1)) };
}

/** 0 = domingo … 6 = sábado. */
export function weekdayOf(date: DateStr): number {
  const { y, m, d } = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function addDaysStr(date: DateStr, days: number): DateStr {
  const { y, m, d } = parts(date);
  return format(addDays(new Date(y, m - 1, d), days), "yyyy-MM-dd");
}

export function toDateStr(instant: Date): DateStr {
  return format(instant, "yyyy-MM-dd", { in: tz(SHOP_TZ) });
}

export function todayStr(): DateStr {
  return toDateStr(new Date());
}

/** Minutos desde medianoche local de un instante. */
export function minutesOfDay(instant: Date): number {
  const local = new TZDate(instant.getTime(), SHOP_TZ);
  return local.getHours() * 60 + local.getMinutes();
}

export function fmt(instant: Date, pattern: string): string {
  return format(instant, pattern, { in: tz(SHOP_TZ), locale: es });
}

export const fmtTime = (d: Date) => fmt(d, "HH:mm");
export const fmtDate = (d: Date) => fmt(d, "EEEE d 'de' MMMM");
export const fmtDateTime = (d: Date) => fmt(d, "EEE d MMM, HH:mm");

export function fmtDateStr(date: DateStr, pattern = "EEEE d 'de' MMMM"): string {
  return fmt(atLocal(date, 12 * 60), pattern);
}

/** Primera letra en mayúscula ("viernes 16 de octubre" → "Viernes 16 de octubre"). */
export const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function minutesToHHMM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(":").map(Number);
  return h * 60 + (m || 0);
}

export const WEEKDAYS = [
  "Domingo",
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
];

export function formatPrice(cents: number): string {
  return new Intl.NumberFormat(env.SHOP_LOCALE || "es-CO", {
    style: "currency",
    currency: env.SHOP_CURRENCY || "COP",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}
