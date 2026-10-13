// Discord "Linked Roles" for one server: owners define role requirements (like a partner or affiliate
// badge). A requirement is either MANUAL (owners switch it on per person) or AUTO (calculated from the
// person's AutoAuth status). Members only need to connect through the Linked Roles Verification URL
// (/linked-role); they do not have to authorize AutoAuth. The server admin then adds the requirements
// under Server Settings > Roles > Links and Discord assigns the roles by itself.
module.exports = function createRoles({ pool, enc, dec, log }) {
  const API = "https://discord.com/api/v10";
  const MAX_DEFS = 5; // Discord allows at most 5 metadata records per application
  const TWITCH_TYPES = {
    twitch_connected: "Has connected a Twitch account",
    twitch_follower: "Follows a Twitch channel",
    twitch_subscriber: "Is subscribed to a Twitch channel",
  };
  const isTwitch = (d) => d.mode === "auto" && String(d.rule_type || "").startsWith("twitch_");
  const twitchConfigured = () => !!(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_CLIENT_SECRET);
  const AUTO_TYPES = {
    authorized_server: "Has authorized server joins on AutoAuth",
    authorized_dm: "Has authorized DMs on AutoAuth",
    linked_days: "Has been connected for at least N days",
  };
  const origin = () => { try { return new URL(process.env.REDIRECT_URI).origin; } catch { return ""; } };
  const verificationUrl = () => `${origin()}/linked-role`;
  const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);

  async function init() { /* nothing to seed: owners create their own requirements */ }
  const defs = async () => (await pool.query("SELECT * FROM role_defs ORDER BY created_at, key")).rows;

  async function registerMetadata() {
    const list = await defs();
    if (!list.length) throw new Error("Add at least one role requirement first.");
    const body = list.map((d) => ({ key: d.key, name: d.name.slice(0, 100), description: (d.description || d.name).slice(0, 200), type: 7 }));
    const r = await fetch(`${API}/applications/${process.env.CLIENT_ID}/role-connections/metadata`, {
      method: "PUT", headers: { Authorization: `Bot ${process.env.BOT_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Discord rejected the requirements (${r.status}) ${(await r.text()).slice(0, 120)}`);
    return body.length;
  }

  // ---- Twitch ----
  const hmac = (s) => require("node:crypto").createHmac("sha256", process.env.SESSION_SECRET).update(s).digest("hex");
  let appTok = { t: "", exp: 0 };
  async function twitchAppToken() {
    if (appTok.t && appTok.exp > Date.now() + 60000) return appTok.t;
    const r = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID, client_secret: process.env.TWITCH_CLIENT_SECRET, grant_type: "client_credentials" }) });
    const j = await r.json();
    if (!r.ok) throw new Error("Twitch rejected the app credentials");
    appTok = { t: j.access_token, exp: Date.now() + Number(j.expires_in || 3600) * 1000 };
    return appTok.t;
  }
  const helix = (path, token) => fetch("https://api.twitch.tv/helix" + path, { headers: { Authorization: `Bearer ${token}`, "Client-Id": process.env.TWITCH_CLIENT_ID } });
  async function resolveChannel(login) {
    const r = await helix("/users?login=" + encodeURIComponent(String(login).toLowerCase().replace(/[^a-z0-9_]/g, "")), await twitchAppToken());
    const j = await r.json().catch(() => ({}));
    return j.data && j.data[0] ? { id: j.data[0].id, login: j.data[0].login } : null;
  }
  async function twitchTokenFor(tl) {
    if (Number(tl.expires_at) > Date.now() + 60000) return dec(tl.access_token_enc);
    const r = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID, client_secret: process.env.TWITCH_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: dec(tl.refresh_token_enc) }) });
    const t = await r.json();
    if (!r.ok) throw new Error("Twitch refresh failed");
    await pool.query("UPDATE twitch_links SET access_token_enc=$2,refresh_token_enc=$3,expires_at=$4 WHERE user_id=$1", [tl.user_id, enc(t.access_token), enc(t.refresh_token || dec(tl.refresh_token_enc)), Date.now() + Number(t.expires_in || 3600) * 1000]);
    return t.access_token;
  }
  async function twitchEval(d, tl) {
    if (!tl) return false;
    if (d.rule_type === "twitch_connected") return true;
    try {
      const tok = await twitchTokenFor(tl);
      if (d.rule_type === "twitch_subscriber") {
        const r = await helix(`/subscriptions/user?broadcaster_id=${encodeURIComponent(d.rule_id)}&user_id=${encodeURIComponent(tl.twitch_id)}`, tok);
        return r.status === 200; // 404 means not subscribed
      }
      if (d.rule_type === "twitch_follower") {
        const r = await helix(`/channels/followed?user_id=${encodeURIComponent(tl.twitch_id)}&broadcaster_id=${encodeURIComponent(d.rule_id)}`, tok);
        const j = await r.json().catch(() => ({}));
        return r.ok && Array.isArray(j.data) && j.data.length > 0;
      }
    } catch { return false; }
    return false;
  }
  const needsTwitch = async () => (await defs()).some(isTwitch);
  function twitchScopes(list) {
    const s = [];
    if (list.some((d) => d.rule_type === "twitch_subscriber")) s.push("user:read:subscriptions");
    if (list.some((d) => d.rule_type === "twitch_follower")) s.push("user:read:follows");
    return s;
  }
  async function twitchUrl(discordId) {
    const p = `${discordId}.${Date.now() + 30 * 60 * 1000}.${require("node:crypto").randomBytes(8).toString("hex")}`;
    const u = new URL("https://id.twitch.tv/oauth2/authorize");
    u.searchParams.set("client_id", process.env.TWITCH_CLIENT_ID);
    u.searchParams.set("redirect_uri", `${origin()}/twitch/callback`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", twitchScopes(await defs()).join(" "));
    u.searchParams.set("state", `${p}.${hmac("twitch:" + p)}`);
    u.searchParams.set("force_verify", "true");
    return u.toString();
  }
  const usedState = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, t] of usedState) if (t < n) usedState.delete(k); }, 60000).unref();

  function mountPublic({ app, site }) {
    app.get("/twitch/callback", async (req, res) => {
      res.set({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
      const back = "<p>Return to Discord and try connecting again.</p>";
      const [uid, exp, n, sig] = String(req.query.state || "").split(".");
      const okState = uid && exp && n && sig && sig === hmac(`twitch:${uid}.${exp}.${n}`) && Number(exp) > Date.now() && !usedState.has(n);
      if (req.query.error) return res.status(400).send(site.page("Twitch", `<h1>Twitch was not connected</h1><p>You did not approve the connection.</p>${back}`, "auth"));
      if (!okState || typeof req.query.code !== "string" || !twitchConfigured()) return res.status(400).send(site.page("Twitch", `<h1>This link is invalid or expired</h1>${back}`, "auth"));
      usedState.set(n, Number(exp));
      try {
        const tr = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: process.env.TWITCH_CLIENT_ID, client_secret: process.env.TWITCH_CLIENT_SECRET, code: req.query.code, grant_type: "authorization_code", redirect_uri: `${origin()}/twitch/callback` }) });
        const t = await tr.json();
        if (!tr.ok) throw new Error("Twitch rejected the sign-in");
        const ur = await helix("/users", t.access_token), uj = await ur.json();
        const tu = uj.data && uj.data[0];
        if (!tu) throw new Error("Could not read the Twitch account");
        await pool.query(`INSERT INTO twitch_links(user_id,twitch_id,login,access_token_enc,refresh_token_enc,expires_at,linked_at) VALUES($1,$2,$3,$4,$5,$6,NOW())
          ON CONFLICT(user_id) DO UPDATE SET twitch_id=$2,login=$3,access_token_enc=$4,refresh_token_enc=$5,expires_at=$6,linked_at=NOW()`,
          [uid, tu.id, tu.login, enc(t.access_token), enc(t.refresh_token), Date.now() + Number(t.expires_in || 3600) * 1000]);
        await syncUser(uid);
        await log("twitch_connected", { user_id: uid, twitch: tu.login });
        res.send(site.page("Connected", `<h1>Twitch connected</h1><p>Your Twitch account <b>${String(tu.login).replace(/[^\w]/g, "")}</b> was checked and your status was sent to Discord. Return to Discord to see your roles.</p>`, "auth"));
      } catch (e) { await log("twitch_connect_failed", { error: e.message }); res.status(502).send(site.page("Twitch", `<h1>Could not connect Twitch</h1><p>Something went wrong while checking your Twitch account.</p>${back}`, "auth")); }
    });
  }

  async function evaluate(d, ctx) {
    if (d.mode === "manual") return ctx.assigned.has(d.key);
    if (isTwitch(d)) return twitchEval(d, ctx.tw);
    const a = ctx.auth, expired = a && a.auth_expires_at && new Date(a.auth_expires_at).getTime() <= Date.now();
    if (d.rule_type === "authorized_server") return !!(a && a.server_authorized && !expired);
    if (d.rule_type === "authorized_dm") return !!(a && a.dm_authorized);
    if (d.rule_type === "linked_days") return ctx.link ? Date.now() - new Date(ctx.link.linked_at).getTime() >= (Number(d.rule_param) || 1) * 86400000 : false;
    return false;
  }
  async function contextFor(uid, linkRow) {
    const [a, s, t] = await Promise.all([pool.query("SELECT * FROM authorized_users WHERE user_id=$1", [uid]), pool.query("SELECT role_key FROM role_assign WHERE user_id=$1", [uid]), pool.query("SELECT * FROM twitch_links WHERE user_id=$1", [uid])]);
    return { auth: a.rows[0] || null, assigned: new Set(s.rows.map((x) => x.role_key)), link: linkRow, tw: t.rows[0] || null };
  }
  async function metaFor(uid, linkRow) {
    const [list, ctx] = await Promise.all([defs(), contextFor(uid, linkRow)]);
    const out = {};
    for (const d of list) out[d.key] = await evaluate(d, ctx);
    return out;
  }

  async function push(accessToken, username, meta) {
    const r = await fetch(`${API}/users/@me/applications/${process.env.CLIENT_ID}/role-connection`, {
      method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ platform_name: "AutoAuth", platform_username: String(username || "member").slice(0, 100), metadata: meta }),
    });
    if (!r.ok) throw new Error(`Discord rejected the update (${r.status})`);
  }

  // Called from the OAuth callback with the token that carries role_connections.write.
  async function link(user, tokens) {
    const name = user.global_name || user.username || user.id;
    const ins = await pool.query(`INSERT INTO role_links(user_id,username,access_token_enc,refresh_token_enc,expires_at,linked_at) VALUES($1,$2,$3,$4,$5,NOW())
      ON CONFLICT(user_id) DO UPDATE SET username=$2,access_token_enc=$3,refresh_token_enc=$4,expires_at=$5 RETURNING *`,
      [user.id, name, enc(tokens.access_token), enc(tokens.refresh_token), Date.now() + Number(tokens.expires_in || 604800) * 1000]);
    const meta = await metaFor(user.id, ins.rows[0]);
    await push(tokens.access_token, name, meta);
    return { meta, needsTwitch: twitchConfigured() && (await needsTwitch()) };
  }

  async function tokenFor(l) {
    if (Number(l.expires_at) > Date.now() + 60000) return dec(l.access_token_enc);
    const r = await fetch(`${API}/oauth2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: "refresh_token", refresh_token: dec(l.refresh_token_enc) }) });
    const t = await r.json();
    if (!r.ok) throw new Error(t.error_description || t.error || "refresh failed");
    await pool.query("UPDATE role_links SET access_token_enc=$2,refresh_token_enc=$3,expires_at=$4 WHERE user_id=$1", [l.user_id, enc(t.access_token), enc(t.refresh_token || dec(l.refresh_token_enc)), Date.now() + Number(t.expires_in || 604800) * 1000]);
    return t.access_token;
  }

  async function syncUser(uid) {
    const l = (await pool.query("SELECT * FROM role_links WHERE user_id=$1", [uid])).rows[0];
    if (!l) return false;
    await push(await tokenFor(l), l.username, await metaFor(uid, l));
    return true;
  }
  async function unlink(uid) {
    try { await syncUser(uid); } catch {}
    await pool.query("DELETE FROM role_links WHERE user_id=$1", [uid]);
    await pool.query("DELETE FROM twitch_links WHERE user_id=$1", [uid]);
    await pool.query("DELETE FROM role_assign WHERE user_id=$1", [uid]);
  }
  async function syncAll() {
    const r = await pool.query("SELECT user_id FROM role_links");
    let ok = 0, failed = 0;
    for (const x of r.rows) { try { await syncUser(x.user_id); ok++; } catch { failed++; } }
    return { ok, failed };
  }

  // ---- dashboard tab ----
  function mountUi({ app, logged, verifyOrigin, render, esc, client }) {
    const flash = (req, m) => { req.session.flash = m; };
    const guard = (req, res) => { if (client.isReady()) return true; flash(req, "Start the bot first."); res.redirect(303, "/dashboard/roles"); return false; };
    const ruleText = (d) => d.mode === "manual" ? "Set by the owners" : isTwitch(d) ? `${TWITCH_TYPES[d.rule_type]}${d.rule_text ? ": " + d.rule_text : ""}` : `${AUTO_TYPES[d.rule_type] || "Automatic"}`.replace("N", String(d.rule_param || 1));

    app.get("/dashboard/roles", logged, async (req, res) => {
      try {
        const list = await defs();
        const [links, assigns] = await Promise.all([
          pool.query("SELECT * FROM role_links ORDER BY linked_at DESC LIMIT 300"),
          pool.query("SELECT user_id,role_key FROM role_assign"),
        ]);
        const byUser = new Map();
        for (const a of assigns.rows) { if (!byUser.has(a.user_id)) byUser.set(a.user_id, new Set()); byUser.get(a.user_id).add(a.role_key); }
        const members = new Map(links.rows.map((l) => [l.user_id, { id: l.user_id, name: l.username, link: l }]));
        for (const uid of byUser.keys()) if (!members.has(uid)) members.set(uid, { id: uid, name: "", link: null });
        const rows = [];
        for (const m of members.values()) {
          const ctx = await contextFor(m.id, m.link);
          rows.push({ ...m, tw: ctx.tw && ctx.tw.login, vals: await Promise.all(list.map(async (d) => ({ d, on: await evaluate(d, ctx) }))) });
        }
        const manual = list.filter((d) => d.mode === "manual");
        const url = verificationUrl();
        const cell = (m, v) => v.d.mode === "manual"
          ? `<form method="post" action="/dashboard/roles/assign" style="margin:0"><input type="hidden" name="user_id" value="${esc(m.id)}"><input type="hidden" name="role_key" value="${esc(v.d.key)}"><input type="hidden" name="value" value="${v.on ? "0" : "1"}"><button class="${v.on ? "green" : "secondary"}" style="padding:5px 10px">${v.on ? "✓ Assigned" : "Assign"}</button></form>`
          : `<span class="badge ${v.on ? "" : "none"}">${v.on ? "Auto: yes" : "Auto: no"}</span>`;
        const content = `<div class="top"><div><h1>Linked Roles</h1><p class="muted">Discord gives roles automatically from the requirements below. Members only connect once; they do not need to authorize AutoAuth.</p></div>
  <form method="post" action="/dashboard/roles/refresh" style="margin:0"><button class="btn">Refresh</button></form></div>
  <div class="card"><h2>Linked Roles Verification URL</h2><p class="muted">Paste this into the Discord Developer Portal under <b>General Information &gt; Linked Roles Verification URL</b>, then save.</p>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="lr-url" readonly value="${esc(url)}" style="flex:1;min-width:240px"><button type="button" class="secondary" onclick="navigator.clipboard.writeText(document.getElementById('lr-url').value);this.textContent='Copied'">Copy</button></div></div>
  ${twitchConfigured() ? "" : `<div class="card"><h2>Twitch is not set up</h2><p class="muted">To require a connected Twitch account (follows or subscribed to a channel), create a Twitch application at dev.twitch.tv/console, add <b>${esc(origin())}/twitch/callback</b> as its OAuth redirect URL, then set <b>TWITCH_CLIENT_ID</b> and <b>TWITCH_CLIENT_SECRET</b> in Render. Manual and AutoAuth-status requirements work without it.</p></div>`}
  <div class="card"><h2>Role requirements (${list.length}/${MAX_DEFS})</h2><p class="muted"><b>Manual</b> requirements are switched on by you for each person. <b>Auto</b> requirements are worked out from the person's AutoAuth status. Press <b>Refresh</b> after changing them so Discord learns the new list. In your server open <b>Server Settings &gt; Roles &gt; (a role) &gt; Links</b> to require them.</p>
  <div class="wrap"><table><tr><th>Name</th><th>Type</th><th>Rule</th><th style="text-align:right">Action</th></tr>${list.map((d) => `<tr><td>${esc(d.name)}<div class="muted" style="font-size:12px">${esc(d.description || "")}</div></td><td><span class="badge ${d.mode === "manual" ? "dm" : ""}">${d.mode === "manual" ? "Manual" : "Auto"}</span></td><td>${esc(ruleText(d))}</td><td style="text-align:right"><form method="post" action="/dashboard/roles/defs/${encodeURIComponent(d.key)}/delete" style="margin:0" onsubmit="return confirm('Remove this requirement? People lose it after the next refresh.')"><button class="danger" style="padding:6px 10px">Remove</button></form></td></tr>`).join("") || "<tr><td colspan=4>No requirements yet.</td></tr>"}</table></div>
  ${list.length < MAX_DEFS ? `<h3>Add a requirement</h3><form method="post" action="/dashboard/roles/defs/add" class="row" style="align-items:flex-end"><div><label>Name</label><input name="name" maxlength="40" required placeholder="e.g. Partner"></div><div><label>Description</label><input name="description" maxlength="100" placeholder="Shown to members"></div><div><label>Assignment</label><select name="mode" id="rd-mode" onchange="var v=this.value;document.getElementById('rd-auto').style.display=v==='auto'?'flex':'none';document.getElementById('rd-tw').style.display=v==='twitch'?'flex':'none'"><option value="manual">Manual (I choose who)</option><option value="auto">Auto: AutoAuth status</option><option value="twitch">Auto: connected Twitch account</option></select></div><div id="rd-auto" style="display:none;gap:8px;align-items:flex-end"><div><label>Rule</label><select name="rule_type"><option value="authorized_server">Authorized for server joins</option><option value="authorized_dm">Authorized for DMs</option><option value="linked_days">Connected for N days</option></select></div><div><label>Days</label><input name="rule_param" type="number" min="1" max="3650" value="7" style="width:90px"></div></div><div id="rd-tw" style="display:none;gap:8px;align-items:flex-end"><div><label>Twitch rule</label><select name="twitch_type"><option value="twitch_connected">Connected a Twitch account</option><option value="twitch_follower">Follows a channel</option><option value="twitch_subscriber">Subscribed to a channel</option></select></div><div><label>Channel (for follows / subscribed)</label><input name="channel" maxlength="25" placeholder="twitch channel name"></div></div><div><button class="green">Add</button></div></form>` : '<p class="muted">You have reached the limit of 5 requirements Discord allows.</p>'}</div>
  ${manual.length ? `<div class="card"><h2>Assign manually by Discord ID</h2><p class="muted">Works even if the person has not connected yet; it applies when they do.</p><form method="post" action="/dashboard/roles/assign" class="row" style="align-items:flex-end"><div><label>Discord user ID</label><input name="user_id" required pattern="\\d{17,20}" placeholder="123456789012345678"></div><div><label>Requirement</label><select name="role_key">${manual.map((d) => `<option value="${esc(d.key)}">${esc(d.name)}</option>`).join("")}</select></div><div><button class="green" name="value" value="1">Assign</button> <button class="danger" name="value" value="0">Remove</button></div></form></div>` : ""}
  <div class="card"><h2>Members (${rows.length})</h2><div class="wrap"><table><tr><th>Member</th>${list.map((d) => `<th>${esc(d.name)}</th>`).join("")}<th>Twitch</th><th>Connected</th></tr>${rows.map((m) => `<tr><td>${esc(m.name || "Not connected yet")}<div class="muted" style="font-size:12px">${esc(m.id)}</div></td>${m.vals.map((v) => `<td>${cell(m, v)}</td>`).join("")}<td>${esc(m.tw || "—")}</td><td>${m.link ? esc(new Date(m.link.linked_at).toISOString().slice(0, 10)) : "—"}</td></tr>`).join("") || `<tr><td colspan="${list.length + 3}">Nobody has connected yet.</td></tr>`}</table></div></div>`;
        render(req, res, "roles", content);
      } catch (e) { console.error(e); res.status(500).send("Linked Roles failed to load."); }
    });

    app.post("/dashboard/roles/refresh", logged, verifyOrigin, async (req, res) => {
      if (!guard(req, res)) return;
      try {
        const n = await registerMetadata(), s = await syncAll();
        await log("linked_roles_refreshed", { fields: n, updated: s.ok, failed: s.failed }, req.session.owner);
        flash(req, `Registered ${n} requirement${n === 1 ? "" : "s"} with Discord.\nUpdated ${s.ok} connected member${s.ok === 1 ? "" : "s"}${s.failed ? `\n${s.failed} could not be updated (they may need to connect again)` : ""}.`);
      } catch (e) { flash(req, `Refresh failed: ${String(e.message).slice(0, 200)}`); }
      res.redirect(303, "/dashboard/roles");
    });
    app.post("/dashboard/roles/defs/add", logged, verifyOrigin, async (req, res) => {
      if (!guard(req, res)) return;
      const b = req.body || {}, name = String(b.name || "").trim().slice(0, 40), pick = ["auto", "twitch"].includes(b.mode) ? b.mode : "manual";
      const mode = pick === "manual" ? "manual" : "auto", key = slug(name);
      const rule = pick === "auto" ? (AUTO_TYPES[b.rule_type] ? b.rule_type : null) : pick === "twitch" ? (TWITCH_TYPES[b.twitch_type] ? b.twitch_type : null) : null;
      let ruleText = null, ruleId = null;
      if (!name || !key) flash(req, "Give the requirement a name.");
      else if (mode === "auto" && !rule) flash(req, "Choose a rule for the automatic requirement.");
      else if (pick === "twitch" && !twitchConfigured()) flash(req, "Twitch is not set up yet. Add TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in Render first.");
      else if ((await defs()).length >= MAX_DEFS) flash(req, "Discord allows at most 5 requirements.");
      else {
        let ok = true;
        if (pick === "twitch" && rule !== "twitch_connected") {
          try { const ch = await resolveChannel(b.channel); if (ch) { ruleText = ch.login; ruleId = ch.id; } else { ok = false; flash(req, "That Twitch channel was not found."); } } catch (e) { ok = false; flash(req, "Could not look up that Twitch channel: " + String(e.message).slice(0, 100)); }
        }
        if (ok) {
          try {
            await pool.query("INSERT INTO role_defs(key,name,description,mode,rule_type,rule_param,rule_text,rule_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [key, name, String(b.description || "").trim().slice(0, 100), mode, rule, rule === "linked_days" ? Math.min(3650, Math.max(1, Number(b.rule_param) || 7)) : null, ruleText, ruleId]);
            await log("linked_role_added", { key, mode, rule }, req.session.owner);
            flash(req, `Added "${name}". Press Refresh to send it to Discord.`);
          } catch (e) { flash(req, e.code === "23505" ? "A requirement with that name already exists." : "Could not add it."); }
        }
      }
      res.redirect(303, "/dashboard/roles");
    });
    app.post("/dashboard/roles/defs/:key/delete", logged, verifyOrigin, async (req, res) => {
      if (!guard(req, res)) return;
      const key = String(req.params.key);
      await pool.query("DELETE FROM role_defs WHERE key=$1", [key]);
      await pool.query("DELETE FROM role_assign WHERE role_key=$1", [key]);
      await log("linked_role_removed", { key }, req.session.owner);
      flash(req, "Removed. Press Refresh to update Discord.");
      res.redirect(303, "/dashboard/roles");
    });
    app.post("/dashboard/roles/assign", logged, verifyOrigin, async (req, res) => {
      if (!guard(req, res)) return;
      const b = req.body || {}, uid = String(b.user_id || ""), key = String(b.role_key || "");
      const d = (await defs()).find((x) => x.key === key && x.mode === "manual");
      if (!/^\d{17,20}$/.test(uid) || !d) flash(req, "Enter a valid Discord user ID and a manual requirement.");
      else {
        if (b.value === "1") await pool.query("INSERT INTO role_assign(user_id,role_key) VALUES($1,$2) ON CONFLICT DO NOTHING", [uid, key]);
        else await pool.query("DELETE FROM role_assign WHERE user_id=$1 AND role_key=$2", [uid, key]);
        await log("linked_role_assigned", { target_user_id: uid, role: key, value: b.value === "1" }, req.session.owner);
        let note = "";
        try { if (!(await syncUser(uid))) note = " They have not connected yet; it applies when they do."; } catch { note = " Discord could not be updated right now; press Refresh later."; }
        flash(req, `${b.value === "1" ? "Assigned" : "Removed"} "${d.name}".${note}`);
      }
      res.redirect(303, "/dashboard/roles");
    });
  }

  return { init, registerMetadata, link, syncUser, syncAll, unlink, mountUi, mountPublic, twitchUrl, verificationUrl };
};
