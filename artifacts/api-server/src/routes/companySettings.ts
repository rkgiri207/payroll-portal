import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, companySettingsTable } from "@workspace/db";
import { UpdateCompanySettingsBody } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { createAuditLog } from "../lib/audit";

const router: IRouter = Router();

function formatSettings(s: typeof companySettingsTable.$inferSelect) {
  return {
    id: s.id,
    companyName: s.companyName,
    logoPath: s.logoPath ?? null,
    address: s.address ?? null,
    phone: s.phone ?? null,
    email: s.email ?? null,
    website: s.website ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

router.get("/company-settings", requireAuth, async (req, res): Promise<void> => {
  const [settings] = await db.select().from(companySettingsTable).limit(1);

  if (!settings) {
    res.status(404).json({ error: "Company settings not configured" });
    return;
  }

  res.json(formatSettings(settings));
});

router.patch("/company-settings", requireAuth, async (req, res): Promise<void> => {
  const parsed = UpdateCompanySettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const data = parsed.data;

  // Get existing settings row
  const [existing] = await db.select().from(companySettingsTable).limit(1);

  let settings: typeof companySettingsTable.$inferSelect;

  if (!existing) {
    if (!data.companyName) {
      res.status(400).json({ error: "companyName is required for initial setup" });
      return;
    }
    const [created] = await db
      .insert(companySettingsTable)
      .values({
        companyName: data.companyName,
        logoPath: data.logoPath ?? null,
        address: data.address ?? null,
        phone: data.phone ?? null,
        email: data.email ?? null,
        website: data.website ?? null,
      })
      .returning();
    settings = created;
  } else {
    const updateData: Partial<typeof companySettingsTable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (data.companyName !== undefined) updateData.companyName = data.companyName;
    if (data.logoPath !== undefined) updateData.logoPath = data.logoPath;
    if (data.address !== undefined) updateData.address = data.address;
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.website !== undefined) updateData.website = data.website;

    const [updated] = await db
      .update(companySettingsTable)
      .set(updateData)
      .where(eq(companySettingsTable.id, existing.id))
      .returning();
    settings = updated;
  }

  await createAuditLog({
    action: "COMPANY_SETTINGS_UPDATED",
    entityType: "company_settings",
    entityId: settings.id,
    performedBy: req.session?.userId,
    details: `Settings updated: ${Object.keys(data).join(", ")}`,
  });

  res.json(formatSettings(settings));
});

router.delete("/company-settings/logo", requireAuth, async (req, res): Promise<void> => {
  const [existing] = await db.select().from(companySettingsTable).limit(1);

  if (!existing) {
    res.status(404).json({ error: "Company settings not found" });
    return;
  }

  const [updated] = await db
    .update(companySettingsTable)
    .set({ logoPath: null, updatedAt: new Date() })
    .where(eq(companySettingsTable.id, existing.id))
    .returning();

  await createAuditLog({
    action: "COMPANY_LOGO_REMOVED",
    entityType: "company_settings",
    entityId: existing.id,
    performedBy: req.session?.userId,
    details: "Company logo removed",
  });

  res.json(formatSettings(updated));
});

export default router;
