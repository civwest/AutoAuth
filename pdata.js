"use strict";
// Data tabs for account projects (emails, connections, servers, webhooks), the add-to-server tool, and the abuse flagging system.
// Flagging only applies to account-owned side projects.
const crypto = require("node:crypto");

const DATA = {
  email: { scope: "email", label: "Emails", cols: ["User", "Email", "Verified"] },
  connections: { scope: "connections", label: "Connections", cols: ["User", "Service", "Name", "Verified"] },
  guilds: { scope: "guilds", label: "Servers", cols: ["User", "Servers", "Names"] },
  webhook: { scope: "webhook.incoming", label: "Webhooks", cols: ["User", "Channel ID", "Server ID"] },
};
const HOOK_URL = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d{5,25}\/[\w-]{20,200}$/; // only real Discord webhooks are ever called
// Webhook URLs must be Discord's own, so the server can never be made to call somewhere else.
const DISCORD_HOOK = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/\d{17,20}\/[\w-]+$/;
const DATA_SCOPES = new Set([...Object.values(DATA).map((d) => d.scope), "guilds.join"]);
const LIMITS = () => ({ guilds: Number(process.env.FLAG_GUILDS_24H) || 30, members: Number(process.env.FLAG_MEMBERS_1H) || 100 });

module.exports = function createPdata({ pool, enc, dec, log, express, esc, origin, site, drive }) {
  const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);
  const hits = new Map();
  const limited = (k, max, ms = 60000) => { const n = Date.now(), h = hits.get(k); if (!h || h.until < n) { hits.set(k, { n: 1, until: n + ms }); return false; } return ++h.n > max; };
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.until < n) hits.delete(k); }, 60000).unref();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isDrive = (p) => !!(drive && p.owner_account && (p.config || {}).storage === "drive");
  const scopesOf = (p) => String((p.config || {}).scopes || "").split(" ").filter(Boolean);

  // Tabs shown on a project's dashboard.
  const BUILT = new Set(["identify", ...Object.values(DATA).map((x) => x.scope), "guilds.join"]);
  function tabsFor(p) {
    if (p.type !== "oauth") return [];
    const sc = scopesOf(p), out = [];
    if ((p.config || {}).store) {
      for (const [k, d] of Object.entries(DATA)) if (sc.includes(d.scope)) out.push(["data/" + k, d.label]);
      if (sc.includes("guilds.join")) out.push(["join", "Add to server"]);
    }
    for (const s of sc) if (!BUILT.has(s)) out.push(["perm/" + s, s]); // controls for these permissions are under construction
    return out;
  }

  // Called by the OAuth callback: keeps the data each selected permission returned.
  async function collect(p, u, t) {
    const sc = String(t.scope || "").split(/[ ,]+/), drv = isDrive(p), uname = u.global_name || u.username || u.id;
    const put = (kind, data) => drv
      ? drive.put(p.owner_account, p.slug, `${kind}-${u.id}.json`, JSON.stringify({ user_id: u.id, username: uname, updated: new Date().toISOString(), data }, null, 2))
      : pool.query("INSERT INTO project_data(slug,user_id,kind,data_enc) VALUES($1,$2,$3,$4) ON CONFLICT(slug,user_id,kind) DO UPDATE SET data_enc=$4,updated_at=NOW()", [p.slug, u.id, kind, enc(JSON.stringify(data))]);
    const get = async (path) => { const r = await fetch("https://discord.com/api/v10" + path, { headers: { Authorization: `Bearer ${t.access_token}` } }); return r.ok ? r.json() : null; };
    try {
      if (sc.includes("email") && u.email) await put("email", { email: u.email, verified: !!u.verified });
      if (sc.includes("connections")) { const l = await get("/users/@me/connections"); if (Array.isArray(l)) await put("connections", l.map((x) => ({ type: x.type, name: x.name, verified: !!x.verified }))); }
      if (sc.includes("guilds")) { const l = await get("/users/@me/guilds"); if (Array.isArray(l)) await put("guilds", l.map((g) => ({ id: g.id, name: g.name, owner: !!g.owner }))); }
      if (t.webhook && HOOK_URL.test(String(t.webhook.url || ""))) await put("webhook", { id: t.webhook.id, channel_id: t.webhook.channel_id, guild_id: t.webhook.guild_id, url: t.webhook.url });
      // Google Drive projects keep the add-to-server tokens (encrypted) in the same Drive folder, never in our database.
      if (drv && sc.includes("guilds.join")) await drive.put(p.owner_account, p.slug, `token-${u.id}.json`, JSON.stringify({ enc: enc(JSON.stringify({ a: t.access_token, r: t.refresh_token || "", e: Date.now() + Number(t.expires_in || 604800) * 1000 })) }));
    } catch (e) {
      console.error("project data", e.message);
      if (drv) await pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,'drive_error',$2)", [p.slug, JSON.stringify({ error: String(e.message).slice(0, 200) })]).catch(() => {});
    }
  }

  const rowsFor = async (p, kind) => {
    if (isDrive(p)) {
      const files = await drive.list(p.owner_account, p.slug, kind + "-");
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
    return [[r.user, d.channel_id, d.guild_id]];
  };
  const table = (heads, rows) => `<div class="card"><div class="wrap"><table class="stack"><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>${rows.map((r) => `<tr>${r.map((c, i) => `<td data-l="${esc(heads[i])}">${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${heads.length}">Nothing yet.</td></tr>`}</table></div></div>`;
  const csvCell = (v) => { v = String(v ?? ""); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return '"' + v.replace(/"/g, '""') + '"'; };

  // ---------- add users to a server (guilds.join) ----------
  async function freshToken(p, row) {
    const c = p.config || {}, drv = isDrive(p);
    let cur;
    if (drv) {
      const txt = await drive.get(p.owner_account, p.slug, `token-${row.user_id}.json`); if (!txt) return null;
      try { const j = JSON.parse(dec(JSON.parse(txt).enc)); cur = { access: j.a, refresh: j.r, exp: Number(j.e) }; } catch { return null; }
    } else cur = { access: dec(row.access_token_enc), refresh: row.refresh_token_enc ? dec(row.refresh_token_enc) : "", exp: Number(row.expires_at) };
    if (cur.exp > Date.now() + 60000) return cur.access;
    if (!cur.refresh) return null;
    const r = await fetch("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.client_id, client_secret: dec(c.client_secret_enc), grant_type: "refresh_token", refresh_token: cur.refresh }) });
    const t = await r.json(); if (!r.ok || !t.access_token) return null;
    const exp = Date.now() + Number(t.expires_in || 604800) * 1000;
    if (drv) await drive.put(p.owner_account, p.slug, `token-${row.user_id}.json`, JSON.stringify({ enc: enc(JSON.stringify({ a: t.access_token, r: t.refresh_token || cur.refresh, e: exp })) }));
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

  function mount({ app, acctOnly, verifyOrigin, page, sub, own, json, sendDm, scopeInfo }) {
    const base = (a, p) => `/dashboard/${a.username}/${p.slug.slice(a.username.length + 1)}`;

    app.get("/dashboard/:u/:name/perm/:scope", acctOnly, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name); if (!p) return res.status(404).send("Not found");
      const s = (scopeInfo || []).find((x) => x[0] === req.params.scope);
      if (!s || !scopesOf(p).includes(s[0]) || BUILT.has(s[0])) return res.status(404).send("Not found");
      page(req, res, "projects", sub(a, p, "perm/" + s[0]) + `<div class="card"><h2>${esc(s[0])}</h2><p>${esc(s[1])}</p><p><b>Under construction.</b> The controls for this permission are not built yet.</p></div>`);
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
      if (isDrive(p)) await drive.del(p.owner_account, p.slug, [...Object.keys(DATA), "token"].map((k) => `${k}-${uid}.json`)).catch(() => {});
      await pool.query("DELETE FROM side_project_users WHERE slug=$1 AND user_id=$2", [p.slug, uid]);
      await pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,'user_removed','{}')", [p.slug]);
      res.redirect(303, base(a, p) + "/users");
    });

    app.get("/dashboard/:u/:name/join", acctOnly, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name); if (!p || !scopesOf(p).includes("guilds.join")) return res.status(404).send("Not found");
      const us = (await pool.query("SELECT user_id,username,scope FROM side_project_users WHERE slug=$1 ORDER BY created_at DESC LIMIT 500", [p.slug])).rows.filter((u) => String(u.scope).split(/[ ,]+/).includes("guilds.join"));
      const need = !(p.config || {}).bot_token_enc ? '<div class="card"><b>Add your bot token in this project\'s settings first.</b> It is used to add people to your server.</div>' : "";
      page(req, res, "projects", sub(a, p, "join") + need + `<div class="card"><label>Server ID</label><input id="jn-guild" inputmode="numeric" maxlength="20"><label style="display:flex;gap:8px;align-items:center;margin-top:12px"><input type="checkbox" id="jn-all" style="width:auto"> Select all (${us.length})</label>
<div style="max-height:260px;overflow:auto;margin-top:8px">${us.map((u) => `<label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" class="jn-u" value="${esc(u.user_id)}" style="width:auto">${esc(u.username || u.user_id)}</label>`).join("") || '<p class="muted">No users yet.</p>'}</div>
<button class="green" id="jn-go" style="margin-top:12px">Add to server</button><div id="jn-out" class="muted" style="margin-top:10px;white-space:pre-wrap"></div></div>
<script>document.addEventListener('DOMContentLoaded',function(){$('jn-all').addEventListener('change',function(){[].slice.call(document.querySelectorAll('.jn-u')).forEach(function(c){c.checked=$('jn-all').checked;});});
$('jn-go').addEventListener('click',async function(){var b=this,u=[].slice.call(document.querySelectorAll('.jn-u:checked')).map(function(c){return c.value;}).slice(0,100);if(!u.length)return showMsg('Add to server','Select at least one user (100 at a time).');b.disabled=true;$('jn-out').textContent='Working...';
try{var r=await fetch('${base(a, p)}/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({guild:$('jn-guild').value.trim(),users:u})}),j=await r.json().catch(function(){return{};});$('jn-out').textContent=r.ok?('Added '+j.added+', already in server '+j.already+', failed '+j.failed+'.'):(j.error||'Failed');if(j.locked)setTimeout(function(){location.reload();},1500);}catch(e){$('jn-out').textContent=e.message;}b.disabled=false;});});</script>`);
    });
    app.post("/dashboard/:u/:name/join", acctOnly, verifyOrigin, json, async (req, res) => {
      const a = req.acct, p0 = await own(a, req.params.name); if (!p0 || !scopesOf(p0).includes("guilds.join")) return res.status(404).json({ error: "Project not found." });
      const p = { ...p0, owner_account: a.id }, c = p.config || {};
      if (p.locked) return res.status(403).json({ error: "This project is locked." });
      if (!c.bot_token_enc) return res.status(400).json({ error: "Add your bot token in the project settings first." });
      const guild = String((req.body || {}).guild || ""), ids = [...new Set(Array.isArray((req.body || {}).users) ? req.body.users.map(String) : [])].slice(0, 100);
      if (!/^\d{17,20}$/.test(guild)) return res.status(400).json({ error: "Enter a valid server ID." });
      if (!ids.length) return res.status(400).json({ error: "Select at least one user." });
      if (limited("jn:" + a.id, 6)) return res.status(429).json({ error: "Slow down." });
      const reason = await flagReason(p, guild, ids.length);
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

  return { DATA_SCOPES, tabsFor, collect, flagsHtml, mount, mountPublic, mountAdmin };
};
