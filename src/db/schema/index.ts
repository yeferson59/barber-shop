// Punto de entrada único de las tablas: importa siempre desde "@/db/schema".
// Dependencias en un solo sentido: columns ← auth ← shop ← relations.
export * from "./auth";
export * from "./shop";
export * from "./relations";
