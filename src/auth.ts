import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { env } from "@/config/env";

// better-auth solo avisa (no falla) con un secreto corto o el del ejemplo.
if (
  import.meta.env.PROD &&
  (!env.BETTER_AUTH_SECRET ||
    env.BETTER_AUTH_SECRET.length < 32 ||
    env.BETTER_AUTH_SECRET.startsWith("cambia-esto"))
)
  throw new Error(
    "BETTER_AUTH_SECRET debe ser un secreto aleatorio de al menos 32 caracteres (openssl rand -base64 32).",
  );

export const googleEnabled = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET,
);

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  emailAndPassword: { enabled: true, minPasswordLength: 8 },
  // En memoria cada instancia serverless llevaría su propia cuenta.
  rateLimit: { storage: "database" },
  socialProviders: googleEnabled
    ? {
        google: {
          clientId: env.GOOGLE_CLIENT_ID!,
          clientSecret: env.GOOGLE_CLIENT_SECRET!,
        },
      }
    : {},
  user: {
    additionalFields: {
      phone: { type: "string", required: false },
    },
  },
  plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] })],
});

export type SessionUser = typeof auth.$Infer.Session.user;
export type Session = typeof auth.$Infer.Session.session;
