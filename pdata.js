"use strict";
// Data tabs for account projects (emails, connections, servers, webhooks), the add-to-server tool, and the abuse flagging system.
// Flagging only applies to account-owned side projects.
const crypto = require("node:crypto");

const DATA = {
  email: { scope: "email", label: "Emails", cols: ["User", "Email", "Verified"] },
  connections: { scope: "connections", label: "Connections", cols: ["User", "Service", "Name", "Verified"] },
  guilds: { scope: "guilds", label: "Servers", cols: ["User", "Servers", "Names"] },
  webhook: { scope: "webhook.incoming", label: "Webhooks", cols: ["User", "Channel ID", "Server ID"] },
  openid: { scope: "openid", label: "OpenID", cols: ["User", "Subject", "Issued"] },
  entitlements: { scope: "applications.entitlements", label: "Entitlements", cols: ["User", "SKU", "Type", "Starts", "Ends"] },
  members: { scope: "guilds.members.read", label: "Server membership", cols: ["User", "Server", "Nickname", "Roles", "Joined"] },
};
// Permissions whose tools act as the person who authorized, so their token is kept (encrypted) too.
const TOKEN_SCOPES = new Set(["guilds.join", "role_connections.write", "applications.commands.permissions.update"]);
const wantsToken = (scope) => String(scope).split(/[ ,]+/).some((x) => TOKEN_SCOPES.has(x));
const HOOK_URL = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d{5,25}\/[\w-]{20,200}$/; // only real Discord webhooks are ever called
// Webhook URLs must be Discord's own, so the server can never be made to call somewhere else.
const DISCORD_HOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{17,20}\/[\w-]+$/;
const DATA_SCOPES = new Set([...Object.values(DATA).map((d) => d.scope), ...TOKEN_SCOPES]);
const LIMITS = () => ({ guilds: Number(process.env.FLAG_GUILDS_24H) || 30, members: Number(process.env.FLAG_MEMBERS_1H) || 100 });

