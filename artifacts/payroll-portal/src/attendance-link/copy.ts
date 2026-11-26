/** Plain-language text for every situation the employee can meet. No technical jargon. */
import type { ClosedState, Confirmation, LocationFailure } from './api';

export interface Message {
  title: string;
  body: string;
  /** When set, the screen offers a button for this action (e.g. reload the page). */
  action?: 'reload';
}

const WORD = { IN: 'check-in', OUT: 'check-out' } as const;

export function closedCopy(state: ClosedState): Message {
  switch (state) {
    case 'EXPIRED':
      return { title: 'This link has expired', body: 'Links last only a few minutes. Send IN or OUT again on WhatsApp to get a new one.' };
    case 'USED':
      return { title: 'This link was already used', body: 'If you saw a confirmation, your attendance is recorded and there is nothing more to do. Otherwise send IN or OUT again on WhatsApp.' };
    case 'LOCKED':
      return { title: 'Attendance marking was not successful', body: 'Your attendance marking was not successful due to location mismatch. The school has been informed. Please contact the school administration.' };
    case 'UNAVAILABLE':
      return { title: 'Attendance is not available right now', body: 'Please try again later or contact the school administration.' };
    default:
      return { title: 'This link is not valid', body: 'Please send IN or OUT on WhatsApp to get a new link.' };
  }
}

export function geolocationErrorCopy(code: number | null): Message {
  if (code === 1) {
    return {
      title: 'Location is switched off for this page',
      body: 'Allow location for this website. iPhone: Settings > Privacy & Security > Location Services > Safari Websites, set to "While Using", and turn on Precise Location. Android: tap the lock icon next to the address, then Permissions > Location > Allow. After you change this, the page must be reloaded: tap "Reload this page" below, then tap "Check my location" again.',
      action: 'reload',
    };
  }
  if (code === 3) {
    return { title: 'Your phone took too long to find your location', body: 'Go near a window or outside, make sure Location is on, wait a few seconds, then try again.' };
  }
  return { title: 'Your phone could not find your location', body: 'Turn on Location (GPS) in your phone settings, go near a window or outside, then try again.' };
}

export function locationFailureCopy(
  result: LocationFailure,
  opts: { attemptsLeft: number | null; requiredAccuracyM: number; locked: boolean; reportedAccuracyM?: number | null },
): Message {
  if (opts.locked) return closedCopy('LOCKED');
  const reported = typeof opts.reportedAccuracyM === 'number' ? ` Your phone reported about ${Math.round(opts.reportedAccuracyM)} metres.` : '';
  const left = opts.attemptsLeft === null ? '' : ` Attempts left: ${opts.attemptsLeft}.`;
  switch (result) {
    case 'OUTSIDE_RADIUS':
      return { title: 'You seem to be outside the campus', body: `Move closer to the school entrance or inside the campus, then try again.${left}` };
    case 'POOR_ACCURACY':
      return {
        title: 'Your location is not accurate enough',
        body: `Your phone must report within ${opts.requiredAccuracyM} metres.${reported} Go outside or near a window, turn on Precise Location, wait a few seconds, then try again.${left}`,
      };
    case 'CAMPUS_NOT_ALLOWED':
      return { title: 'You are not assigned to this campus today', body: 'Please contact the school administration.' };
    case 'CAMPUS_NOT_CONFIGURED':
      return { title: 'This campus is not set up yet', body: 'The school administration has been informed. Please try again later.' };
    default:
      return { title: 'No location received', body: `Make sure Location is on and allowed for this page, then try again.${left}` };
  }
}

export function cameraErrorCopy(name: string | null): Message {
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      title: 'The camera is switched off for this page',
      body: 'Allow the camera for this website and reload the page. iPhone: Settings > Safari > Camera, choose "Ask" or "Allow". Android: tap the lock icon next to the address, then Permissions > Camera > Allow. If you cannot, contact the school administration to record your attendance.',
    };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { title: 'No front camera found', body: 'This page needs the front camera to take a selfie. Please contact the school administration.' };
  }
  return { title: 'The camera could not start', body: 'Close other apps that may be using the camera, then try again.' };
}

export function successCopy(c: Confirmation): Message {
  const status = c.type === 'IN'
    ? c.punctuality === 'ON_TIME' ? ' You are on time.'
      : c.punctuality === 'LATE' ? ` You are late${c.lateMinutes ? ` by ${c.lateMinutes} minutes` : ''}.`
        : ''
    : '';
  const title = c.duplicate
    ? `Your ${WORD[c.type]} was already recorded`
    : `Your ${WORD[c.type]} is recorded`;
  return { title, body: `${c.time} on ${c.date} at ${c.campusName}.${status} You can close this page now.` };
}

export function alreadyMarkedCopy(): Message {
  return { title: 'Already recorded for today', body: 'Your attendance for this is already recorded, so nothing more is needed. You can close this page.' };
}

/** 3:07 for 187 seconds. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const typeWord = (type: 'IN' | 'OUT'): string => WORD[type];
