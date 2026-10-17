import { defineMiddleware } from "astro:middleware";
import { loadSession } from "@/lib/session";

const needsLogin = ["/mis-citas", "/panel"];
const adminOnly = [
  "/panel/servicios",
  "/panel/barberos",
  "/panel/estadisticas",
  "/panel/ajustes",
];

const startsWith = (path: string, prefixes: string[]) =>
  prefixes.some((p) => path === p || path.startsWith(p + "/"));

/**
 * Ruta tal como la enruta Astro (decodificada y sin barras duplicadas), para
 * que `/%70anel` o `//panel` no se salten las comprobaciones. `null` si la
 * codificación es inválida.
 */
function normalize(pathname: string): string | null {
  let path = pathname;
  for (let i = 0; i < 5; i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return null;
    }
    if (decoded === path) break;
    path = decoded;
  }
  return path.replace(/\/{2,}/g, "/");
}

export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = normalize(context.url.pathname);
  if (pathname === null) return new Response("Bad Request", { status: 400 });
  if (startsWith(pathname, ["/api/auth"])) return next();

  const { user } = await loadSession(context.locals, context.request.headers);

  if (startsWith(pathname, needsLogin) && !user) {
    return context.redirect(
      `/login?next=${encodeURIComponent(context.url.pathname + context.url.search)}`,
    );
  }
  if (
    startsWith(pathname, ["/panel"]) &&
    user?.role !== "admin" &&
    user?.role !== "barber"
  ) {
    return context.redirect("/");
  }
  if (startsWith(pathname, adminOnly) && user?.role !== "admin") {
    return context.redirect("/panel");
  }
  return next();
});
