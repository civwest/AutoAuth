// Dashboard on its own subdomain (for example dashboard.autoauth.cfd).
//   DASHBOARD_HOST   the dashboard's host name. Leave unset to keep everything on one host.
//   COOKIE_DOMAIN    optional; defaults to the shared parent domain (".autoauth.cfd") so one sign-in works on both hosts.
// The public site stays on REDIRECT_URI's host. Paths that belong to the dashboard are redirected there, and the dashboard host
// sends everything that is not a dashboard page back to the public site. Social sign-in and Drive callbacks stay on the public host
// (their redirect URIs are registered there); the shared cookie carries the session across.
const DASH_PATH = /^\/(dashboard|login|signup|account|users)(\/|%|\?|$)/;
const BOTH_PATH = /^\/(health|subscribe|assets\/|favicon|robots\.txt)/;

function createHosts(env = process.env) {
  const clean = (v) => String(v || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
  let main = ""; try { main = new URL(env.REDIRECT_URI).hostname.toLowerCase(); } catch {}
  const dash = clean(env.DASHBOARD_HOST), enabled = !!(dash && main && dash !== main);
  const cookieDomain = env.COOKIE_DOMAIN ? String(env.COOKIE_DOMAIN).trim() : enabled && dash.endsWith("." + main.replace(/^www\./, "")) ? "." + main.replace(/^www\./, "") : undefined;
  const to = (host, req) => `https://${host}${req.originalUrl || req.url || "/"}`;
  function middleware(req, res, next) {
    if (!enabled) return next();
    const host = String(req.hostname || "").toLowerCase(), path = req.path || "/", raw = String(req.originalUrl || req.url || "/").split("?")[0], unsafe = !["GET", "HEAD"].includes(req.method);
    const dashPath = DASH_PATH.test(raw), code = unsafe ? 307 : 302;
    if (host === dash) {
      if (path === "/") return res.redirect(302, "/login");
      if (dashPath || BOTH_PATH.test(raw)) return next();
      return res.redirect(code, to(main, req));
    }
    if (host === main || host === "www." + main) { if (dashPath) return res.redirect(code, to(dash, req)); }
    next();
  }
  return { enabled, dash, main, cookieDomain, middleware };
}
module.exports = createHosts;
module.exports.DASH_PATH = DASH_PATH;
