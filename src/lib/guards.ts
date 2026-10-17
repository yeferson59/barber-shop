import { ActionError, type ActionAPIContext } from "astro:actions";

export function requireUser(ctx: ActionAPIContext) {
  const user = ctx.locals.user;
  if (!user) throw new ActionError({ code: "UNAUTHORIZED", message: "Inicia sesión para continuar." });
  return user;
}

export function requireStaff(ctx: ActionAPIContext) {
  const user = requireUser(ctx);
  if (user.role !== "admin" && user.role !== "barber")
    throw new ActionError({ code: "FORBIDDEN", message: "No tienes permiso." });
  return { user, isAdmin: user.role === "admin", barberId: ctx.locals.barberId };
}

export function requireAdmin(ctx: ActionAPIContext) {
  const staff = requireStaff(ctx);
  if (!staff.isAdmin) throw new ActionError({ code: "FORBIDDEN", message: "Solo el administrador." });
  return staff;
}

/** Un barbero solo puede gestionar su propia agenda; el admin, cualquiera. */
export function assertBarberScope(ctx: ActionAPIContext, barberId: string) {
  const staff = requireStaff(ctx);
  if (!staff.isAdmin && staff.barberId !== barberId)
    throw new ActionError({ code: "FORBIDDEN", message: "Solo puedes gestionar tu propia agenda." });
  return staff;
}
