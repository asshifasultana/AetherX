// Several /api endpoints can share one Vercel function (the Hobby plan caps a
// deployment at 12). The build rewrites /api/<name> to the group's function
// with ?__route=<name>; this picks the handler from that, or from the path when
// a request arrives unrewritten, and hides the marker from the handler.
export const ROUTE_PARAM = '__route';

export function createRouteGroup(handlers, fallback) {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const name = url.searchParams.get(ROUTE_PARAM) || url.pathname.replace(/\/+$/, '').split('/').pop();
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : handlers[fallback];
    if (url.searchParams.has(ROUTE_PARAM)) {
      url.searchParams.delete(ROUTE_PARAM);
      req.url = `/api/${name}${url.search}`;
    }
    return handler(req, res);
  };
}
