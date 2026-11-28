import { createRoot } from 'react-dom/client';
import LeaveFormPage, { ScreenView } from './LeaveFormPage';
import { closedCopy } from './copy';

import '../attendance-link/attendance-link.css';
import './leave-form.css';

/**
 * Entry for the employee's leave form. It is a separate, tiny page (leave.html), not part of the
 * signed-in portal: no login, no session heartbeat, no portal code. The one-time token comes
 * from the link sent on WhatsApp, e.g. /l/<token>.
 */
function tokenFromLocation(): string {
  const match = /^\/l\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname);
  if (match) return match[1];
  // Local development convenience: /leave.html?token=...
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

const root = createRoot(document.getElementById('root')!);
const token = tokenFromLocation();

if (token) {
  root.render(<LeaveFormPage token={token} />);
} else {
  root.render(<main className="page"><div className="stack"><ScreenView screen={{ name: 'closed', message: closedCopy('NOT_FOUND') }} formProps={null} onRetry={() => {}} /></div></main>);
}
