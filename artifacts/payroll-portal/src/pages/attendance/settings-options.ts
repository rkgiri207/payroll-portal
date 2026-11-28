/** The "longest single permission" choices: no limit, or 5 minutes up to 8 hours in 5-minute steps. */
export const PERMISSION_STEP_MINUTES = 5;
export const PERMISSION_MAX_MINUTES = 480;
export const NO_LIMIT = 'none';

/** "5 minutes", "1 hour", "1 hour 15 minutes". */
export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minute${m === 1 ? '' : 's'}` : ''}`;
}

export const permissionMinuteOptions: { value: string; label: string }[] = [
  { value: NO_LIMIT, label: 'No limit' },
  ...Array.from({ length: PERMISSION_MAX_MINUTES / PERMISSION_STEP_MINUTES }, (_, i) => {
    const minutes = (i + 1) * PERMISSION_STEP_MINUTES;
    return { value: String(minutes), label: minutesLabel(minutes) };
  }),
];
