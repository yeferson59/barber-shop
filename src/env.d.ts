declare namespace App {
  interface Locals {
    user: import("./auth").SessionUser | null;
    session: import("./auth").Session | null;
    /** Barbero vinculado al usuario (si tiene rol barber). */
    barberId: string | null;
  }
}