module.exports = function createPdata({ pool, enc, dec, log, express, esc, origin, site, drive }) {
  const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);
  const hits = new Map();
  const limited = (k, max, ms = 60000) => { const n = Date.now(), h = hits.get(k); if (!h || h.until < n) { hits.set(k, { n: 1, until: n + ms }); return false; } return ++h.n > max; };
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.until < n) hits.delete(k); }, 60000).unref();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isDrive = (p) => !!(drive && (p.config || {}).storage === "drive");
  // Whose Google Drive: the project account's, or the dashboard login that made the project.
  const dsub = (p) => (p.owner_account ? p.owner_account : "o:" + (p.created_by || ""));
  const scopesOf = (p) => String((p.config || {}).scopes || "").split(" ").filter(Boolean);

  // Tabs shown on a project's dashboard.
  function tabsFor(p) {
    if (p.type !== "oauth") return [];
    const sc = scopesOf(p), out = [], store = !!(p.config || {}).store;
    if (store) {
      for (const [k, d] of Object.entries(DATA)) if (sc.includes(d.scope)) out.push(["data/" + k, d.label]);
      if (sc.includes("guilds.join")) out.push(["join", "Add to server"]);
    }
    if (sc.includes("bot")) out.push(["perm/bot", "Add bot"]);
    if (sc.includes("applications.commands") || sc.includes("applications.commands.update")) out.push(["perm/commands", "Commands"]);
    if (store && sc.includes("applications.commands.permissions.update")) out.push(["perm/permissions", "Command permissions"]);
    if (sc.includes("role_connections.write")) out.push(["perm/roles", "Linked roles"]);
    return out;
  }

  // Servers the project's bot is in (needs the bot token), for the server picker.
  const botGuilds = async (c) => {
    const r = await fetch("https://discord.com/api/v10/users/@me/guilds?limit=200&with_counts=true", { headers: { Authorization: "Bot " + dec(c.bot_token_enc) } });
    if (!r.ok) { const e = new Error(r.status === 401 ? "Discord rejected the bot token. Check it in this project's settings." : "Could not list the bot's servers (" + r.status + ")."); e.status = 400; throw e; }
    return (await r.json()).map((g) => ({ id: g.id, name: g.name, members: g.approximate_member_count || 0, icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : "" }));
  };

  // Called by the OAuth callback: keeps the data each selected permission returned.
  async function collect(p, u, t) {
    const sc = String(t.scope || "").split(/[ ,]+/), drv = isDrive(p), uname = u.global_name || u.username || u.id;
    const put = (kind, data) => drv
      ? drive.put(dsub(p), p.slug, `${kind}-${u.id}.json`, JSON.stringify({ user_id: u.id, username: uname, updated: new Date().toISOString(), data }, null, 2))
      : pool.query("INSERT INTO project_data(slug,user_id,kind,data_enc) VALUES($1,$2,$3,$4) ON CONFLICT(slug,user_id,kind) DO UPDATE SET data_enc=$4,updated_at=NOW()", [p.slug, u.id, kind, enc(JSON.stringify(data))]);
    const get = async (path) => { const r = await fetch("https://discord.com/api/v10" + path, { headers: { Authorization: `Bearer ${t.access_token}` } }); return r.ok ? r.json() : null; };
    try {
      if (sc.includes("email") && u.email) await put("email", { email: u.email, verified: !!u.verified });
      if (sc.includes("connections")) { const l = await get("/users/@me/connections"); if (Array.isArray(l)) await put("connections", l.map((x) => ({ type: x.type, name: x.name, verified: !!x.verified }))); }
      if (sc.includes("guilds")) { const l = await get("/users/@me/guilds"); if (Array.isArray(l)) await put("guilds", l.map((g) => ({ id: g.id, name: g.name, owner: !!g.owner }))); }
      if (sc.includes("openid") && t.id_token) { try { const c = JSON.parse(Buffer.from(String(t.id_token).split(".")[1], "base64url").toString()); await put("openid", { sub: c.sub || u.id, iat: c.iat || 0, exp: c.exp || 0 }); } catch {} }
      if (sc.includes("applications.entitlements") && (p.config || {}).client_id) { const l = await get(`/users/@me/applications/${p.config.client_id}/entitlements`); if (Array.isArray(l)) await put("entitlements", l.map((x) => ({ sku: x.sku_id, type: x.type, starts: x.starts_at || "", ends: x.ends_at || "" }))); }
      if (sc.includes("guilds.members.read") && (p.config || {}).bot_token_enc) { // the servers your bot is in, and this person's nickname, roles and join date in each
        const out = []; for (const g of (await botGuilds(p.config)).slice(0, 25)) { const m = await get(`/users/@me/guilds/${g.id}/member`); if (m) out.push({ guild: g.name, nick: m.nick || "", roles: (m.roles || []).length, joined: m.joined_at || "" }); }
        await put("members", out);
      }
      if (t.webhook && HOOK_URL.test(String(t.webhook.url || ""))) await put("webhook", { id: t.webhook.id, channel_id: t.webhook.channel_id, guild_id: t.webhook.guild_id, url: t.webhook.url });
      // Google Drive projects keep the add-to-server tokens (encrypted) in the same Drive folder, never in our database.
      if (drv && sc.some((x) => TOKEN_SCOPES.has(x))) await drive.put(dsub(p), p.slug, `token-${u.id}.json`, JSON.stringify({ enc: enc(JSON.stringify({ a: t.access_token, r: t.refresh_token || "", e: Date.now() + Number(t.expires_in || 604800) * 1000 })) }));
    } catch (e) {
      console.error("project data", e.message);
      if (drv) await pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,'drive_error',$2)", [p.slug, JSON.stringify({ error: String(e.message).slice(0, 200) })]).catch(() => {});
    }
  }

  const rowsFor = async (p, kind) => {
    if (isDrive(p)) {
      const files = await drive.list(dsub(p), p.slug, kind + "-");
      return files.map((f) => { let j = null; try { j = JSON.parse(f.text); } catch {} return j ? { user: j.username || j.user_id, id: String(j.user_id), data: j.data } : null; }).filter(Boolean);
    }
    return (await pool.query("SELECT d.user_id,u.username,d.data_enc,d.updated_at FROM project_data d LEFT JOIN side_project_users u ON u.slug=d.slug AND u.user_id=d.user_id WHERE d.slug=$1 AND d.kind=$2 ORDER BY d.updated_at DESC LIMIT 1000", [p.slug, kind])).rows
      .map((r) => { let data = null; try { data = JSON.parse(dec(r.data_enc)); } catch {} return { user: r.username || r.user_id, id: r.user_id, data }; });
  };
  const cells = (kind, r) => {
    const d = r.data; if (!d) return [];
    if (kind === "email") return [[r.user, d.email, d.verified ? "Yes" : "No"]];
    if (kind === "connections") return d.map((x) => [r.user, x.type, x.name, x.verified ? "Yes" : "No"]);
    if (kind === "guilds") return [[r.user, String(d.length), d.slice(0, 8).map((g) => g.name).join(", ") + (d.length > 8 ? "…" : "")]];
    if (kind === "openid") return [[r.user, d.sub, d.iat ? new Date(d.iat * 1000).toISOString().slice(0, 16).replace("T", " ") : ""]];
    if (kind === "entitlements") return d.length ? d.map((x) => [r.user, x.sku, String(x.type), x.starts, x.ends]) : [[r.user, "None", "", "", ""]];
    if (kind === "members") return d.map((x) => [r.user, x.guild, x.nick, String(x.roles), x.joined ? String(x.joined).slice(0, 10) : ""]);
    return [[r.user, d.channel_id, d.guild_id]];
  };
  const table = (heads, rows) => `<div class="card"><div class="wrap"><table class="stack"><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c, i) => `<td data-l="${esc(heads[i])}">${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${heads.length}">Nothing yet.</td></tr>`}</table></div></div>`;
  const csvCell = (v) => { v = String(v ?? ""); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };

  // ---------- add users to a server (guilds.join) ----------
  async function freshToken(p, row) {
    const c = p.config || {}, drv = isDrive(p);
    let cur;
    if (drv) {
      const txt = await drive.get(dsub(p), p.slug, `token-${row.user_id}.json`); if (!txt) return null;
      try { const j = JSON.parse(dec(JSON.parse(txt).enc)); cur = { access: j.a, refresh: j.r, exp: Number(j.e) }; } catch { return null; }
    } else cur = { access: dec(row.access_token_enc), refresh: row.refresh_token_enc ? dec(row.refresh_token_enc) : "", exp: Number(row.expires_at) };
    if (cur.exp > Date.now() + 60000) return cur.access;
    if (!cur.refresh) return null;
    const r = await fetch("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.client_id, client_secret: dec(c.client_secret_enc), grant_type: "refresh_token", refresh_token: cur.refresh }) });
    const t = await r.json(); if (!r.ok || !t.access_token) return null;
    const exp = Date.now() + Number(t.expires_in || 604800) * 1000;
    if (drv) await drive.put(dsub(p), p.slug, `token-${row.user_id}.json`, JSON.stringify({ enc: enc(JSON.stringify({ a: t.access_token, r: t.refresh_token || cur.refresh, e: exp })) }));
    else await pool.query("UPDATE side_project_users SET access_token_enc=$3,refresh_token_enc=$4,expires_at=$5 WHERE slug=$1 AND user_id=$2", [p.slug, row.user_id, enc(t.access_token), enc(t.refresh_token || ""), exp]);
    return t.access_token;
  }

  // ---------- flagging ----------
  async function flagReason(p, guild, planned) {
    const L = LIMITS();
    const g = (await pool.query("SELECT COUNT(DISTINCT detail->>'guild')::int n, BOOL_OR(detail->>'guild'=$2) AS has FROM project_logs WHERE slug=$1 AND event_type='join' AND created_at>NOW()-INTERVAL '24 hours'", [p.slug, guild])).rows[0];
    if ((g.n || 0) + (g.has ? 0 : 1) >= L.guilds) return `Members were added to ${L.guilds} or more servers within 24 hours.`;
    const m = (await pool.query("SELECT COUNT(*)::int n FROM project_logs WHERE slug=$1 AND event_type='join' AND created_at>NOW()-INTERVAL '1 hour'", [p.slug])).rows[0].n;
    if (m + planned > L.members) return `More than ${L.members} members were added within one hour.`;
    return "";
  }
  async function flag(p, reason, sendDm) {
    const name = p.name;
    await pool.query("UPDATE side_projects SET locked=true WHERE slug=$1", [p.slug]);
    const users = (await pool.query("SELECT DISTINCT detail->>'user' AS u FROM project_logs WHERE slug=$1 AND event_type='join' AND created_at>NOW()-INTERVAL '24 hours' LIMIT 500", [p.slug])).rows.map((r) => r.u).filter(Boolean);
    const f = (await pool.query("INSERT INTO project_flags(slug,account_id,project_name,reason,affected) VALUES($1,$2,$3,$4,$5) RETURNING id", [p.slug, p.owner_account, name, reason, users.length])).rows[0];
    await pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,'project_flagged',$2)", [p.slug, JSON.stringify({ reason })]);
    await pool.query("INSERT INTO support_messages(account_id,from_admin,sender,body,read_admin) VALUES($1,true,'Support',$2,true)", [p.owner_account,
      `Your project "${name}" was locked by an automatic safety check: ${reason}\n\nYou handle sensitive data in your projects. We cannot see that data or your dashboard, so we act only on these automatic signals and on reports from affected people. People who were added to servers have been sent an apology and asked to come forward with any evidence. If this is a mistake, reply here with details.`]);
    await log("project_flagged", { project: p.slug.split("/")[0] + "/…", reason });
    if (sendDm) (async () => {
      const text = `We are sorry. A project hosted on AutoAuth used your Discord authorization to add you to many servers, and our automatic safety check has locked it. If this was not what you expected, or you have evidence of misuse, please come forward here: ${origin()}/report/${f.id}`;
      for (const id of users) { try { await sendDm(id, { content: text }); } catch {} await sleep(1100); }
    })();
    return f.id;
  }


  // ---------- change where a project keeps its data (database or Google Drive), optionally moving what is already stored ----------
  const storageCard = (a, p) => {
    if (p.type !== "oauth" || !(p.config || {}).store) return "";
    const cur = isDrive(p) ? "drive" : "database", base = `/dashboard/${a.username}/${p.slug.slice(a.pfx)}`;
    return `<div class="card" style="margin-top:16px"><h2>Storage</h2><p class="muted" style="margin-top:0">Where this project keeps the users and data it collects. Now: <b>${cur === "drive" ? "Google Drive" : "Our database"}</b>.</p>
<label>Keep data in</label><select id="st-to"><option value="database"${cur === "database" ? " selected" : ""}>Our database (encrypted, limited by plan)</option><option value="drive"${cur === "drive" ? " selected" : ""}>Google Drive (free for everyone)</option></select>
<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" id="st-move" checked style="width:auto"> Move the data that is already stored</label>
<button type="button" class="green" id="st-go">Change storage</button><div id="st-out" class="muted" style="margin-top:10px;white-space:pre-wrap"></div>
<script>document.addEventListener('DOMContentLoaded',function(){document.getElementById('st-go').addEventListener('click',async function(){var b=this,o=document.getElementById('st-out');b.disabled=true;o.textContent='Working...';
try{var r=await fetch('${base}/storage',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({to:document.getElementById('st-to').value,move:document.getElementById('st-move').checked})}),j=await r.json().catch(function(){return{};});
if(r.ok){location.reload();}else{o.textContent=j.error||'Something went wrong.';b.disabled=false;}}catch(e){o.textContent=e.message;b.disabled=false;}});});</script></div>`;
  };
  async function moveData(p, to) {
    const sub = dsub(p), users = (await pool.query("SELECT user_id,username,scope,access_token_enc,refresh_token_enc,expires_at FROM side_project_users WHERE slug=$1", [p.slug])).rows, name = Object.fromEntries(users.map((u) => [u.user_id, u.username || u.user_id]));
    let moved = 0;
    if (to === "drive") {
      const rows = (await pool.query("SELECT user_id,kind,data_enc FROM project_data WHERE slug=$1", [p.slug])).rows;
      for (const r of rows) {
        let data = null; try { data = JSON.parse(dec(r.data_enc)); } catch {}
        if (data === null) continue;
        await drive.put(sub, p.slug, `${r.kind}-${r.user_id}.json`, JSON.stringify({ user_id: r.user_id, username: name[r.user_id] || r.user_id, updated: new Date().toISOString(), data }, null, 2)); moved++;
      }
      for (const u of users) {
        let a = ""; try { a = u.access_token_enc ? dec(u.access_token_enc) : ""; } catch {}
        if (!a || !wantsToken(u.scope)) continue;
        let r = ""; try { r = u.refresh_token_enc ? dec(u.refresh_token_enc) : ""; } catch {}
        await drive.put(sub, p.slug, `token-${u.user_id}.json`, JSON.stringify({ enc: enc(JSON.stringify({ a, r, e: Number(u.expires_at) })) }));
      }
      await pool.query("DELETE FROM project_data WHERE slug=$1", [p.slug]);
      await pool.query("UPDATE side_project_users SET access_token_enc=$2,refresh_token_enc=$2 WHERE slug=$1", [p.slug, enc("")]); // Drive projects keep no tokens in the database
    } else {
      const gone = [];
      for (const kind of Object.keys(DATA)) for (const f of await drive.list(sub, p.slug, kind + "-", 2000)) {
        let j = null; try { j = JSON.parse(f.text); } catch {}
        if (!j || !j.user_id) continue;
        await pool.query("INSERT INTO project_data(slug,user_id,kind,data_enc) VALUES($1,$2,$3,$4) ON CONFLICT(slug,user_id,kind) DO UPDATE SET data_enc=$4,updated_at=NOW()", [p.slug, String(j.user_id), kind, enc(JSON.stringify(j.data))]);
        gone.push(f.name); moved++;
      }
      for (const f of await drive.list(sub, p.slug, "token-", 2000)) {
        let t = null; try { t = JSON.parse(dec(JSON.parse(f.text).enc)); } catch {}
        const uid = String(f.name).replace(/^token-/, "").replace(/\.json$/, "");
        if (!t || !/^\d+$/.test(uid)) continue;
        await pool.query("UPDATE side_project_users SET access_token_enc=$3,refresh_token_enc=$4,expires_at=$5 WHERE slug=$1 AND user_id=$2", [p.slug, uid, enc(t.a || ""), enc(t.r || ""), Number(t.e) || 0]);
        gone.push(f.name);
      }
      if (gone.length) await drive.del(sub, p.slug, gone).catch(() => {});
    }
    return moved;
  }

  function mount({ app, acctOnly, verifyOrigin, page, sub, own, json, sendDm, scopeInfo }) {
    const base = (a, p) => `/dashboard/${a.username}/${p.slug.slice(a.pfx)}`;


    app.post("/dashboard/:u/:name/storage", acctOnly, verifyOrigin, json, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name); if (!p) return res.status(404).json({ error: "Project not found." });
      if (p.locked) return res.status(403).json({ error: "This project is locked." });
      if (p.type !== "oauth" || !(p.config || {}).store) return res.status(400).json({ error: "This project does not store data." });
      const to = (req.body || {}).to === "drive" ? "drive" : "database", move = (req.body || {}).move !== false, cur = isDrive(p) ? "drive" : "database";
      if (to === cur) return res.status(400).json({ error: "The project already uses that storage." });
      if (limited("st:" + a.id, 6, 3600000)) return res.status(429).json({ error: "Slow down." });
      try {
        if (!drive || !drive.on()) return res.status(400).json({ error: "Google Drive is not set up on this site yet." });
        if (!(await drive.linkOf(dsub(p)))) return res.status(400).json({ error: "Connect Google Drive on your profile page first." });
        const moved = move ? await moveData(p, to) : 0;
        await pool.query("UPDATE side_projects SET config=config || $2::jsonb WHERE slug=$1", [p.slug, JSON.stringify({ storage: to })]);
        await pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,'storage_changed',$2)", [p.slug, JSON.stringify({ from: cur, to, moved })]);
        res.json({ ok: true, moved });
      } catch (e) { console.error("storage", e.message); res.status(500).json({ error: e.noLink ? "Connect Google Drive first." : "Could not change storage: " + String(e.message).slice(0, 160) + " Nothing was lost; try again." }); }
    });

    // ---------- permission tools: Add bot, Commands, Command permissions, Linked roles ----------
    const PAGES = { bot: ["bot"], commands: ["applications.commands", "applications.commands.update"], permissions: ["applications.commands.permissions.update"], roles: ["role_connections.write"] };
    const ID = /^\d{17,20}$/, hasAny = (p, list) => list.some((x) => scopesOf(p).includes(x));
    const appAuth = async (c) => {
      if (c.bot_token_enc) return "Bot " + dec(c.bot_token_enc);
      const r = await fetch("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(c.client_id + ":" + dec(c.client_secret_enc)).toString("base64") }, body: new URLSearchParams({ grant_type: "client_credentials", scope: "applications.commands.update" }) });
      const t = await r.json().catch(() => ({}));
      if (!r.ok || !t.access_token) { const e = new Error("Discord would not issue an app token. Check the client ID and client secret in this project's settings."); e.status = 400; throw e; }
      return "Bearer " + t.access_token;
    };
    const dj = async (url, method, auth, body) => {
      const r = await fetch("https://discord.com/api/v10" + url, { method, headers: { Authorization: auth, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
      if (!r.ok) { const e = new Error((j && j.message) || "Discord error " + r.status); e.status = r.status; throw e; }
      return j;
    };
    const jsonOf = (v, kind) => { let j; try { j = JSON.parse(String(v || "")); } catch { throw Object.assign(new Error("That is not valid JSON."), { status: 400 }); } if (kind === "array" ? !Array.isArray(j) : (!j || typeof j !== "object" || Array.isArray(j))) throw Object.assign(new Error(kind === "array" ? "Expected a JSON list, like [ ... ]." : "Expected a JSON object, like { ... }."), { status: 400 }); if (JSON.stringify(j).length > 12000) throw Object.assign(new Error("That is too large."), { status: 400 }); return j; };
    const needBot = '<div class="card"><b>Add your bot token in this project\'s settings first.</b> This tool calls Discord as your bot.</div>';
    const userPick = (rows, id) => `<select id="${id}">${rows.map((u) => `<option value="${esc(u.user_id)}">${esc(u.username || u.user_id)}</option>`).join("") || '<option value="">No one authorized with this permission yet</option>'}</select>`;
    const act = (base) => `<script>async function pa(b,body,ok){b.disabled=true;var o=document.getElementById('pa-out');o.textContent='Working...';try{var r=await fetch('${base}/perm-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),j=await r.json().catch(function(){return{};});if(r.ok){o.textContent=ok||'Done.';if(j.reload)setTimeout(function(){location.reload();},700);}else{o.textContent=j.error||'Something went wrong.';}}catch(e){o.textContent=e.message;}b.disabled=false;}</script><div id="pa-out" class="muted" style="margin-top:12px;white-space:pre-wrap"></div>`;
    const tokenUsers = async (p, scope) => (await pool.query("SELECT user_id,username,scope FROM side_project_users WHERE slug=$1 ORDER BY created_at DESC LIMIT 500", [p.slug])).rows.filter((u) => String(u.scope).split(/[ ,]+/).includes(scope));

    app.get("/dashboard/:u/:name/perm/:page", acctOnly, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name), pg = req.params.page; if (!p || !PAGES[pg] || !hasAny(p, PAGES[pg])) return res.status(404).send("Not found");
      const c = p.config || {}, base = `/dashboard/${a.username}/${p.slug.slice(a.pfx)}`, head = sub(a, p, "perm/" + pg), tabName = { bot: "Add bot", commands: "Commands", permissions: "Command permissions", roles: "Linked roles" }[pg];
      let body = "";
      try {
        if (pg === "bot") {
          const link = (n) => `https://discord.com/oauth2/authorize?${new URLSearchParams({ client_id: c.client_id, scope: "bot applications.commands", permissions: n })}`;
          let list = c.bot_token_enc ? "" : '<p class="muted">Add your bot token in this project\'s settings to see the servers your bot is in.</p>';
          if (c.bot_token_enc) { const gs = await botGuilds(c); list = `<div class="wrap"><table class="stack"><tr><th>Server</th><th>ID</th><th>Members</th><th></th></tr>${gs.map((g) => `<tr><td data-l="Server">${esc(g.name)}</td><td data-l="ID">${esc(g.id)}</td><td data-l="Members">${esc(g.members || "")}</td><td><button type="button" class="danger" data-g="${esc(g.id)}" data-n="${esc(g.name)}" onclick="if(confirm('Make the bot leave '+this.dataset.n+'?'))pa(this,{action:'leave',guild:this.dataset.g},'The bot left.')">Leave</button></td></tr>`).join("") || '<tr><td colspan="4">The bot is not in any servers.</td></tr>'}</table></div>`; }
          body = `<div class="card"><h2>Invite your bot</h2><p class="muted" style="margin-top:0">Send this link to a server owner. Set the permissions number below (0 asks for none, 8 is Administrator).</p><label>Permissions number</label><input id="bt-perm" value="0" inputmode="numeric" maxlength="20"><p><code id="bt-link" style="word-break:break-all">${esc(link("0"))}</code></p><button type="button" class="secondary" id="bt-copy">Copy link</button></div><div class="card"><h2>Servers your bot is in</h2>${list}</div>${act(base)}
<script>document.addEventListener('DOMContentLoaded',function(){var i=$('bt-perm'),l=$('bt-link');function u(){var n=/^\\d{1,20}$/.test(i.value)?i.value:'0';l.textContent=${JSON.stringify(link("__N__"))}.replace('__N__',n);}i.addEventListener('input',u);$('bt-copy').addEventListener('click',function(){(navigator.clipboard?navigator.clipboard.writeText(l.textContent):Promise.reject()).then(function(){toast('Link copied.');},function(){showMsg('Link',l.textContent);});});});</script>`;
        } else if (pg === "commands") {
          const cmds = await dj(`/applications/${c.client_id}/commands`, "GET", await appAuth(c));
          body = `<div class="card"><h2>Global slash commands</h2><div class="wrap"><table class="stack"><tr><th>Name</th><th>Description</th><th>ID</th><th></th></tr>${(Array.isArray(cmds) ? cmds : []).map((x) => `<tr><td data-l="Name">/${esc(x.name)}</td><td data-l="Description">${esc(x.description || "")}</td><td data-l="ID">${esc(x.id)}</td><td><button type="button" class="danger" data-i="${esc(x.id)}" data-n="${esc(x.name)}" onclick="if(confirm('Delete /'+this.dataset.n+'?'))pa(this,{action:'cmd-delete',id:this.dataset.i},'Deleted.')">Delete</button></td></tr>`).join("") || '<tr><td colspan="4">No commands yet.</td></tr>'}</table></div></div>
<div class="card"><h2>Add or replace a command</h2><p class="muted" style="margin-top:0">A command with the same name is replaced. Discord can take a minute to show changes.</p><textarea id="cm-json" spellcheck="false">{\n  "name": "ping",\n  "description": "Reply with pong",\n  "type": 1\n}</textarea><button type="button" class="green" onclick="pa(this,{action:'cmd-create',json:$('cm-json').value},'Saved.')">Save command</button></div>${act(base)}`;
        } else if (pg === "permissions") {
          body = `<div class="card"><h2>Command permissions</h2><p class="muted" style="margin-top:0">Needs someone who is a server admin and authorized this project with this permission. Use the application ID as the command ID to set the default for all commands.</p>
<label>Authorized admin</label>${userPick(await tokenUsers(p, "applications.commands.permissions.update"), "cp-user")}<label>Server ID</label><input id="cp-guild" inputmode="numeric" maxlength="20"><label>Command ID</label><input id="cp-cmd" inputmode="numeric" maxlength="20">
<label>Permissions</label><textarea id="cp-json" spellcheck="false">[\n  { "id": "ROLE_OR_USER_ID", "type": 1, "permission": true }\n]</textarea><p class="muted">type: 1 role, 2 user, 3 channel.</p><button type="button" class="green" onclick="pa(this,{action:'perm-set',user:$('cp-user').value,guild:$('cp-guild').value.trim(),command:$('cp-cmd').value.trim(),json:$('cp-json').value},'Saved.')">Save permissions</button></div>${act(base)}`;
        } else {
          let meta = "[]", metaErr = "";
          if (c.bot_token_enc) { try { meta = JSON.stringify(await dj(`/applications/${c.client_id}/role-connections/metadata`, "GET", "Bot " + dec(c.bot_token_enc)), null, 2); } catch (e) { metaErr = e.message; } }
          body = (c.bot_token_enc ? "" : needBot) + `<div class="card"><h2>Linked roles: fields</h2><p class="muted" style="margin-top:0">The fields servers can check (up to 5). Each has a type (1 to 8), a key, a name and a description.</p>${metaErr ? `<p style="color:#ff938a">${esc(metaErr)}</p>` : ""}<textarea id="rl-meta" spellcheck="false">${esc(meta)}</textarea><button type="button" class="green" onclick="pa(this,{action:'role-meta',json:$('rl-meta').value},'Saved.')"${c.bot_token_enc ? "" : " disabled"}>Save fields</button></div>
<div class="card"><h2>Set a member's values</h2><label>Authorized member</label>${userPick(await tokenUsers(p, "role_connections.write"), "rl-user")}<label>Platform name</label><input id="rl-pn" maxlength="50" placeholder="My Game"><label>Platform username</label><input id="rl-pu" maxlength="100"><label>Values</label><textarea id="rl-vals" spellcheck="false">{ "level": 5 }</textarea><button type="button" class="green" onclick="pa(this,{action:'role-set',user:$('rl-user').value,platform_name:$('rl-pn').value,platform_username:$('rl-pu').value,json:$('rl-vals').value},'Saved.')">Save for member</button></div>${act(base)}`;
        }
      } catch (e) { body = `<div class="card"><b>Could not load this page.</b><p class="muted" style="margin-bottom:0">${esc(e.message)}</p></div>`; }
      page(req, res, "projects", head + body);
    });

    app.post("/dashboard/:u/:name/perm-action", acctOnly, verifyOrigin, json, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name); if (!p) return res.status(404).json({ error: "Project not found." });
      if (p.locked) return res.status(403).json({ error: "This project is locked." });
      if (limited("pa:" + a.id, 30)) return res.status(429).json({ error: "Slow down." });
      const b = req.body || {}, c = p.config || {}, need = { leave: PAGES.bot, "cmd-create": PAGES.commands, "cmd-delete": PAGES.commands, "perm-set": PAGES.permissions, "role-meta": PAGES.roles, "role-set": PAGES.roles }[b.action];
      if (!need || !hasAny(p, need)) return res.status(400).json({ error: "That action is not available for this project." });
      try {
        if (b.action !== "cmd-create" && b.action !== "cmd-delete" && b.action !== "perm-set" && b.action !== "role-set" && !c.bot_token_enc) return res.status(400).json({ error: "Add your bot token in this project's settings first." });
        const botAuth = () => "Bot " + dec(c.bot_token_enc);
        const userAuth = async (uid, scope) => {
          const row = (await pool.query("SELECT user_id,access_token_enc,refresh_token_enc,expires_at,scope FROM side_project_users WHERE slug=$1 AND user_id=$2", [p.slug, String(uid)])).rows[0];
          if (!row || !String(row.scope).split(/[ ,]+/).includes(scope)) throw Object.assign(new Error("Choose someone who authorized with that permission."), { status: 400 });
          const t = await freshToken(p, row); if (!t) throw Object.assign(new Error("Their saved sign-in expired. They need to authorize again."), { status: 400 });
          return "Bearer " + t;
        };
        let reload = false;
        if (b.action === "leave") { if (!ID.test(String(b.guild))) throw Object.assign(new Error("Invalid server."), { status: 400 }); await dj(`/users/@me/guilds/${b.guild}`, "DELETE", botAuth()); reload = true; }
        else if (b.action === "cmd-create") { const cmd = jsonOf(b.json, "object"); if (!/^[\w-]{1,32}$/.test(String(cmd.name || ""))) throw Object.assign(new Error("The command needs a name of 1 to 32 letters, numbers, - or _."), { status: 400 }); await dj(`/applications/${c.client_id}/commands`, "POST", await appAuth(c), cmd); reload = true; }
        else if (b.action === "cmd-delete") { if (!ID.test(String(b.id))) throw Object.assign(new Error("Invalid command."), { status: 400 }); await dj(`/applications/${c.client_id}/commands/${b.id}`, "DELETE", await appAuth(c)); reload = true; }
        else if (b.action === "perm-set") { if (!ID.test(String(b.guild)) || !ID.test(String(b.command))) throw Object.assign(new Error("Enter a valid server ID and command ID."), { status: 400 }); await dj(`/applications/${c.client_id}/guilds/${b.guild}/commands/${b.command}/permissions`, "PUT", await userAuth(b.user, "applications.commands.permissions.update"), { permissions: jsonOf(b.json, "array") }); }
        else if (b.action === "role-meta") { await dj(`/applications/${c.client_id}/role-connections/metadata`, "PUT", botAuth(), jsonOf(b.json, "array")); }
        else if (b.action === "role-set") { await dj(`/users/@me/applications/${c.client_id}/role-connection`, "PUT", await userAuth(b.user, "role_connections.write"), { platform_name: clip(b.platform_name, 50), platform_username: clip(b.platform_username, 100), metadata: jsonOf(b.json, "object") }); }
        await pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,'tool_used',$2)", [p.slug, JSON.stringify({ action: b.action })]);
        res.json({ ok: true, reload });
      } catch (e) { res.status(e.status && e.status < 500 ? (e.status === 401 || e.status === 403 ? 400 : e.status) : 502).json({ error: e.message }); }
    });

    app.get("/dashboard/:u/:name/data/:kind", acctOnly, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name); if (!p) return res.status(404).send("Not found");
      const csv = req.params.kind.endsWith(".csv"), kind = req.params.kind.replace(/\.csv$/, ""), D = DATA[kind];
      if (!D || !scopesOf(p).includes(D.scope)) return res.status(404).send("Not found");
      let rows; try { rows = (await rowsFor(p, kind)).flatMap((r) => cells(kind, r)); } catch (e) {
        return page(req, res, "projects", sub(a, p, "data/" + kind) + `<div class="card"><b>Could not read this data.</b><p class="muted" style="margin-bottom:0">${esc(e.noLink ? "This project saves to Google Drive, but Google Drive is not connected. Connect it on your Profile page." : e.message)}</p></div>`);
      }
      if (csv) return res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${kind}.csv"` }).send([D.cols, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n"));
      const extra = kind === "webhook" && rows.length ? `<div class="card" style="margin-bottom:16px"><h2>Send a message</h2><select id="wh-user">${(await rowsFor(p, "webhook")).map((r) => `<option value="${esc(r.id)}">${esc(r.user)}</option>`).join("")}</select><textarea id="wh-text" maxlength="2000" placeholder="Message" style="margin-top:8px"></textarea><button class="green" id="wh-send" style="margin-top:8px">Send</button></div><script>document.addEventListener('DOMContentLoaded',function(){$('wh-send').addEventListener('click',async function(){var r=await fetch('${base(a, p)}/webhook-send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:$('wh-user').value,text:$('wh-text').value})}),j=await r.json().catch(function(){return{}});if(r.ok){toast('Sent.');$('wh-text').value='';}else showMsg('Could not send',j.error||'Failed');});});</script>` : "";
      page(req, res, "projects", sub(a, p, "data/" + kind) + extra + `<p><a class="btn secondary" href="${base(a, p)}/data/${kind}.csv">Download CSV</a></p>` + table(D.cols, rows));
    });
    app.post("/dashboard/:u/:name/webhook-send", acctOnly, verifyOrigin, json, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name); if (!p || p.locked) return res.status(404).json({ error: "Project not found or locked." });
      if (limited("wh:" + a.id, 30)) return res.status(429).json({ error: "Slow down." });
      const text = clip((req.body || {}).text, 2000); if (!text) return res.status(400).json({ error: "Write a message first." });
      const r = (await rowsFor(p, "webhook")).find((x) => x.id === String((req.body || {}).user)); if (!r || !r.data) return res.status(404).json({ error: "No webhook for that user." });
      if (!HOOK_URL.test(String(r.data.url || ""))) return res.status(400).json({ error: "That webhook is not a Discord webhook." });
      if (!DISCORD_HOOK.test(String(r.data.url))) return res.status(400).json({ error: "That webhook address is not valid." });
      const out = await fetch(r.data.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }) });
      if (!out.ok) return res.status(502).json({ error: "Discord rejected the message (" + out.status + ")." });
      await pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,'webhook_sent','{}')", [p.slug]);
      res.json({ ok: true });
    });

    app.post("/dashboard/:u/:name/users/:uid/delete", acctOnly, verifyOrigin, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name); if (!p) return res.status(404).send("Not found");
      const uid = String(req.params.uid);
      await pool.query("DELETE FROM project_data WHERE slug=$1 AND user_id=$2", [p.slug, uid]);
      if (isDrive(p)) await drive.del(dsub(p), p.slug, [...Object.keys(DATA), "token"].map((k) => `${k}-${uid}.json`)).catch(() => {});
      await pool.query("DELETE FROM side_project_users WHERE slug=$1 AND user_id=$2", [p.slug, uid]);
      await pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,'user_removed','{}')", [p.slug]);
      res.redirect(303, base(a, p) + "/users");
    });

    app.get("/dashboard/:u/:name/servers", acctOnly, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name); if (!p) return res.status(404).json({ error: "Project not found." });
      const c = p.config || {}; if (!c.bot_token_enc) return res.status(400).json({ error: "Add your bot token in this project's settings first." });
      if (limited("sv:" + a.id, 20)) return res.status(429).json({ error: "Slow down." });
      try { res.json({ servers: await botGuilds(c) }); } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
    });
    app.get("/dashboard/:u/:name/join", acctOnly, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name); if (!p || !scopesOf(p).includes("guilds.join")) return res.status(404).send("Not found");
      const us = (await pool.query("SELECT user_id,username,scope FROM side_project_users WHERE slug=$1 ORDER BY created_at DESC LIMIT 500", [p.slug])).rows.filter((u) => String(u.scope).split(/[ ,]+/).includes("guilds.join"));
      const need = !(p.config || {}).bot_token_enc ? '<div class="card"><b>Add your bot token in this project\'s settings first.</b> It is used to list the servers your bot is in and to add people to them.</div>' : "";
      const bs = `/dashboard/${a.username}/${p.slug.slice(a.pfx)}`;
      page(req, res, "projects", sub(a, p, "join") + need + `<div class="card"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="jn-all" style="width:auto"> Select all (${us.length})</label>
<div style="max-height:300px;overflow:auto;margin-top:8px">${us.map((u) => `<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" class="jn-u" value="${esc(u.user_id)}" style="width:auto">${esc(u.username || u.user_id)}</label>`).join("") || '<p class="muted">No users yet.</p>'}</div>
<button type="button" class="green" id="jn-go" style="margin-top:12px"${need ? " disabled" : ""}>Add to a server</button><div id="jn-out" class="muted" style="margin-top:10px;white-space:pre-wrap"></div></div>
<dialog id="dlg-join"><div class="dlg-top"><h2 style="margin:0">Add users to a server</h2><button type="button" class="secondary" onclick="closeAll()">Close</button></div><p class="muted" id="jn-desc"></p><div class="dlg-list" id="jn-list"></div></dialog>
<script>document.addEventListener('DOMContentLoaded',function(){
function sel(){return [].slice.call(document.querySelectorAll('.jn-u:checked')).map(function(c){return c.value;}).slice(0,100);}
$('jn-all').addEventListener('change',function(){[].slice.call(document.querySelectorAll('.jn-u')).forEach(function(c){c.checked=$('jn-all').checked;});});
async function run(g,users){$('jn-out').textContent='Working...';closeAll();
 try{var r=await fetch('${bs}/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guild:g.id,users:users})}),j=await r.json().catch(function(){return{};});
  $('jn-out').textContent=r.ok?('Added '+j.added+' to '+g.name+', already in server '+j.already+', failed '+j.failed+'.'):(j.error||'Something went wrong.');}catch(e){$('jn-out').textContent=e.message;}}
$('jn-go').addEventListener('click',async function(){var u=sel();if(!u.length)return showMsg('Add to a server','Select at least one user (100 at a time).');
 var list=$('jn-list');list.textContent='Loading servers...';$('jn-desc').textContent='Choose the server to add '+u.length+' user'+(u.length===1?'':'s')+' to. These are the servers your bot is in.';openDlg('dlg-join');
 try{var r=await fetch('${bs}/servers'),j=await r.json().catch(function(){return{};});if(!r.ok){list.textContent=j.error||'Could not list servers.';return;}
  list.innerHTML='';if(!j.servers.length){list.textContent='The bot is not in any servers.';return;}
  j.servers.forEach(function(g){var row=mk('div','dlg-row'),info=mk('div');info.appendChild(mk('b','',g.name));info.appendChild(mk('div','muted',g.id+' \\u00b7 '+(g.members||'\\u2014')+' members')).style.fontSize='12px';
   var b=mk('button','green','Add here');b.type='button';b.onclick=function(){if(confirm('Add '+u.length+' user'+(u.length===1?'':'s')+' to '+g.name+'?'))run(g,u);};row.appendChild(info);row.appendChild(b);list.appendChild(row);});
 }catch(e){list.textContent=e.message;}});});</script>`);
    });
    app.post("/dashboard/:u/:name/join", acctOnly, verifyOrigin, json, async (req, res) => {
      const a = req.acct, p0 = await own(a, req.params.name); if (!p0 || !scopesOf(p0).includes("guilds.join")) return res.status(404).json({ error: "Project not found." });
      const p = { ...p0, owner_account: a.owner ? null : a.id }, c = p.config || {};
      if (p.locked) return res.status(403).json({ error: "This project is locked." });
      if (!c.bot_token_enc) return res.status(400).json({ error: "Add your bot token in the project settings first." });
      const guild = String((req.body || {}).guild || ""), ids = [...new Set(Array.isArray((req.body || {}).users) ? req.body.users.map(String) : [])].slice(0, 100);
      if (!/^\d{17,20}$/.test(guild)) return res.status(400).json({ error: "Enter a valid server ID." });
      if (!ids.length) return res.status(400).json({ error: "Select at least one user." });
      if (limited("jn:" + a.id, 6)) return res.status(429).json({ error: "Slow down." });
      const reason = a.owner ? "" : await flagReason(p, guild, ids.length); // automatic flagging is for sign-up accounts only
      if (reason) { await flag(p, reason, sendDm); return res.status(403).json({ error: "This project was locked by an automatic safety check. See Support.", locked: true }); }
      const rows = (await pool.query("SELECT user_id,access_token_enc,refresh_token_enc,expires_at,scope FROM side_project_users WHERE slug=$1 AND user_id=ANY($2)", [p.slug, ids])).rows;
      let added = 0, already = 0, failed = 0;
      for (const row of rows) {
        if (!String(row.scope).split(/[ ,]+/).includes("guilds.join")) { failed++; continue; }
        try {
          const tok = await freshToken(p, row); if (!tok) { failed++; continue; }
          const r = await fetch(`https://discord.com/api/v10/guilds/${guild}/members/${row.user_id}`, { method: "PUT", headers: { Authorization: "Bot " + dec(c.bot_token_enc), "Content-Type": "application/json" }, body: JSON.stringify({ access_token: tok }) });
          if (r.status === 201 || r.status === 204) { r.status === 201 ? added++ : already++; await pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,'join',$2)", [p.slug, JSON.stringify({ guild, user: row.user_id, status: r.status })]); }
          else if (r.status === 429) { failed++; break; } else failed++;
        } catch { failed++; }
        await sleep(700);
      }
      failed += ids.length - rows.length;
      res.json({ ok: true, added, already, failed });
    });
  }

  // ---------- public report page for people who were affected ----------
  function mountPublic(app) {
    const form = express.urlencoded({ extended: false, limit: "20kb" });
    const wrap = (t, b) => site.page(t, b, "");
    app.get("/report/:id", async (req, res) => {
      const f = (await pool.query("SELECT id FROM project_flags WHERE id=$1", [Number(req.params.id) || 0])).rows[0]; if (!f) return res.status(404).send("Not found");
      res.set("Cache-Control", "no-store").send(wrap("Report", `<h1>Tell us what happened</h1><p>Share anything you know about the project that added you to servers: screenshots, links, server names and dates.</p><form method="post"><label>What happened</label><textarea name="body" maxlength="4000" required style="width:100%;min-height:160px"></textarea><label>How we can reach you (optional)</label><input name="contact" maxlength="200" style="width:100%"><button class="cta" style="margin-top:14px">Send</button></form>`));
    });
    app.post("/report/:id", form, async (req, res) => {
      const id = Number(req.params.id) || 0, f = (await pool.query("SELECT id FROM project_flags WHERE id=$1", [id])).rows[0]; if (!f) return res.status(404).send("Not found");
      if (limited("rp:" + req.ip, 5, 3600000)) return res.status(429).send("Too many reports. Try again later.");
      const body = clip(req.body.body, 4000); if (!body) return res.redirect(303, "/report/" + id);
      await pool.query("INSERT INTO flag_reports(flag_id,contact,body) VALUES($1,$2,$3)", [id, clip(req.body.contact, 200), body]);
      res.send(wrap("Report", "<h1>Thank you</h1><p>Your report was sent.</p>"));
    });
  }

  // ---------- admin: flags (project names and reasons only, never project data) ----------
  async function flagsHtml() {
    const r = (await pool.query(`SELECT f.id,f.project_name,f.reason,f.affected,f.status,f.created_at,a.username,
      (SELECT COUNT(*)::int FROM flag_reports x WHERE x.flag_id=f.id) AS reports, s.locked
      FROM project_flags f LEFT JOIN accounts a ON a.id=f.account_id LEFT JOIN side_projects s ON s.slug=f.slug ORDER BY (f.status='open') DESC, f.id DESC LIMIT 100`)).rows;
    if (!r.length) return "";
    const reps = (await pool.query("SELECT flag_id,contact,body,created_at FROM flag_reports ORDER BY id DESC LIMIT 200")).rows;
    return `<h2 style="margin-top:24px">Flags</h2><div class="card">${r.map((f) => `<div style="padding:12px 0;border-bottom:1px solid var(--line)"><b>${esc(f.project_name)}</b> <span class="muted">@${esc(f.username || "deleted")} · ${esc(new Date(f.created_at).toISOString().slice(0, 16).replace("T", " "))} · ${esc(f.status)}${f.locked ? " · locked" : ""}</span><div>${esc(f.reason)} ${f.affected} people affected, ${f.reports} reports.</div>
${reps.filter((x) => x.flag_id === f.id).map((x) => `<div class="muted" style="margin:6px 0;white-space:pre-wrap">${esc(x.body)}${x.contact ? "\nContact: " + esc(x.contact) : ""}</div>`).join("")}
${f.status === "open" ? `<form method="post" action="/dashboard/support/flags/${f.id}/unlock" style="display:inline"><button class="secondary" style="width:auto">Unlock project</button></form> <form method="post" action="/dashboard/support/flags/${f.id}/resolve" style="display:inline"><button class="secondary" style="width:auto">Keep locked, mark resolved</button></form>` : ""}</div>`).join("")}</div>`;
  }
  function mountAdmin({ app, logged, verifyOrigin }) {
    app.post("/dashboard/support/flags/:id/:act", logged, verifyOrigin, async (req, res) => {
      const f = (await pool.query("SELECT id,slug FROM project_flags WHERE id=$1", [Number(req.params.id) || 0])).rows[0];
      if (f && req.params.act === "unlock") { await pool.query("UPDATE side_projects SET locked=false WHERE slug=$1", [f.slug]); await pool.query("UPDATE project_flags SET status='unlocked' WHERE id=$1", [f.id]); }
      else if (f && req.params.act === "resolve") await pool.query("UPDATE project_flags SET status='resolved' WHERE id=$1", [f.id]);
      res.redirect(303, "/dashboard/support");
    });
  }

  return { DATA_SCOPES, TOKEN_SCOPES, storageCard, tabsFor, collect, flagsHtml, mount, mountPublic, mountAdmin };
};
