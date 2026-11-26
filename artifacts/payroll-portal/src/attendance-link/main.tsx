import { createRoot } from 'react-dom/client';
import AttendanceLinkPage, { ScreenView } from './AttendanceLinkPage';
import { closedCopy } from './copy';

import './attendance-link.css';

/**
 * Entry for the public attendance page. It is a separate, tiny page (attendance.html), not
 * part of the signed-in portal: no login, no session heartbeat, no portal code. The one-time
 * token comes from the link, e.g. /a/<token>.
 */
function tokenFromLocation(): string {
  const match = /^\/a\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname);
  if (match) return match[1];
  // Local development convenience: /attendance.html?token=...
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

const root = createRoot(document.getElementById('root')!);
const token = tokenFromLocation();

if (token) {
  root.render(<AttendanceLinkPage token={token} />);
} else {
  root.render(
    <main className="page">
      <ScreenView
        screen={{ name: 'closed', message: closedCopy('NOT_FOUND') }}
        secondsLeft={0}
        handlers={{ onReload() {}, onCheckLocation() {}, onTakePhoto() {}, onRetake() {}, onSubmit() {}, onRetry() {} }}
      />
    </main>,
  );
}
