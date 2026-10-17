import { actions } from "astro:actions";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface WizardService {
  id: string;
  name: string;
  description: string | null;
  durationMin: number;
  price: string;
}

export interface WizardBarber {
  id: string;
  name: string;
  photoUrl: string | null;
  serviceIds: string[];
}

export interface WizardDay {
  date: string;
  weekday: string;
  day: string;
  month: string;
  /** "viernes 16 de octubre" */
  long: string;
  /** Ningún barbero trabaja ese día de la semana */
  closed: boolean;
}

interface Slot {
  time: string;
  startsAt: string;
  barberIds: string[];
}

interface Props {
  services: WizardService[];
  barbers: WizardBarber[];
  days: WizardDay[];
  loggedIn: boolean;
  initial?: { serviceId?: string; barberId?: string; date?: string; time?: string };
  /** Reprogramar una cita existente (servicio fijo). */
  reschedule?: { appointmentId: string; serviceId: string; barberId: string };
}

const initials = (name: string) =>
  name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");

function Monogram({ name, photoUrl, size = "h-11 w-11 text-lg" }: { name: string; photoUrl: string | null; size?: string }) {
  return photoUrl ? (
    <img src={photoUrl} alt="" className={`${size} shrink-0 rounded object-cover`} />
  ) : (
    <span className={`${size} flex shrink-0 items-center justify-center rounded bg-botella font-display text-loza`}>{initials(name)}</span>
  );
}

