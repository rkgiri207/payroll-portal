import type { SetupCounts } from './adminStore';
import type { AttendanceSettings } from './settings';

/** Which secrets/switches are present in the server environment (never their values). */
export interface EnvFlags {
  attendanceEnabled: boolean;
  whatsappMode: 'stub' | 'live';
  accessTokenSet: boolean;
  phoneNumberIdSet: boolean;
  graphVersionSet: boolean;
  appSecretSet: boolean;
  verifyTokenSet: boolean;
  sweepSecretSet: boolean;
  baseUrlSet: boolean;
}

export function readEnvFlags(env: NodeJS.ProcessEnv, settings: AttendanceSettings): EnvFlags {
  const has = (name: string) => Boolean(env[name]?.trim());
  return {
    attendanceEnabled: env.ATTENDANCE_ENABLED === 'true',
    whatsappMode: env.ATTENDANCE_WA_MODE?.trim().toLowerCase() === 'live' ? 'live' : 'stub',
    accessTokenSet: has('ATTENDANCE_WA_ACCESS_TOKEN'),
    phoneNumberIdSet: has('ATTENDANCE_WA_PHONE_NUMBER_ID'),
    graphVersionSet: has('ATTENDANCE_WA_GRAPH_VERSION'),
    appSecretSet: has('ATTENDANCE_WA_APP_SECRET'),
    verifyTokenSet: has('ATTENDANCE_WA_VERIFY_TOKEN'),
    sweepSecretSet: has('ATTENDANCE_SWEEP_SECRET'),
    baseUrlSet: Boolean(settings.linkBaseUrl || env.APP_BASE_URL?.trim()),
  };
}

export type SetupTab = 'campuses' | 'shifts' | 'employees' | 'settings' | 'system';

export interface ChecklistItem {
  key: string;
  label: string;
  done: boolean;
  detail: string;
  /** Which setup tab fixes it ('system' items are server settings you change in Netlify). */
  tab: SetupTab;
}

/** The "what is still missing" list at the top of the setup page. */
export function buildChecklist(counts: SetupCounts, settings: AttendanceSettings, flags: EnvFlags): ChecklistItem[] {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const whatsappReady = flags.accessTokenSet && flags.phoneNumberIdSet && flags.graphVersionSet;
  return [
    {
      key: 'campus', label: 'Add your campuses', tab: 'campuses',
      done: counts.campuses > 0, detail: `${plural(counts.campuses, 'active campus')}`,
    },
    {
      key: 'location', label: 'Set each campus location', tab: 'campuses',
      done: counts.campuses > 0 && counts.campusesWithLocation === counts.campuses,
      detail: `${counts.campusesWithLocation} of ${counts.campuses} have a latitude and longitude`,
    },
    {
      key: 'shift', label: 'Add a shift for each campus', tab: 'shifts',
      done: counts.campuses > 0 && counts.campusesWithShift === counts.campuses,
      detail: `${counts.campusesWithShift} of ${counts.campuses} campuses have a shift`,
    },
    {
      key: 'campusAssignment', label: 'Assign each employee to a campus', tab: 'employees',
      done: counts.activeEmployees > 0 && counts.withPrimaryCampus >= counts.activeEmployees,
      detail: `${counts.withPrimaryCampus} of ${counts.activeEmployees} active employees have a campus`,
    },
    {
      key: 'numbers', label: 'Register employee WhatsApp numbers', tab: 'employees',
      done: counts.activeEmployees > 0 && counts.registeredNumbers >= counts.activeEmployees,
      detail: `${counts.registeredNumbers} of ${counts.activeEmployees} active employees are registered`,
    },
    {
      key: 'director', label: "Set the Director's WhatsApp number", tab: 'settings',
      done: Boolean(settings.directorWhatsapp),
      detail: settings.directorWhatsapp ? 'Director alerts will be sent to the saved number' : 'No alerts can be sent to the Director yet',
    },
    {
      key: 'baseUrl', label: 'Public address for attendance links', tab: 'system',
      done: flags.baseUrlSet, detail: flags.baseUrlSet ? 'Links will use the saved address' : 'Set APP_BASE_URL in Netlify (or the link base URL setting)',
    },
    {
      key: 'enabled', label: 'Attendance switched on', tab: 'system',
      done: flags.attendanceEnabled, detail: flags.attendanceEnabled ? 'ATTENDANCE_ENABLED is true' : 'Set ATTENDANCE_ENABLED=true in Netlify',
    },
    {
      key: 'webhook', label: 'WhatsApp webhook secrets', tab: 'system',
      done: flags.appSecretSet && flags.verifyTokenSet,
      detail: flags.appSecretSet && flags.verifyTokenSet ? 'App secret and verify token are set' : 'Set ATTENDANCE_WA_APP_SECRET and ATTENDANCE_WA_VERIFY_TOKEN in Netlify',
    },
    {
      key: 'whatsapp', label: 'WhatsApp sending (live mode)', tab: 'system',
      done: flags.whatsappMode === 'live' && whatsappReady,
      detail: flags.whatsappMode === 'live'
        ? (whatsappReady ? 'Messages are sent through WhatsApp' : 'Live mode is on but the access token, phone number ID or Graph version is missing')
        : 'Test mode: messages are recorded but NOT sent. Set ATTENDANCE_WA_MODE=live when ready',
    },
  ];
}
