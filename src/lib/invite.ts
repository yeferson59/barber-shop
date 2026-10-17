import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, like } from "drizzle-orm";
import { db } from "@/db";
import { account, barber, user, verification } from "@/db/schema";

// Enlaces de un solo uso que el equipo pasa en mano (WhatsApp…), sin depender
// de enviar ni verificar correos: un barbero vincula su cuenta y un cliente
// creado desde el panel activa la suya.

const INVITE_DAYS = 7;
const TOKEN_RE = /^[\w-]{1,100}$/;

export const hashInvite = (token: string) =>
  createHash("sha256").update(token).digest("hex");

/** Token para /unirse/<token>; en la BD solo se guarda su hash. */
export function newInvite() {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    hash: hashInvite(token),
    expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
  };
}

/** Barbero con una invitación vigente para ese token. */
export function findInvite(token: string) {
  if (!TOKEN_RE.test(token)) return Promise.resolve(undefined);
  return db.query.barber.findFirst({
    where: and(
      eq(barber.inviteHash, hashInvite(token)),
      gt(barber.inviteExpiresAt, new Date()),
    ),
  });
}

// ---------------------------------------------------------------------------
// Clientes creados desde el panel: no tienen contraseña ni, a veces, correo.
// Su invitación va en la tabla `verification` de better-auth con prefijo propio.
// ---------------------------------------------------------------------------

const CLIENT_PREFIX = "activar-cliente:";
export const clientInviteId = (token: string) =>
  CLIENT_PREFIX + hashInvite(token);

/** Correo inventado para clientes que se crearon sin él. */
export const isPlaceholderEmail = (email: string) =>
  email.endsWith("@clientes.local");

/** Si la cuenta puede entrar en la web (contraseña o Google). */
export async function hasLogin(userId: string) {
  const row = await db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.userId, userId))
    .get();
  return Boolean(row);
}

/** Enlace para /activar/<token>; uno nuevo invalida el anterior. */
export async function createClientInvite(userId: string) {
  const { token, hash, expiresAt } = newInvite();
  await db.batch([
    db
      .delete(verification)
      .where(
        and(
          eq(verification.value, userId),
          like(verification.identifier, `${CLIENT_PREFIX}%`),
        ),
      ),
    db.insert(verification).values({
      id: crypto.randomUUID(),
      identifier: CLIENT_PREFIX + hash,
      value: userId,
      expiresAt,
    }),
  ]);
  return { token, expiresAt };
}

/** Cliente sin acceso a la web con una invitación vigente para ese token. */
export async function findClientInvite(token: string) {
  if (!TOKEN_RE.test(token)) return undefined;
  const row = await db.query.verification.findFirst({
    where: and(
      eq(verification.identifier, clientInviteId(token)),
      gt(verification.expiresAt, new Date()),
    ),
  });
  if (!row) return undefined;
  const client = await db.query.user.findFirst({
    where: and(eq(user.id, row.value), eq(user.role, "user")),
  });
  if (!client || (await hasLogin(client.id))) return undefined;
  return client;
}