function Radio({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${checked ? "border-botella" : "border-junta"}`}
    >
      {checked && <span className="h-2.5 w-2.5 rounded-full bg-botella" />}
    </span>
  );
}

function Step({
  n,
  title,
  done,
  summary,
  onChange,
  children,
}: {
  n: number;
  title: string;
  done: boolean;
  summary?: ReactNode;
  onChange?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-junta py-6 first:border-t-0 first:pt-0">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="flex items-baseline gap-3 text-2xl">
          <span className={`font-sans text-base font-bold ${done ? "text-cromo" : "text-poste"}`}>{n}</span>
          {title}
        </h2>
        {done && onChange && (
          <button type="button" onClick={onChange} className="link text-sm">
            Cambiar
          </button>
        )}
      </div>
      {done && summary ? <div className="mt-2 pl-7 text-botella-2">{summary}</div> : <div className="mt-4">{children}</div>}
    </section>
  );
}

export default function BookingWizard({ services, barbers, days, loggedIn, initial = {}, reschedule }: Props) {
  const [serviceId, setServiceId] = useState(reschedule?.serviceId ?? initial.serviceId ?? "");
  const [barberId, setBarberId] = useState(reschedule?.barberId ?? initial.barberId ?? "");
  const [editing, setEditing] = useState<"service" | "barber" | null>(null);
  const [date, setDate] = useState(initial.date && days.some((d) => d.date === initial.date) ? initial.date : "");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dayOffset, setDayOffset] = useState(() => {
    const i = days.findIndex((d) => d.date === initial.date);
    return i > 0 ? Math.floor(i / 7) * 7 : 0;
  });
  // Hora elegida antes de iniciar sesión, para restaurarla al volver
  const pendingTime = useRef(initial.time);
  const summaryRef = useRef<HTMLElement>(null);

  const service = services.find((s) => s.id === serviceId);
  const availableBarbers = useMemo(() => barbers.filter((b) => b.serviceIds.includes(serviceId)), [barbers, serviceId]);
  const barberName = (id: string) => barbers.find((b) => b.id === id)?.name ?? "";
  const day = days.find((d) => d.date === date);

  // Si el barbero preseleccionado no hace el servicio, se pasa a "cualquiera"
  useEffect(() => {
    if (barberId && barberId !== "any" && serviceId && !availableBarbers.some((b) => b.id === barberId)) {
      setBarberId("any");
    }
  }, [serviceId, availableBarbers, barberId]);

  // Elegir el primer día por defecto
  useEffect(() => {
    if (barberId && !date && days.length) setDate((days.find((d) => !d.closed) ?? days[0]).date);
  }, [barberId]);

  function loadSlots() {
    if (!serviceId || !barberId || !date) {
      setSlots(null);
      return;
    }
    const ctrl = new AbortController();
    setLoadingSlots(true);
    const params = new URLSearchParams({ serviceId, barberId, date });
    if (reschedule) params.set("exclude", reschedule.appointmentId);
    fetch(`/api/slots?${params}`, { signal: ctrl.signal })
      .then((r) => r.json())
      .then((data: { slots: Slot[] }) => {
        setSlots(data.slots);
        if (pendingTime.current) {
          const found = data.slots.find((s) => s.time === pendingTime.current);
          if (found) setSlot(found);
          pendingTime.current = undefined;
        }
      })
      .catch(() => {})
      .finally(() => setLoadingSlots(false));
    return () => ctrl.abort();
  }

  useEffect(loadSlots, [serviceId, barberId, date]);

  async function confirm() {
    if (!service || !slot) return;
    setError(null);
    if (!loggedIn) {
      const back = new URLSearchParams({ service: service.id, barber: barberId, date, time: slot.time });
      window.location.href = `/login?next=${encodeURIComponent(`/agendar?${back}`)}`;
      return;
    }
    setSubmitting(true);
    const result = reschedule
      ? await actions.booking.reschedule({ id: reschedule.appointmentId, barberId, startsAt: slot.startsAt })
      : await actions.booking.create({ serviceId: service.id, barberId, startsAt: slot.startsAt, notes: notes || undefined });
    setSubmitting(false);
    if (result.error) {
      setError(result.error.message);
      // El horario pudo ocuparse mientras tanto: refrescar
      setSlot(null);
      loadSlots();
      return;
    }
    window.location.href = reschedule ? "/mis-citas?ok=reprogramada" : "/mis-citas?ok=nueva";
  }

  const visibleDays = days.slice(dayOffset, dayOffset + 7);
  const groups = useMemo(() => {
    const g: [string, Slot[]][] = [
      ["Mañana", []],
      ["Tarde", []],
      ["Noche", []],
    ];
    for (const s of slots ?? []) {
      const h = Number(s.time.slice(0, 2));
      g[h < 12 ? 0 : h < 18 ? 1 : 2][1].push(s);
    }
    return g.filter(([, v]) => v.length);
  }, [slots]);

  const serviceDone = Boolean(service) && editing !== "service";
  const barberDone = Boolean(barberId) && editing !== "barber";
  const assigned =
    barberId === "any" ? (slot?.barberIds.length === 1 ? barberName(slot.barberIds[0]) : "El primero que esté libre") : barberName(barberId);
  const cta = submitting ? "Guardando…" : !loggedIn ? "Entrar y confirmar" : reschedule ? "Cambiar la cita" : "Confirmar cita";

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_22rem] lg:gap-12">
      <div className="rounded-xl border border-junta bg-loza p-4 sm:p-7">
        {!reschedule && (
          <Step
            n={1}
            title="Servicio"
            done={serviceDone}
            onChange={() => setEditing("service")}
            summary={service && `${service.name}, ${service.price}, ${service.durationMin} min`}
          >
            <ul className="divide-y divide-junta border-y border-junta" role="radiogroup" aria-label="Servicio">
              {services.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={s.id === serviceId}
                    onClick={() => {
                      setServiceId(s.id);
                      setSlot(null);
                      setEditing(null);
                    }}
                    className="flex w-full items-start gap-3 py-4 text-left hover:bg-azulejo/50"
                  >
                    <span className="pt-0.5">
                      <Radio checked={s.id === serviceId} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-3">
                        <span className="font-semibold">{s.name}</span>
                        <span className="font-display tabular-nums">{s.price}</span>
                      </span>
                      <span className="mt-0.5 flex justify-between gap-3 text-sm text-cromo">
                        <span>{s.description}</span>
                        <span className="shrink-0">{s.durationMin} min</span>
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Step>
        )}

        {service && (
          <Step
            n={reschedule ? 1 : 2}
            title="Barbero"
            done={barberDone}
            onChange={() => setEditing("barber")}
            summary={barberId === "any" ? "El primero que esté libre" : barberName(barberId)}
          >
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Barbero">
              {[{ id: "any", name: "El primero que esté libre", photoUrl: null }, ...availableBarbers].map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="radio"
                  aria-checked={b.id === barberId}
                  onClick={() => {
                    setBarberId(b.id);
                    setSlot(null);
                    setEditing(null);
                  }}
                  className={`flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                    b.id === barberId ? "border-botella bg-azulejo" : "border-junta hover:border-botella"
                  }`}
                >
                  {b.id === "any" ? (
                    <span className="grid h-11 w-11 shrink-0 grid-cols-2 gap-0.5 rounded p-1.5 ring-1 ring-junta" aria-hidden="true">
                      <span className="rounded-sm bg-botella" />
                      <span className="rounded-sm bg-loza ring-1 ring-junta" />
                      <span className="rounded-sm bg-loza ring-1 ring-junta" />
                      <span className="rounded-sm bg-botella" />
                    </span>
                  ) : (
                    <Monogram name={b.name} photoUrl={b.photoUrl} />
                  )}
                  <span>
                    <span className="block font-semibold">{b.name}</span>
                    {b.id === "any" && <span className="block text-sm text-cromo">Más horas para elegir</span>}
                  </span>
                </button>
              ))}
            </div>
          </Step>
        )}

        {service && barberId && (
          <Step n={reschedule ? 2 : 3} title={reschedule ? "Nuevo día y hora" : "Día y hora"} done={false}>
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                className="btn-ghost px-2.5"
                disabled={dayOffset === 0}
                onClick={() => setDayOffset((o) => Math.max(0, o - 7))}
                aria-label="Días anteriores"
              >
                ‹
              </button>
              <div className="grid flex-1 grid-cols-7 gap-1">
                {visibleDays.map((d) => (
                  <button
                    key={d.date}
                    type="button"
                    aria-pressed={d.date === date}
                    aria-label={d.closed ? `${d.long}, cerrado` : d.long}
                    disabled={d.closed}
                    onClick={() => {
                      setDate(d.date);
                      setSlot(null);
                    }}
                    className={`rounded-md border px-0.5 py-2 text-center transition-colors ${
                      d.date === date
                        ? "border-botella bg-botella text-loza"
                        : d.closed
                          ? "border-transparent text-cromo/60 line-through"
                          : "border-junta bg-loza hover:border-botella"
                    }`}
                  >
                    <span className="block text-[11px] leading-tight sm:text-xs">{d.weekday}</span>
                    <span className="block font-display text-lg leading-tight sm:text-xl">{d.day}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn-ghost px-2.5"
                disabled={dayOffset + 7 >= days.length}
                onClick={() => setDayOffset((o) => o + 7)}
                aria-label="Días siguientes"
              >
                ›
              </button>
            </div>

            <div className="mt-6 min-h-28" aria-live="polite">
              {loadingSlots && <p className="text-cromo">Buscando horas libres…</p>}
              {!loadingSlots && slots && slots.length === 0 && (
                <p className="rounded-md bg-azulejo px-4 py-4 text-botella-2">
                  No quedan horas libres {day ? `el ${day.long}` : "este día"}. Prueba otro día
                  {barberId !== "any" ? " o cambia a «El primero que esté libre»" : ""}.
                </p>
              )}
              {!loadingSlots &&
                groups.map(([label, list]) => (
                  <div key={label} className="mb-5 last:mb-0">
                    <p className="mb-2 text-sm font-semibold text-cromo">{label}</p>
                    <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6">
                      {list.map((s) => (
                        <button
                          key={s.startsAt}
                          type="button"
                          aria-pressed={slot?.startsAt === s.startsAt}
                          onClick={() => setSlot(s)}
                          className={`rounded-md border py-2.5 text-[15px] font-semibold transition-colors ${
                            slot?.startsAt === s.startsAt
                              ? "border-botella bg-botella text-loza"
                              : "border-junta bg-loza hover:border-botella"
                          }`}
                        >
                          {s.time}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
            </div>
          </Step>
        )}
      </div>

      {/* Resumen */}
      <aside ref={summaryRef} id="resumen" className="scroll-mt-24 lg:sticky lg:top-24 lg:self-start">
        <div className="rounded-xl bg-botella p-6 text-loza">
          <h2 className="text-2xl">Tu cita</h2>
          {!service ? (
            <p className="mt-3 text-azulejo/75">Elige un servicio para empezar.</p>
          ) : (
            <dl className="mt-4 space-y-3">
              <div>
                <dt className="text-sm text-azulejo/70">Servicio</dt>
                <dd className="font-semibold">{service.name}</dd>
              </div>
              {barberId && (
                <div>
                  <dt className="text-sm text-azulejo/70">Con</dt>
                  <dd className="font-semibold">{assigned}</dd>
                </div>
              )}
              {slot && day && (
                <div>
                  <dt className="text-sm text-azulejo/70">Cuándo</dt>
                  <dd>
                    <span className="block font-display text-3xl leading-tight">{slot.time}</span>
                    <span className="first-letter:uppercase">{day.long}</span>
                  </dd>
                </div>
              )}
              <div className="flex items-baseline justify-between border-t border-white/15 pt-3">
                <dt className="text-sm text-azulejo/70">{service.durationMin} min</dt>
                <dd className="font-display text-2xl tabular-nums">{service.price}</dd>
              </div>
            </dl>
          )}

          {slot && !reschedule && (
            <div className="mt-5">
              <label className="mb-1.5 block text-sm text-azulejo/80" htmlFor="notes">
                Algo que debamos saber (opcional)
              </label>
              <textarea
                id="notes"
                className="block w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-[15px] text-loza placeholder:text-azulejo/40 focus:border-loza focus:outline-none"
                rows={2}
                maxLength={500}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Ej.: degradado bajo, traigo foto"
              />
            </div>
          )}

          {error && <p className="mt-4 rounded-md bg-loza px-3 py-2 text-sm text-poste-2">{error}</p>}

          <button
            type="button"
            className="btn-primary mt-6 w-full py-3.5 text-base disabled:bg-white/10 disabled:text-azulejo/50 disabled:opacity-100"
            disabled={!slot || submitting}
            onClick={confirm}
          >
            {cta}
          </button>
          {!loggedIn && slot && (
            <p className="mt-2 text-center text-sm text-azulejo/70">Te pediremos entrar o crear cuenta. No perderás lo elegido.</p>
          )}
        </div>
      </aside>

      {/* Barra inferior en móvil */}
      {slot && day && (
        <div className="fixed inset-x-0 bottom-0 z-20 flex items-center justify-between gap-3 border-t border-junta bg-loza px-4 py-3 lg:hidden">
          <p className="text-sm leading-tight">
            <span className="block font-semibold">{slot.time}</span>
            <span className="text-cromo first-letter:uppercase">{day.long}</span>
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              summaryRef.current?.scrollIntoView({
                behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
                block: "start",
              })
            }
          >
            Revisar y confirmar
          </button>
        </div>
      )}
    </div>
  );
}
