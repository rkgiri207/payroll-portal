import { Router, type IRouter, type Request, type Response } from 'express';
import { db } from '@workspace/db';
import { employeesTable } from '@workspace/db/schema';
import { eq, ilike, or, and, count, sql } from 'drizzle-orm';
import { requireAuth } from '../middlewares/requireAuth';
import { createAuditLog } from '../lib/audit';

const router: IRouter = Router();

// ─── List employees ──────────────────────────────────────────────────────────
router.get('/employees', requireAuth, async (req: Request, res: Response) => {
  const search = (req.query.search as string) || '';
  const branch = (req.query.branch as string) || '';
  const status = (req.query.status as string) || '';
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10)));
  const offset = (page - 1) * limit;

  const conditions = [];

  if (search) {
    conditions.push(
      or(
        ilike(employeesTable.employeeName, `%${search}%`),
        ilike(employeesTable.employeeCode, `%${search}%`),
        ilike(employeesTable.designation, `%${search}%`),
      ),
    );
  }

  if (branch) {
    conditions.push(eq(employeesTable.branch, branch));
  }

  if (status === 'ACTIVE' || status === 'INACTIVE') {
    conditions.push(eq(employeesTable.status, status));
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [employees, [{ total }]] = await Promise.all([
    db
      .select()
      .from(employeesTable)
      .where(where)
      .orderBy(employeesTable.employeeCode)
      .limit(limit)
      .offset(offset),
    db
      .select({ total: count() })
      .from(employeesTable)
      .where(where),
  ]);

  res.json({ employees, total: Number(total), page, limit });
});

// ─── Create employee ─────────────────────────────────────────────────────────
router.post('/employees', requireAuth, async (req: Request, res: Response) => {
  const { employeeCode, employeeName, mobileNumber, email, designation, branch, joiningDate, status } = req.body;

  if (!employeeCode || !employeeName) {
    res.status(400).json({ error: 'Employee code and name are required' });
    return;
  }

  // Validate mobile number format if provided
  if (mobileNumber && !/^\+?[\d\s\-()]{7,20}$/.test(mobileNumber)) {
    res.status(400).json({ error: 'Invalid mobile number format' });
    return;
  }

  // Validate email format if provided (without format: email since it's in Zod v3 context)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Invalid email format' });
    return;
  }

  // Normalize mobile: strip non-digit characters for storage if provided
  const normalizedMobile = mobileNumber
    ? mobileNumber.replace(/[^\d+]/g, '') // keep digits and leading +
    : null;

  try {
    const [employee] = await db
      .insert(employeesTable)
      .values({
        employeeCode: employeeCode.trim(),
        employeeName: employeeName.trim(),
        mobileNumber: normalizedMobile,
        email: email?.trim() || null,
        designation: designation?.trim() || null,
        branch: branch?.trim() || null,
        joiningDate: joiningDate || null,
        status: status || 'ACTIVE',
      })
      .returning();

    await createAuditLog({
      action: 'EMPLOYEE_CREATED',
      entityType: 'employee',
      entityId: employee.id,
      performedBy: req.session.userId!,
      details: `Employee ${employee.employeeCode} - ${employee.employeeName} created`,
    });

    res.status(201).json(employee);
  } catch (err: any) {
    const detail = String(err?.detail ?? err?.message ?? '');
    if (err?.code === '23505' || detail.includes('unique') || detail.includes('employee_code')) {
      res.status(409).json({ error: `Employee code "${employeeCode}" already exists` });
      return;
    }
    req.log.error({ err }, 'Error creating employee');
    res.status(500).json({ error: 'Failed to create employee' });
  }
});

// ─── Get employee ─────────────────────────────────────────────────────────────
router.get('/employees/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid employee ID' });
    return;
  }

  const [employee] = await db
    .select()
    .from(employeesTable)
    .where(eq(employeesTable.id, id));

  if (!employee) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  res.json(employee);
});

// ─── Update employee ──────────────────────────────────────────────────────────
router.patch('/employees/:id', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid employee ID' });
    return;
  }

  const { employeeCode, employeeName, mobileNumber, email, designation, branch, joiningDate } = req.body;

  // Validate if provided
  if (employeeName !== undefined && !employeeName?.trim()) {
    res.status(400).json({ error: 'Employee name cannot be empty' });
    return;
  }

  if (mobileNumber !== undefined && mobileNumber !== null && !/^\+?[\d\s\-()]{7,20}$/.test(mobileNumber)) {
    res.status(400).json({ error: 'Invalid mobile number format' });
    return;
  }

  if (email !== undefined && email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Invalid email format' });
    return;
  }

  const updates: Record<string, any> = {};
  if (employeeCode !== undefined) updates.employeeCode = employeeCode.trim();
  if (employeeName !== undefined) updates.employeeName = employeeName.trim();
  if (mobileNumber !== undefined) {
    updates.mobileNumber = mobileNumber
      ? mobileNumber.replace(/[^\d+]/g, '')
      : null;
  }
  if (email !== undefined) updates.email = email?.trim() || null;
  if (designation !== undefined) updates.designation = designation?.trim() || null;
  if (branch !== undefined) updates.branch = branch?.trim() || null;
  if (joiningDate !== undefined) updates.joiningDate = joiningDate || null;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: 'No fields to update' });
    return;
  }

  try {
    const [employee] = await db
      .update(employeesTable)
      .set(updates)
      .where(eq(employeesTable.id, id))
      .returning();

    if (!employee) {
      res.status(404).json({ error: 'Employee not found' });
      return;
    }

    await createAuditLog({
      action: 'EMPLOYEE_UPDATED',
      entityType: 'employee',
      entityId: employee.id,
      performedBy: req.session.userId!,
      details: `Employee ${employee.employeeCode} updated`,
    });

    res.json(employee);
  } catch (err: any) {
    const detail = String(err?.detail ?? err?.message ?? '');
    if (err?.code === '23505' || detail.includes('unique') || detail.includes('employee_code')) {
      res.status(409).json({ error: `Employee code "${employeeCode}" already exists` });
      return;
    }
    req.log.error({ err }, 'Error updating employee');
    res.status(500).json({ error: 'Failed to update employee' });
  }
});

// ─── Update employee status ───────────────────────────────────────────────────
router.patch('/employees/:id/status', requireAuth, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid employee ID' });
    return;
  }

  const { status } = req.body;
  if (status !== 'ACTIVE' && status !== 'INACTIVE') {
    res.status(400).json({ error: 'Status must be ACTIVE or INACTIVE' });
    return;
  }

  const [employee] = await db
    .update(employeesTable)
    .set({ status })
    .where(eq(employeesTable.id, id))
    .returning();

  if (!employee) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  await createAuditLog({
    action: status === 'ACTIVE' ? 'EMPLOYEE_ACTIVATED' : 'EMPLOYEE_DEACTIVATED',
    entityType: 'employee',
    entityId: employee.id,
    performedBy: req.session.userId!,
    details: `Employee ${employee.employeeCode} ${status === 'ACTIVE' ? 'activated' : 'deactivated'}`,
  });

  res.json(employee);
});

export default router;
