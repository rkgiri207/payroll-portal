export const SESSION_EXPIRED_EVENT = "payroll:session-expired";

let interceptorInstalled = false;

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
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }

    return response;
  };
}
