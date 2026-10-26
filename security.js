"use strict";
// Site-wide protection: host check, security headers, rate limiter with temporary bans, cross-site POST blocking,
// no-store caching for private pages, security.txt, and TOTP (two-step login) helpers.
const crypto = require("node:crypto");

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const PER_MIN = () => num(process.env.RATE_LIMIT_PER_MIN, 240); // everything except static files
const AUTH_PER_MIN = () => num(process.env.RATE_LIMIT_AUTH_PER_MIN, 20); // login, signup, OAuth
const WRITE_PER_MIN = () => num(process.env.RATE_LIMIT_WRITE_PER_MIN, 90); // POST/PUT/DELETE
const HOOK_PER_MIN = () => num(process.env.RATE_LIMIT_HOOK_PER_MIN, 600); // Discord interactions/webhooks sent to /projects
const BAN_AFTER = 5; // limit hits inside 10 minutes
const BAN_MS = 15 * 60 * 1000;

const AUTH_PATHS = /^\/(login|signup|account\/logout|oauth\/callback|login\/callback|auth\/|optout)/;
const HOOK_PATHS = /^(?:\/projects\/[^/]+(?:\/[^/]+)?\/(?:interactions|webhook)|\/stripe\/webhook)$/;
const PRIVATE_PATHS = /^\/(dashboard|login|signup|users|channels|account|auth|report|optout)(\/|$)/;

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // pages use inline scripts; everything else is locked down
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "form-action 'self' https://discord.com https://accounts.google.com https://x.com https://twitter.com",
].join("; ");

function createSecurity({ log }) {
  const buckets = new Map(); // key -> {n, until}
  const strikes = new Map(); // ip -> {n, until}
  const bans = new Map(); // ip -> until
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of buckets) if (v.until < now) buckets.delete(k);
    for (const [k, v] of strikes) if (v.until < now) strikes.delete(k);
    for (const [k, v] of bans) if (v < now) bans.delete(k);
    if (buckets.size > 100000) buckets.clear(); // memory cap
  };
  setInterval(sweep, 30000).unref();

  const hit = (key, max, ms = 60000) => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.until < now) { b = { n: 0, until: now + ms }; buckets.set(key, b); }
    b.n++;
    return { over: b.n > max, retry: Math.max(1, Math.ceil((b.until - now) / 1000)) };
  };

  function tooMany(req, res, retry, why) {
    res.set("Retry-After", String(retry));
    if (/json/.test(req.get("accept") || "") || /json/.test(req.get("content-type") || "")) return res.status(429).json({ error: "Too many requests. Try again later." });
    return res.status(429).type("text/plain").send("Too many requests. Please wait a moment and try again.");
  }

  function allowedHosts() {
    const hosts = new Set(["localhost", "127.0.0.1"]);
    for (const v of [process.env.REDIRECT_URI, process.env.LOGIN_REDIRECT_URI]) { try { const h = new URL(v).hostname.toLowerCase(); hosts.add(h); hosts.add("www." + h.replace(/^www\./, "")); } catch {} }
    for (const h of String(process.env.ALLOWED_HOSTS || "").split(/[ ,]+/).filter(Boolean)) hosts.add(h.toLowerCase());
    return hosts;
  }

  function middleware(req, res, next) {
    const ip = req.ip || "unknown", path = req.path || "/";

    // 1. Host header: only the site's own names (and Render's own address).
    const configured = allowedHosts();
    if (path !== "/health" && configured.size > 2 && !process.env.ALLOWED_HOSTS?.includes("*")) {
      const host = String(req.hostname || "").toLowerCase();
      if (!configured.has(host) && !host.endsWith(".onrender.com")) return res.status(421).type("text/plain").send("Unknown host.");
    }

    // 2. Oversized URLs.
    if ((req.originalUrl || "").length > 2048) return res.status(414).type("text/plain").send("URL too long.");

    // 3. Security headers.
    res.removeHeader("X-Powered-By");
    res.set({
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "X-DNS-Prefetch-Control": "off",
      "X-Permitted-Cross-Domain-Policies": "none",
    });
    if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000");
    if (PRIVATE_PATHS.test(path)) res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });

    if (path === "/health") return next();

    // 4. Temporary ban after repeated limit hits.
    const until = bans.get(ip);
    if (until && until > Date.now()) return tooMany(req, res, Math.ceil((until - Date.now()) / 1000));

    // 5. Cross-site form posts (browsers say so with Sec-Fetch-Site). Discord's own calls carry no such header.
    const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (unsafe && req.get("sec-fetch-site") === "cross-site" && !HOOK_PATHS.test(path)) return res.status(403).type("text/plain").send("Cross-site request blocked.");

    // 6. Rate limits.
    if (/^\/assets\//.test(path)) return next();
    let limit;
    if (HOOK_PATHS.test(path)) limit = hit("h:" + ip, HOOK_PER_MIN());
    else {
      limit = hit("g:" + ip, PER_MIN());
      if (!limit.over && AUTH_PATHS.test(path)) limit = hit("a:" + ip, AUTH_PER_MIN());
      if (!limit.over && unsafe) limit = hit("w:" + ip, WRITE_PER_MIN());
    }
    if (limit.over) {
      const s = strikes.get(ip) || { n: 0, until: Date.now() + 10 * 60 * 1000 };
      s.n++; strikes.set(ip, s);
      if (s.n >= BAN_AFTER) {
        bans.set(ip, Date.now() + BAN_MS); strikes.delete(ip);
        log("security_ip_blocked", { ip, minutes: BAN_MS / 60000 }).catch?.(() => {});
      }
      return tooMany(req, res, limit.retry);
    }
    next();
  }

  const securityTxt = (req, res) => {
    let contact = String(process.env.SUPPORT_EMAIL || "").trim();
    if (!contact) { try { contact = "support@" + new URL(process.env.REDIRECT_URI).hostname.replace(/^www\./, ""); } catch {} }
    res.type("text/plain").send(`${contact ? `Contact: mailto:${contact}\n` : ""}Expires: ${new Date(Date.now() + 365 * 864e5).toISOString()}\nPreferred-Languages: en\n`);
  };

  function mount(app) {
    app.disable("x-powered-by");
    app.use(middleware);
    app.get(["/.well-known/security.txt", "/security.txt"], securityTxt);
  }

  // Limits for one-off checks elsewhere (e.g. per-username login throttling).
  const failures = new Map();
  const lockout = {
    blocked(key) { const f = failures.get(key); return !!(f && f.until > Date.now() && f.n >= 5); },
    fail(key) { const now = Date.now(), f = failures.get(key); const n = f && f.until > now ? f.n + 1 : 1; failures.set(key, { n, until: now + 15 * 60 * 1000 }); },
    clear(key) { failures.delete(key); },
  };
  setInterval(() => { const n = Date.now(); for (const [k, v] of failures) if (v.until < n) failures.delete(k); }, 60000).unref();

  return { mount, middleware, lockout, bans, hit };
}

// ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----------
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32decode(s) {
  const clean = String(s || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "", out = [];
  for (const ch of clean) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function b32encode(buf) {
  let bits = "", out = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}
function totpAt(secret, step) {
  const key = b32decode(secret), msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", key).update(msg).digest(), o = h[h.length - 1] & 15;
  return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1e6).padStart(6, "0");
}
const lastStep = new Map(); // secret -> last accepted step (a code works once)
function totpVerify(secret, code, now = Date.now()) {
  code = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code) || !b32decode(secret).length) return false;
  const cur = Math.floor(now / 30000);
  for (const d of [0, -1, 1]) {
    const step = cur + d;
    const ok = crypto.timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(code));
    if (ok) { if ((lastStep.get(secret) || 0) >= step) return false; lastStep.set(secret, step); return true; }
  }
  return false;
}
const newSecret = () => b32encode(crypto.randomBytes(20));
const otpauth = (user, secret, issuer = "AutoAuth") => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(user)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// Passwords that are too easy to guess.
const COMMON = new Set("password,password1,password123,12345678,123456789,1234567890,qwertyui,qwerty123,iloveyou,admin123,letmein1,welcome1,11111111,00000000,abc12345,passw0rd,autoauth,discord123,qwertyuiop,1q2w3e4r,monkey123,dragon123,football1,baseball1".split(","));
const weakPassword = (pw, username) => { const p = String(pw || "").toLowerCase(); return COMMON.has(p) || (username && p === String(username).toLowerCase()) || /^(.)\1+$/.test(p); };

module.exports = { createSecurity, totpVerify, totpAt, newSecret, otpauth, weakPassword, b32decode, b32encode };
