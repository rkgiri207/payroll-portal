import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import companySettingsRouter from "./companySettings";
import dashboardRouter from "./dashboard";
import auditLogsRouter from "./auditLogs";
import storageRouter from "./storage";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(companySettingsRouter);
router.use(dashboardRouter);
router.use(auditLogsRouter);
router.use(storageRouter);

export default router;
