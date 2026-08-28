export default {
  async fetch(request: Request, env: { ASSETS: Fetcher }): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/p/")) {
      const target = new URL(
        `https://payroll-portal-api-dev.onrender.com${url.pathname}${url.search}`,
      );

      return fetch(new Request(target, request));
    }

    return env.ASSETS.fetch(request);
  },
};