// Dashboard on its own subdomain (for example dashboard.autoauth.cfd).
//   DASHBOARD_HOST   the dashboard's host name. Leave unset to keep everything on one host.
//   COOKIE_DOMAIN    optional; defaults to the shared parent domain (".autoauth.cfd") so one sign-in works on both hosts.
// The public site stays on REDIRECT_URI's host. Paths that belong to the dashboard are redirected there, and the dashboard host
// sends everything that is not a dashboard page back to the public site. Social sign-in and Drive callbacks stay on the public host
// (their redirect URIs are registered there); the shared cookie carries the session across.
const DASH_PATH = /^\/(dashboard|login|signup|account|users)(\/|%|\?|$)/;
const BOTH_PATH = /^\/(health|subscribe|assets\/|favicon|robots\.txt)/;

// On the dashboard host the "/dashboard" part is left out of the address bar: dashboard.example.com/ is the home page and
// dashboard.example.com/alice/shop/setup is /dashboard/alice/shop/setup. These first segments belong to other pages and keep their full path.
const KEEP = new Set(["dashboard", "login", "signup", "account", "users", "projects", "channels", "auth", "oauth", "optout", "report", "stripe", "info", "home", "tos", "terms-of-service", "privacy-policy", "drive-logo", "health", "subscribe", "assets", "favicon.ico", "robots.txt", ".well-known"]);
const seg = (p) => { const s = String(p).split("/")[1] || ""; try { return decodeURIComponent(s).toLowerCase(); } catch { return s.toLowerCase(); } };

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
      const q = String(req.url || "").includes("?") ? "?" + String(req.url).split("?").slice(1).join("?") : "";
      if (!unsafe && raw === "/dashboard") return res.redirect(302, "/" + q);
      if (!unsafe && raw.startsWith("/dashboard/") && !KEEP.has(seg(raw.slice(10)))) return res.redirect(302, raw.slice(10) + q);
      if (path === "/") { req.url = "/dashboard" + q; return next(); }
      if (dashPath || BOTH_PATH.test(raw) || KEEP.has(seg(raw))) { if (!dashPath && !BOTH_PATH.test(raw)) return res.redirect(code, to(main, req)); return next(); }
      req.url = "/dashboard" + raw + q; return next(); // a dashboard page shown without its "/dashboard" prefix
    }
    if (host === main || host === "www." + main) { if (dashPath) return res.redirect(code, to(dash, req)); }
    next();
  }
  return { enabled, dash, main, cookieDomain, middleware };
}
module.exports = createHosts;
module.exports.DASH_PATH = DASH_PATH;
