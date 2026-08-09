import { Router } from 'express';
import healthRouter from './health';
import authRouter from './auth';
import companySettingsRouter from './companySettings';
import dashboardRouter from './dashboard';
import auditLogsRouter from './auditLogs';
import storageRouter from './storage';
import employeesRouter from './employees';
import payrollRouter from './payroll';
import payrollRunsRouter from './payrollRuns';

const router = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(companySettingsRouter);
router.use(dashboardRouter);
router.use(auditLogsRouter);
router.use(storageRouter);
router.use(employeesRouter);
router.use(payrollRouter);
router.use(payrollRunsRouter);

export default router;
