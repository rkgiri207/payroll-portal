export type EmployeeCommand = 'IN' | 'OUT' | 'HELP' | 'LEAVE' | 'PERMISSION' | 'BALANCE';

export interface ParsedCommand {
  command: EmployeeCommand;
  /** Campus choice, e.g. "IN 2" (only for IN / OUT). */
  choice: number | null;
}

const SIMPLE = new Set<EmployeeCommand>(['HELP', 'LEAVE', 'PERMISSION', 'BALANCE']);

/**
 * Recognise only an exact command (case-insensitive, trimmed): IN, OUT, HELP, LEAVE,
 * PERMISSION, BALANCE, or "IN 2" / "OUT 2" for a campus choice. Anything else returns
 * null, so ordinary conversation can never start an attendance workflow.
 */
export function parseCommand(text: unknown): ParsedCommand | null {
  if (typeof text !== 'string') return null;
  const cleaned = text.trim().replace(/\s+/g, ' ').toUpperCase();
  if (!cleaned || cleaned.length > 20) return null;

  if (SIMPLE.has(cleaned as EmployeeCommand)) {
    return { command: cleaned as EmployeeCommand, choice: null };
  }
  const match = /^(IN|OUT)(?: ([1-9]))?$/.exec(cleaned);
  if (!match) return null;
  return { command: match[1] as 'IN' | 'OUT', choice: match[2] ? Number(match[2]) : null };
}
