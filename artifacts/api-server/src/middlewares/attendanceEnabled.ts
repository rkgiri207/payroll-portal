import { type NextFunction, type Request, type Response } from 'express';

/**
 * Master switch for the whole attendance module. With ATTENDANCE_ENABLED unset or not exactly
 * "true", every attendance route answers 404 as if it did not exist.
 */
export function requireAttendanceEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (process.env.ATTENDANCE_ENABLED !== 'true') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}
