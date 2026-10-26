"use strict";
// Google and X sign-up, log-in and account linking for project accounts. Each provider only appears when its credentials are set.
const crypto = require("node:crypto");

const GOOGLE_G = '<svg viewBox="0 0 48 48" width="22" height="22" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
const X_LOGO = '<svg viewBox="0 0 24 24" width="20" height="20" fill="#fff" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';

const PROV = {
  google: {
    label: "Google", id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET", logo: GOOGLE_G,
    style: "background:#fff;color:#1f1f1f;border:1px solid #dadce0",
    auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", scope: "openid email profile",
    async me(tok) {
      const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + tok } }), j = await r.json();
      if (!r.ok || !j.sub) throw new Error("Google profile failed");
      return { subject: String(j.sub), name: j.name || (j.email ? j.email.split("@")[0] : ""), handle: j.email ? j.email.split("@")[0] : j.name };
    },
  },
  x: { // "Sign in with X" (OAuth 1.0a): request token -> api.x.com/oauth/authenticate -> access token. Needs the app's API Key and Secret.
    label: "X", id: "X_API_KEY", secret: "X_API_SECRET", logo: X_LOGO, oauth1: true,
    style: "background:#000;color:#fff;border:1px solid #444",
  },
};

const enc1 = (v) => encodeURIComponent(String(v)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const oauthSign = (method, url, params, secret, tokenSecret) => crypto.createHmac("sha1", `${enc1(secret)}&${enc1(tokenSecret || "")}`)
  .update([method, enc1(url), enc1(Object.keys(params).sort().map((k) => `${enc1(k)}=${enc1(params[k])}`).join("&"))].join("&")).digest("base64");
// Signs and sends an OAuth 1.0a request (HMAC-SHA1). extra = oauth_callback / oauth_verifier; tokenSecret is empty for the first step.
async function oauth1(url, { key, secret, token, tokenSecret, extra }) {
  const o = { oauth_consumer_key: key, oauth_nonce: crypto.randomBytes(16).toString("hex"), oauth_signature_method: "HMAC-SHA1", oauth_timestamp: String(Math.floor(Date.now() / 1000)), oauth_version: "1.0", ...(token ? { oauth_token: token } : {}), ...(extra || {}) };
  o.oauth_signature = oauthSign("POST", url, o, secret, tokenSecret);
  const r = await fetch(url, { method: "POST", headers: { Authorization: "OAuth " + Object.keys(o).sort().map((k) => `${enc1(k)}="${enc1(o[k])}"`).join(", ") }, signal: AbortSignal.timeout(10000) });
  const text = await r.text(), p = Object.fromEntries(new URLSearchParams(text));
  if (!r.ok) throw new Error(`X ${r.status}: ${text.slice(0, 200)}`);
  return p;
}

module.exports = function createSocial(h) {
  const { ownerIdent, pool, log, esc, origin, clip, save, limited, slugName, freeUsername, createAccount, start, authPage } = h;
  const shown = (k, me) => (k === "x" && me.handle ? "@" + me.handle : me.name); // how a connected account is labelled
  const on = (k) => !!(process.env[PROV[k].id] && process.env[PROV[k].secret]);
  const redirectUri = (k) => `${origin()}/auth/${k}/callback`;
  const b64 = (b) => b.toString("base64url");

  // Every sign-in button (Discord, Google, X) uses the same box so they match in size.
  const DISCORD_LOGO = '<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff" aria-hidden="true"><path d="' + require("./icons").discord + '"/></svg>';
  const KINDS = { discord: { logo: DISCORD_LOGO, style: "background:#5865F2;color:#fff;border:1px solid #5865F2", label: "Discord" }, google: { logo: PROV.google.logo, style: PROV.google.style, label: "Google" }, x: { logo: PROV.x.logo, style: PROV.x.style, label: "X" } };
  const BOX = "display:flex;align-items:center;justify-content:center;gap:10px;box-sizing:border-box;width:100%;height:46px;margin:0 0 10px;padding:0 16px;border-radius:6px;font:600 16px/1 system-ui,sans-serif;text-decoration:none;cursor:pointer;white-space:nowrap;";
  const btn = (kind, label, to) => {
    const K = KINDS[kind], inner = `${K.logo}${label}`, st = BOX + K.style;
    if (to.post) return `<form method="post" action="${to.post}" style="margin:0">${Object.entries(to.fields || {}).map(([n, v]) => `<input type="hidden" name="${n}" value="${esc(v)}">`).join("")}<button type="submit" style="${st}">${inner}</button></form>`;
    return `<a href="${esc(to.href)}" style="${st}">${inner}</a>`;
  };
  const verb = (intent) => (intent === "signup" ? "Sign up" : intent === "link" ? "Link" : "Log in");
  // Login and signup pages: only providers that are set up.
  const buttons = (intent) => Object.keys(PROV).filter(on).map((k) => btn(k, `${verb(intent)} with ${PROV[k].label}`, { href: `/auth/${k}/start?intent=${intent}` })).join("");
  // Profile: always shown, so the account can be linked as soon as the provider is set up.
  // One link flow for both sides of the site: who=owner (main dashboard) or who=account (project dashboards).
  const linkButton = (k, who) => btn(k, `Link ${PROV[k].label}`, { href: `/auth/${k}/start?intent=link&for=${who === "owner" ? "owner" : "account"}` });

  const identities = async (accountId) => (await pool.query("SELECT provider,subject,name FROM account_identities WHERE account_id=$1", [accountId])).rows;

  function mountPublic(app) {
    const fail = (res, msg, back) => res.status(400).set("Cache-Control", "no-store").send(authPage({ title: "Sign in", sub: "Could not sign in", error: msg, top: "", form: "", foot: `<a class="alt" href="${back || "/login"}">Back</a>` }).replace('<div class="or"><span></span>or<span></span></div>', ""));

    app.get("/auth/:provider/start", async (req, res) => {
      const k = req.params.provider, P = PROV[k];
      if (!P) return res.status(404).send("Not found");
      if (!on(k)) return res.status(503).send(authPage({ title: "Sign in", sub: `${P.label} sign-in is not set up yet`, error: "", top: "", form: "", foot: `<a class="alt" href="${req.session && req.session.acct ? `/dashboard/${req.session.acct.username}/profile` : "/login"}">Back</a>` }).replace('<div class="or"><span></span>or<span></span></div>', ""));
      let intent = ["signup", "login", "link", "olink"].includes(req.query.intent) ? req.query.intent : "login";
      if (intent === "link" || intent === "olink") { // one flow: the session decides whether this links an owner login or a project account
        const who = req.query.for === "owner" || intent === "olink" ? "owner" : req.query.for === "account" ? "account" : (req.session && req.session.acct ? "account" : "owner");
        intent = who === "owner" ? "olink" : "link";
      }
      if (intent === "link" && !(req.session && req.session.acct)) return res.redirect(303, "/login");
      if (intent === "olink" && !(req.session && req.session.owner)) return res.redirect(303, "/login");
      if (limited("os:" + req.ip, 30, 600000)) return res.status(429).send("Too many attempts. Try again later.");
      if (P.oauth1) { // X: ask for a request token, then send the person to X's own sign-in page
        try {
          const t = await oauth1("https://api.x.com/oauth/request_token", { key: process.env[P.id], secret: process.env[P.secret], extra: { oauth_callback: redirectUri(k) } });
          if (!t.oauth_token || t.oauth_callback_confirmed !== "true") throw new Error("no request token");
          req.session.oa = { state: t.oauth_token, secret: t.oauth_token_secret, intent, provider: k, until: Date.now() + 10 * 60 * 1000 };
          await save(req);
          return res.set("Cache-Control", "no-store").redirect(303, "https://api.x.com/oauth/authenticate?oauth_token=" + encodeURIComponent(t.oauth_token));
        } catch (e) { await log("account_social_error", { provider: k, step: "request_token", error: String(e.message).slice(0, 200) }); return fail(res, "X would not start the sign-in. Check the API Key, API Secret and the callback URL in the X developer portal."); }
      }
      const state = crypto.randomBytes(16).toString("hex"), verifier = b64(crypto.randomBytes(32));
      req.session.oa = { state, verifier, intent, provider: k, until: Date.now() + 10 * 60 * 1000 };
      await save(req);
      const u = new URL(P.auth);
      u.searchParams.set("client_id", process.env[P.id]); u.searchParams.set("response_type", "code"); u.searchParams.set("redirect_uri", redirectUri(k));
      u.searchParams.set("scope", P.scope); u.searchParams.set("state", state);
      u.searchParams.set("code_challenge", b64(crypto.createHash("sha256").update(verifier).digest())); u.searchParams.set("code_challenge_method", "S256");
      res.set("Cache-Control", "no-store").redirect(303, u.toString());
    });

    app.get("/auth/:provider/callback", async (req, res) => {
      res.set({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
      const k = req.params.provider, P = PROV[k], o = req.session && req.session.oa;
      if (!P || !on(k)) return res.status(404).send("Not found");
      if (!o || o.provider !== k || o.until < Date.now() || typeof (P.oauth1 ? req.query.oauth_token : req.query.state) !== "string" || (P.oauth1 ? req.query.oauth_token : req.query.state) !== o.state) return fail(res, "This sign-in expired or was opened twice. Please try again.");
      delete req.session.oa; await save(req);
      if (req.query.error || req.query.denied) return res.redirect(303, o.intent === "olink" ? "/users/profile" : o.intent === "link" && req.session.acct ? `/dashboard/${req.session.acct.username}/profile` : "/login");
      if (!P.oauth1 && (typeof req.query.code !== "string" || !req.query.code)) return fail(res, `${P.label} did not return a code.`);
      if (P.oauth1 && (typeof req.query.oauth_verifier !== "string" || !req.query.oauth_verifier)) return fail(res, `${P.label} did not confirm the sign-in.`);
      try {
        let me;
        if (P.oauth1) {
          const a = await oauth1("https://api.x.com/oauth/access_token", { key: process.env[P.id], secret: process.env[P.secret], token: o.state, tokenSecret: o.secret, extra: { oauth_verifier: req.query.oauth_verifier } });
          if (!a.user_id) throw new Error("X returned no user");
          me = { subject: String(a.user_id), name: a.screen_name, handle: a.screen_name };
        } else {
        const body = new URLSearchParams({ grant_type: "authorization_code", code: req.query.code, redirect_uri: redirectUri(k), code_verifier: o.verifier, client_id: process.env[P.id] });
        const headers = { "Content-Type": "application/x-www-form-urlencoded" };
        if (P.basic) headers.Authorization = "Basic " + Buffer.from(`${process.env[P.id]}:${process.env[P.secret]}`).toString("base64"); else body.set("client_secret", process.env[P.secret]);
        const t = await (await fetch(P.token, { method: "POST", headers, body })).json();
        if (!t.access_token) { await log("account_social_failed", { provider: k, error: t.error }); return fail(res, `${P.label} rejected the sign-in.`); }
        me = await P.me(t.access_token);
        }
        if (o.intent === "olink") {
          const key = req.session.owner && ownerIdent.keyOf(req); if (!key) return res.redirect(303, "/login");
          const okk = await ownerIdent.link(key, k, me.subject, clip(shown(k, me), 80));
          if (!okk) return fail(res, `That ${P.label} account is linked to another dashboard login.`, "/users/profile");
          req.session.flash = `${P.label} linked.`; await save(req);
          return res.redirect(303, "/users/profile");
        }
        if (o.intent === "login") { const ow = await ownerIdent.find(k, me.subject); if (ow) return res.redirect(303, await ownerIdent.login(req, ow, k)); }
        const found = (await pool.query("SELECT a.id,a.username FROM account_identities i JOIN accounts a ON a.id=i.account_id WHERE i.provider=$1 AND i.subject=$2", [k, me.subject])).rows[0];
        if (o.intent === "link") {
          const s = req.session.acct; if (!s) return res.redirect(303, "/login");
          if (found && String(found.id) !== s.id) return fail(res, `That ${P.label} account is linked to another account.`, `/dashboard/${s.username}/profile`);
          await pool.query("INSERT INTO account_identities(account_id,provider,subject,name) VALUES($1,$2,$3,$4) ON CONFLICT(provider,subject) DO UPDATE SET name=$4", [s.id, k, me.subject, clip(shown(k, me), 80)]);
          req.session.flash = `${P.label} linked.`; await save(req);
          return res.redirect(303, `/dashboard/${s.username}/profile`);
        }
        if (found) { const out = await start(req, found, true); return res.redirect(303, out.redirect); }
        if (o.intent === "login") return fail(res, `There is no account for this ${P.label} user yet.`, "/signup");
        const name = clip(me.name || me.handle, 60) || k;
        const acct = await createAccount({ username: await freeUsername(slugName(me.handle || me.name)), name });
        await pool.query("INSERT INTO account_identities(account_id,provider,subject,name) VALUES($1,$2,$3,$4)", [acct.id, k, me.subject, clip(shown(k, me), 80)]);
        const out = await start(req, acct, true); res.redirect(303, out.redirect);
      } catch (e) { console.error(e); await log("account_social_error", { provider: k, error: e.message }); fail(res, "Something went wrong. Please try again."); }
    });
  }

  return { PROV, on, buttons, linkButton, btn, identities, mountPublic };
};
module.exports.oauthSign = oauthSign;
