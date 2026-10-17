import type { BarberOccupancy, DayOccupancy } from "./availability";
import { minutesToHHMM } from "./time";

export type TileState = "free" | "busy" | "off" | "closed";

export interface Tile {
  start: number;
  end: number;
  state: TileState;
  past: boolean;
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Primer y último minuto trabajado por cualquier barbero, para alinear todas las filas. */
export function dayRangeOf(barbers: BarberOccupancy[]) {
  const hours = barbers.flatMap((b) => b.days.flatMap((d) => d.hours));
  if (hours.length === 0) return { open: 9 * 60, close: 19 * 60 };
  const floor30 = (m: number) => Math.floor(m / 30) * 30;
  const ceil30 = (m: number) => Math.ceil(m / 30) * 30;
  return {
    open: floor30(Math.min(...hours.map((h) => h.start))),
    close: ceil30(Math.max(...hours.map((h) => h.end))),
  };
}

/** Divide el día en azulejos de `step` minutos. Un azulejo toma el estado que ocupa la mayor parte. */
export function toTiles(
  day: DayOccupancy,
  range: { open: number; close: number },
  nowMin: number | null,
  step = 30,
): Tile[] {
  const tiles: Tile[] = [];
  for (let start = range.open; start < range.close; start += step) {
    const t = { start, end: start + step };
    const working = day.hours.reduce((n, h) => n + overlap(t, h), 0);
    const busy = day.blocks.filter((b) => b.kind === "busy").reduce((n, b) => n + overlap(t, b), 0);
    const off = day.blocks.filter((b) => b.kind === "off").reduce((n, b) => n + overlap(t, b), 0);

    let state: TileState = "free";
    if (working < step / 2) state = "closed";
    else if (off >= step / 2) state = "off";
    else if (busy >= step / 2 || busy + off >= step / 2) state = "busy";

    tiles.push({ ...t, state, past: nowMin !== null && t.end <= nowMin });
  }
  return tiles;
}

export interface LiveStatus {
  /** Para el color del indicador */
  tone: "free" | "busy" | "closed";
  text: string;
}

/** Estado actual de un barbero en una frase. */
export function liveStatus(day: DayOccupancy, nowMin: number): LiveStatus {
  const { hours, blocks } = day;
  if (hours.length === 0) return { tone: "closed", text: "Hoy no trabaja" };

  const first = hours[0];
  const last = hours[hours.length - 1];
  if (nowMin < first.start) return { tone: "closed", text: `Empieza a las ${minutesToHHMM(first.start)}` };
  if (nowMin >= last.end) return { tone: "closed", text: "Ya terminó por hoy" };

  const shift = hours.find((h) => h.start <= nowMin && nowMin < h.end);
  if (!shift) {
    const next = hours.find((h) => h.start > nowMin)!;
    return { tone: "closed", text: `En descanso, vuelve a las ${minutesToHHMM(next.start)}` };
  }

  const current = blocks.find((b) => b.start <= nowMin && nowMin < b.end);
  if (current) {
    // Encadena bloques seguidos para decir cuándo queda libre de verdad
    let end = current.end;
    for (const b of blocks) if (b.start <= end && b.end > end) end = b.end;
    if (end >= shift.end) {
      const later = hours.find((h) => h.start >= shift.end);
      return {
        tone: "busy",
        text: later ? `Ocupado hasta su descanso` : "Ocupado hasta el cierre",
      };
    }
    return {
      tone: "busy",
      text: current.kind === "off" ? `No disponible hasta las ${minutesToHHMM(end)}` : `Atendiendo hasta las ${minutesToHHMM(end)}`,
    };
  }

  const nextBlock = blocks.find((b) => b.start > nowMin && b.start < shift.end);
  const freeUntil = nextBlock ? nextBlock.start : shift.end;
  const minutes = freeUntil - nowMin;
  if (minutes < 30) return { tone: "busy", text: `Libre solo hasta las ${minutesToHHMM(freeUntil)}` };
  return { tone: "free", text: `Libre hasta las ${minutesToHHMM(freeUntil)}` };
}

/** Minutos libres que quedan en el día (ignorando lo ya pasado). */
export function freeMinutesLeft(tiles: Tile[]) {
  return tiles.filter((t) => t.state === "free" && !t.past).reduce((n, t) => n + (t.end - t.start), 0);
}
