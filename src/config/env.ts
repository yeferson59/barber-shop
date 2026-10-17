// En desarrollo Astro/Vite expone `.env` en `import.meta.env`; en producción y en
// scripts (seed, drizzle-kit) se leen de `process.env`, que tiene prioridad.
export const env: Record<string, string | undefined> = {
  ...(import.meta.env ?? {}),
  ...process.env,
};
