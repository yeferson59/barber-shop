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

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  if (pathname.startsWith("/api/auth")) return next();

  const { user } = await loadSession(context.locals, context.request.headers);

  if (startsWith(pathname, needsLogin) && !user) {
    return context.redirect(
      `/login?next=${encodeURIComponent(pathname + context.url.search)}`,
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
