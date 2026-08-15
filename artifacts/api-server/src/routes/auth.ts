import { Router, type IRouter } from "express";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { LoginBody } from "@workspace/api-zod";
import { createAuditLog } from "../lib/audit";

const router: IRouter = Router();

function getDatabaseErrorDetails(error: unknown): {
  errorName: string;
  postgresCode?: string;
  sanitizedMessage: string;
} {
  let current = error;

  while (
    current instanceof Error &&
    "cause" in current &&
    current.cause instanceof Error
  ) {
    current = current.cause;
  }

  const record = current as { name?: unknown; code?: unknown; message?: unknown };
  const message =
    typeof record?.message === "string" ? record.message : "Unknown database error";

  return {
    errorName: typeof record?.name === "string" ? record.name : "UnknownError",
    ...(typeof record?.code === "string" ? { postgresCode: record.code } : {}),
    sanitizedMessage: message
      .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[REDACTED_DATABASE_URL]")
      .replace(/(password\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]"),
  };
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }

  const { email, password } = parsed.data;

  // Look up user — do not reveal whether email exists
  let user;
  try {
    [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email.toLowerCase().trim()))
      .limit(1);
  } catch (error) {
    req.log.error(
      {
        operation: "auth.login.users_lookup",
        ...getDatabaseErrorDetails(error),
      },
      "Database operation failed",
    );
    throw error;
  }

  const invalidMsg = "Invalid email or password";

  if (!user || !user.isActive) {
    // Still run bcrypt to prevent timing attacks
    await bcrypt.compare(password, "$2b$10$invalidhashplaceholderXXXXXXXXXXXXXXXXXXXXXXXXX");
    res.status(401).json({ error: invalidMsg });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: invalidMsg });
    return;
  }

  // Establish session
  req.session.userId = user.id;
  req.session.userRole = user.role;

  // Update last login
  await db
    .update(usersTable)
    .set({ lastLoginAt: new Date() })
    .where(eq(usersTable.id, user.id));

  await createAuditLog({
    action: "LOGIN",
    entityType: "user",
    entityId: user.id,
    performedBy: user.id,
    details: `User ${user.email} logged in`,
  });

  req.log.info({ userId: user.id }, "User logged in");

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  });
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const userId = req.session?.userId;

  req.session.destroy((err) => {
    if (err) {
      req.log.error({ err }, "Failed to destroy session");
    }
  });

  if (userId) {
    await createAuditLog({
      action: "LOGOUT",
      entityType: "user",
      entityId: userId,
      performedBy: userId,
      details: "User logged out",
    });
  }

  res.clearCookie("payroll.sid");
  res.json({ success: true });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [user] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
    })
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId))
    .limit(1);

  if (!user || !user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  res.json(user);
});

export default router;
