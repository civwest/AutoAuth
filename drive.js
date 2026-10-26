"use strict";
// Google Drive storage for project data. Free for every account on every plan.
// Uses the drive.file scope: AutoAuth can only see the files and folders it creates itself.
// Layout in the person's Drive:  AutoAuth/<project>/email-<userId>.json, connections-<userId>.json, ...
const crypto = require("node:crypto");

module.exports = function createDrive({ pool, enc, dec, log, esc, origin, limited, save }) {
  const SCOPE = "https://www.googleapis.com/auth/drive.file openid email";
  const on = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  const redirectUri = () => `${origin()}/auth/google/drive/callback`;
  const q = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const cache = new Map(); // account id -> { token, until }
  const folderMime = "application/vnd.google-apps.folder";

  const linkOf = async (accountId) => (await pool.query("SELECT account_id,email,refresh_enc,folders FROM drive_links WHERE account_id=$1", [accountId])).rows[0] || null;

  async function accessToken(link) {
    const hit = cache.get(String(link.account_id)); if (hit && hit.until > Date.now() + 30000) return hit.token;
    const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: dec(link.refresh_enc) }) });
    const t = await r.json().catch(() => ({}));
    if (!r.ok || !t.access_token) { const e = new Error(t.error === "invalid_grant" ? "Google Drive access was removed. Connect it again on your profile." : "Could not reach Google Drive."); e.revoked = t.error === "invalid_grant"; throw e; }
    cache.set(String(link.account_id), { token: t.access_token, until: Date.now() + Number(t.expires_in || 3600) * 1000 });
    return t.access_token;
  }
  async function call(link, method, url, { json, body, headers } = {}) {
    const tok = await accessToken(link);
    const r = await fetch(url, { method, headers: { Authorization: "Bearer " + tok, ...(json ? { "Content-Type": "application/json" } : {}), ...(headers || {}) }, body: json ? JSON.stringify(json) : body });
    if (r.status === 204) return {};
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch { j = { raw: t }; }
    if (!r.ok) { const e = new Error((j.error && (j.error.message || j.error)) || "Google Drive error " + r.status); e.status = r.status; e.reason = j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason; throw e; }
    return j;
  }
  async function folder(link, name, parent) {
    const qq = `name='${q(name)}' and mimeType='${folderMime}' and trashed=false` + (parent ? ` and '${q(parent)}' in parents` : " and 'root' in parents");
    const f = await call(link, "GET", "https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({ q: qq, fields: "files(id)", pageSize: "1", spaces: "drive" }));
    if (f.files && f.files[0]) return f.files[0].id;
    return (await call(link, "POST", "https://www.googleapis.com/drive/v3/files?fields=id", { json: { name, mimeType: folderMime, ...(parent ? { parents: [parent] } : {}) } })).id;
  }
  // The folder for one project (created on first use, ids are remembered).
  async function projectFolder(link, slug) {
    const f = link.folders || {}; if (f[slug]) return f[slug];
    const root = f.__root || (f.__root = await folder(link, "AutoAuth"));
    const id = await folder(link, slug.replace(/\//g, " - "), root); f[slug] = id;
    await pool.query("UPDATE drive_links SET folders=$2 WHERE account_id=$1", [link.account_id, JSON.stringify(f)]); link.folders = f;
    return id;
  }
  async function find(link, parent, name) {
    const f = await call(link, "GET", "https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({ q: `name='${q(name)}' and '${q(parent)}' in parents and trashed=false`, fields: "files(id)", pageSize: "1" }));
    return f.files && f.files[0] ? f.files[0].id : null;
  }
  const withLink = async (accountId, fn) => { const link = await linkOf(accountId); if (!link) { const e = new Error("Google Drive is not connected."); e.noLink = true; throw e; } return fn(link); };

  // Create or replace one file.
  const put = (accountId, slug, name, content) => withLink(accountId, async (link) => {
    const parent = await projectFolder(link, slug), id = await find(link, parent, name);
    if (id) return call(link, "PATCH", `https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media&fields=id`, { body: content, headers: { "Content-Type": "application/json" } });
    const b = "aa" + crypto.randomBytes(12).toString("hex");
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent], mimeType: "application/json" })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${b}--`;
    return call(link, "POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { body, headers: { "Content-Type": `multipart/related; boundary=${b}` } });
  });
  const getText = async (link, id) => { const tok = await accessToken(link); const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: "Bearer " + tok } }); return r.ok ? r.text() : null; };
  const get = (accountId, slug, name) => withLink(accountId, async (link) => { const id = await find(link, await projectFolder(link, slug), name); return id ? getText(link, id) : null; });
  // Files whose name starts with prefix (newest first), with contents. Capped so a page stays fast.
  const list = (accountId, slug, prefix, cap = 300) => withLink(accountId, async (link) => {
    const parent = await projectFolder(link, slug), out = []; let page = "";
    do {
      const f = await call(link, "GET", "https://www.googleapis.com/drive/v3/files?" + new URLSearchParams({ q: `name contains '${q(prefix)}' and '${q(parent)}' in parents and trashed=false`, fields: "nextPageToken,files(id,name,modifiedTime)", pageSize: "200", orderBy: "modifiedTime desc", ...(page ? { pageToken: page } : {}) }));
      for (const x of f.files || []) if (x.name.startsWith(prefix) && out.length < cap) out.push(x);
      page = out.length < cap ? f.nextPageToken || "" : "";
    } while (page);
    const rows = []; for (let i = 0; i < out.length; i += 8) rows.push(...(await Promise.all(out.slice(i, i + 8).map(async (x) => ({ name: x.name, modified: x.modifiedTime, text: await getText(link, x.id).catch(() => null) })))));
    return rows;
  });
  const del = (accountId, slug, names) => withLink(accountId, async (link) => { const parent = await projectFolder(link, slug); for (const n of names) { const id = await find(link, parent, n); if (id) await call(link, "DELETE", `https://www.googleapis.com/drive/v3/files/${id}`).catch(() => {}); } });
  async function disconnect(accountId) {
    const link = await linkOf(accountId); if (!link) return;
    try { await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: dec(link.refresh_enc) }) }); } catch {}
    cache.delete(String(accountId)); await pool.query("DELETE FROM drive_links WHERE account_id=$1", [accountId]);
  }

  // ---- connect flow (project accounts) ----
  function mountPublic(app, { authPage }) {
    const fail = (res, msg, back) => res.status(400).set("Cache-Control", "no-store").send(authPage({ title: "Google Drive", sub: "Could not connect Google Drive", error: msg, top: "", form: "", foot: `<a class="alt" href="${back}">Back</a>` }).replace('<div class="or"><span></span>or<span></span></div>', ""));
    app.get("/auth/google/drive/start", async (req, res) => {
      const s = req.session && req.session.acct; if (!s) return res.redirect(303, "/login");
      const back = `/dashboard/${s.username}/profile`;
      if (!on()) return fail(res, "Google is not set up on this site yet.", back);
      if (limited("gd:" + req.ip, 20, 600000)) return res.status(429).send("Too many attempts. Try again later.");
      const state = crypto.randomBytes(16).toString("hex");
      req.session.gd = { state, until: Date.now() + 10 * 60 * 1000 }; await save(req);
      const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID); u.searchParams.set("response_type", "code"); u.searchParams.set("redirect_uri", redirectUri());
      u.searchParams.set("scope", SCOPE); u.searchParams.set("state", state); u.searchParams.set("access_type", "offline"); u.searchParams.set("prompt", "consent");
      res.set("Cache-Control", "no-store").redirect(303, u.toString());
    });
    app.get("/auth/google/drive/callback", async (req, res) => {
      res.set({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
      const s = req.session && req.session.acct, o = req.session && req.session.gd; if (!s) return res.redirect(303, "/login");
      const back = `/dashboard/${s.username}/profile`;
      if (!o || o.until < Date.now() || typeof req.query.state !== "string" || req.query.state !== o.state) return fail(res, "This connection expired or was opened twice. Please try again.", back);
      delete req.session.gd; await save(req);
      if (req.query.error) return res.redirect(303, back);
      if (typeof req.query.code !== "string" || !req.query.code) return fail(res, "Google did not return a code.", back);
      try {
        const t = await (await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: req.query.code, redirect_uri: redirectUri(), client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET }) })).json();
        if (!t.access_token) return fail(res, "Google rejected the connection.", back);
        if (!t.refresh_token) return fail(res, "Google did not allow offline access. Remove AutoAuth from your Google account's connected apps and try again.", back);
        if (!String(t.scope || "").includes("drive.file")) return fail(res, "Drive access was not granted. Tick the Drive permission on Google's screen.", back);
        let email = ""; try { const me = await (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + t.access_token } })).json(); email = me.email || ""; } catch {}
        await pool.query("INSERT INTO drive_links(account_id,email,refresh_enc,folders) VALUES($1,$2,$3,'{}') ON CONFLICT(account_id) DO UPDATE SET email=$2,refresh_enc=$3,folders='{}',linked_at=NOW()", [s.id, email.slice(0, 200), enc(t.refresh_token)]);
        cache.delete(String(s.id));
        try { await withLink(s.id, (link) => folder(link, "AutoAuth")); } // proves the Drive API is switched on for this Google project
        catch (e) { await pool.query("DELETE FROM drive_links WHERE account_id=$1", [s.id]); await log("drive_connect_failed", { error: e.message, reason: e.reason || "" }); return fail(res, e.reason === "accessNotConfigured" || e.status === 403 ? "Google Drive is not switched on for this site's Google project yet. The site owner needs to enable the Google Drive API." : "Could not use Google Drive: " + e.message, back); }
        req.session.flash = "Google Drive connected."; await save(req);
        res.redirect(303, back);
      } catch (e) { console.error(e); await log("drive_connect_error", { error: e.message }); fail(res, "Something went wrong. Please try again.", back); }
    });
  }

  function card({ link, base, hasDriveProjects }) {
    const body = !on() ? '<p class="muted">Google is not set up on this site yet.</p>'
      : link ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px"><div style="flex:1;min-width:140px"><b>Connected</b><div class="muted">${esc(link.email || "Google account")}</div></div><form method="post" action="${esc(base)}/drive/unlink" style="margin:0"><button class="secondary" style="width:auto">Disconnect</button></form></div>${hasDriveProjects ? '<p class="muted" style="margin-bottom:0">Disconnecting stops saving new data for projects that use Google Drive. Files already in your Drive stay there.</p>' : ""}`
      : `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px"><div style="flex:1;min-width:140px"><b>Not connected</b></div><a class="btn" href="/auth/google/drive/start" style="width:auto">Connect Google Drive</a></div>`;
    return `<div class="card" style="max-width:560px;margin-top:16px"><h2>Google Drive storage</h2><p class="muted" style="margin-top:0">Save the data your projects collect (emails, connections and so on) as files in your own Google Drive. Free for everyone. AutoAuth can only see the files it creates in an AutoAuth folder.</p>${body}</div>`;
  }
  return { on, linkOf, put, get, list, del, disconnect, mountPublic, card };
};
