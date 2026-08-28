export const SESSION_EXPIRED_EVENT = "payroll:session-expired";
export const SESSION_STARTED_EVENT = "payroll:session-started";
export const SESSION_ENDED_EVENT = "payroll:session-ended";
export const SESSION_DURATION_MS = 60_000;

const SESSION_DEADLINE_KEY = "payroll.sessionDeadline";
const HEARTBEAT_THROTTLE_MS = 12_000;

let interceptorInstalled = false;

export function recordSessionStarted(): void {
  const deadline = Date.now() + SESSION_DURATION_MS;
  window.sessionStorage.setItem(SESSION_DEADLINE_KEY, String(deadline));
  window.dispatchEvent(new Event(SESSION_STARTED_EVENT));
}

export function getSessionDeadline(): number | null {
  const stored = window.sessionStorage.getItem(SESSION_DEADLINE_KEY);
  if (!stored) return null;

  const deadline = Number(stored);
  return Number.isFinite(deadline) ? deadline : null;
}

export function clearSessionDeadline(): void {
  window.sessionStorage.removeItem(SESSION_DEADLINE_KEY);
  window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
}

export function installSessionActivityMonitor(): () => void {
  let stopped = false;
  let inFlight = false;
  let activityQueued = false;
  let lastHeartbeatAt = 0;
  let throttleTimer: number | null = null;
  let controller: AbortController | null = null;

  const clearThrottleTimer = () => {
    if (throttleTimer !== null) {
      window.clearTimeout(throttleTimer);
      throttleTimer = null;
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    activityQueued = false;
    clearThrottleTimer();
    controller?.abort();
    controller = null;
  };

  const scheduleHeartbeat = () => {
    if (stopped || inFlight || !activityQueued || document.visibilityState === "hidden") return;

    const remaining = HEARTBEAT_THROTTLE_MS - (Date.now() - lastHeartbeatAt);
    if (remaining <= 0) {
      void sendHeartbeat();
      return;
    }

    if (throttleTimer === null) {
      throttleTimer = window.setTimeout(() => {
        throttleTimer = null;
        void sendHeartbeat();
      }, remaining);
    }
  };

  const sendHeartbeat = async () => {
    if (stopped || inFlight || !activityQueued || document.visibilityState === "hidden") return;

    clearThrottleTimer();
    activityQueued = false;
    inFlight = true;
    lastHeartbeatAt = Date.now();
    controller = new AbortController();

    try {
      const response = await fetch("/api/auth/me", {
        cache: "no-store",
        credentials: "include",
        signal: controller.signal,
      });

      if (stopped) return;
      if (response.ok) recordSessionStarted();
      // A 401 is handled by the existing global fetch interceptor.
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        // A transient heartbeat failure does not prove that the session expired.
      }
    } finally {
      inFlight = false;
      controller = null;
      if (!stopped && activityQueued) scheduleHeartbeat();
    }
  };

  const handleActivity = () => {
    if (stopped || document.visibilityState === "hidden" || getSessionDeadline() === null) return;
    activityQueued = true;
    scheduleHeartbeat();
  };

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      activityQueued = false;
      clearThrottleTimer();
    }
  };

  const activityEvents: Array<keyof WindowEventMap> = ["pointermove", "pointerdown", "keydown", "touchstart"];
  activityEvents.forEach(event => window.addEventListener(event, handleActivity, { passive: true }));
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener(SESSION_ENDED_EVENT, stop);
  window.addEventListener(SESSION_EXPIRED_EVENT, stop);

  return () => {
    stop();
    activityEvents.forEach(event => window.removeEventListener(event, handleActivity));
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener(SESSION_ENDED_EVENT, stop);
    window.removeEventListener(SESSION_EXPIRED_EVENT, stop);
  };
}

function isSameOriginApiRequest(input: RequestInfo | URL): boolean {
  const requestUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const url = new URL(requestUrl, window.location.href);

  return url.origin === window.location.origin && url.pathname.startsWith("/api/");
}

export function installSessionExpirationInterceptor(): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init) => {
    const response = await originalFetch(input, init);

    if (response.status === 401 && isSameOriginApiRequest(input)) {
      clearSessionDeadline();
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }

    return response;
  };
}
