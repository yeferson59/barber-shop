import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shopSettings } from "@/db/schema";

export type ShopSettings = typeof shopSettings.$inferSelect;

export async function getSettings(): Promise<ShopSettings> {
  const row = await db.query.shopSettings.findFirst({
    where: eq(shopSettings.id, 1),
  });
  if (row) return row;
  const [created] = await db
    .insert(shopSettings)
    .values({ id: 1 })
    .onConflictDoNothing()
    .returning();
  return created ?? (await getSettings());
}
