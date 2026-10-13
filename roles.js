// Discord "Linked Roles": the app publishes role-connection metadata, members connect their AutoAuth
// status through the Linked Roles Verification URL (/linked-role), and server admins then create roles
// that Discord assigns automatically (Server Settings > Roles > Links). No gateway connection is needed
// to assign roles; the dashboard tab is locked behind "Start the bot" only for consistency.
module.exports = function createRoles({ pool, enc, dec, log }) {
  const API = "https://discord.com/api/v10";
  const SCHEMA = [
    { key: "server_authorized", name: "Server joins allowed", description: "Allowed AutoAuth to add them to servers", type: 7 },
    { key: "dm_authorized", name: "DMs allowed", description: "Allowed AutoAuth to send them direct messages", type: 7 },
    { key: "days_authorized", name: "Days authorized", description: "Days since they authorized AutoAuth", type: 2 },
  ];
  const origin = () => { try { return new URL(process.env.REDIRECT_URI).origin; } catch { return ""; } };
  const verificationUrl = () => `${origin()}/linked-role`;

  async function registerMetadata() {
    const r = await fetch(`${API}/applications/${process.env.CLIENT_ID}/role-connections/metadata`, {
      method: "PUT", headers: { Authorization: `Bot ${process.env.BOT_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(SCHEMA),
    });
    if (!r.ok) throw new Error(`Discord rejected the metadata (${r.status}) ${(await r.text()).slice(0, 120)}`);
    return SCHEMA.length;
  }

  function metaFor(row) {
    if (!row) return { server_authorized: false, dm_authorized: false, days_authorized: 0 };
    const expired = row.auth_expires_at && new Date(row.auth_expires_at).getTime() <= Date.now();
    return {
      server_authorized: !!row.server_authorized && !expired,
      dm_authorized: !!row.dm_authorized,
      days_authorized: Math.max(0, Math.floor((Date.now() - new Date(row.authorized_at).getTime()) / 86400000)),
    };
  }

  async function push(accessToken, username, row) {
    const r = await fetch(`${API}/users/@me/applications/${process.env.CLIENT_ID}/role-connection`, {
      method: "PUT", headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ platform_name: "AutoAuth", platform_username: String(username || "member").slice(0, 100), metadata: metaFor(row) }),
    });
    if (!r.ok) throw new Error(`Discord rejected the update (${r.status})`);
  }

  // Called from the OAuth callback with the token that carries role_connections.write.
  async function link(user, tokens) {
    const q = await pool.query("SELECT * FROM authorized_users WHERE user_id=$1", [user.id]);
    const row = q.rows[0] || null, name = user.global_name || user.username || user.id;
    await pool.query(`INSERT INTO role_links(user_id,username,access_token_enc,refresh_token_enc,expires_at,linked_at) VALUES($1,$2,$3,$4,$5,NOW())
      ON CONFLICT(user_id) DO UPDATE SET username=$2,access_token_enc=$3,refresh_token_enc=$4,expires_at=$5,linked_at=NOW()`,
      [user.id, name, enc(tokens.access_token), enc(tokens.refresh_token), Date.now() + Number(tokens.expires_in || 604800) * 1000]);
    await push(tokens.access_token, name, row);
    return { authorized: !!row, meta: metaFor(row) };
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
    const row = (await pool.query("SELECT * FROM authorized_users WHERE user_id=$1", [uid])).rows[0] || null;
    await push(await tokenFor(l), l.username, row);
    return true;
  }
  async function unlink(uid) {
    try { await syncUser(uid); } catch {}
    await pool.query("DELETE FROM role_links WHERE user_id=$1", [uid]);
  }
  async function syncAll() {
    const r = await pool.query("SELECT user_id FROM role_links");
    let ok = 0, failed = 0;
    for (const x of r.rows) { try { await syncUser(x.user_id); ok++; } catch { failed++; } }
    return { ok, failed };
  }

  // ---- dashboard tab ----
  function mountUi({ app, logged, verifyOrigin, render, lk, ov, esc, client }) {
    const flash = (req, m) => { req.session.flash = m; };
    app.get("/dashboard/roles", logged, async (req, res) => {
      try {
        const r = await pool.query("SELECT l.user_id,l.username,l.linked_at,a.server_authorized,a.dm_authorized FROM role_links l LEFT JOIN authorized_users a ON a.user_id=l.user_id ORDER BY l.linked_at DESC LIMIT 200");
        const url = verificationUrl();
        const content = `<div class="top"><div><h1>Linked Roles</h1><p class="muted">Discord assigns roles automatically from each member's AutoAuth status. Nothing runs in the bot for this: members connect once, and server admins pick the requirements.</p></div>
  <form method="post" action="/dashboard/roles/refresh" style="margin:0"><button class="btn"${client.isReady() ? "" : " disabled"}>Refresh</button></form></div>
  <div class="card${lk()}">${ov()}<h2>Linked Roles Verification URL</h2><p class="muted">Paste this into the Discord Developer Portal under <b>General Information &gt; Linked Roles Verification URL</b>, then save.</p>
  <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="lr-url" readonly value="${esc(url)}" style="flex:1;min-width:240px"><button type="button" class="secondary" onclick="navigator.clipboard.writeText(document.getElementById('lr-url').value);this.textContent='Copied'">Copy</button></div></div>
  <div class="card${lk()}">${ov()}<h2>How to use it</h2><ol class="muted" style="line-height:1.7"><li>Press <b>Refresh</b> once so Discord knows the requirements (server joins allowed, DMs allowed, days authorized).</li><li>Members open <b>Server name &gt; Linked Roles</b> in Discord and connect AutoAuth. They are sent through the verification URL above.</li><li>A server admin opens <b>Server Settings &gt; Roles</b>, edits or creates a role, and under <b>Links</b> adds the AutoAuth requirements.</li><li>Press <b>Refresh</b> any time to push everyone's current status to Discord (for example after opt-outs or expiry changes).</li></ol></div>
  <div class="card${lk()}">${ov()}<h2>Linked members (${r.rows.length})</h2><div class="wrap"><table><tr><th>Username</th><th>Discord ID</th><th>Servers</th><th>DMs</th><th>Linked (UTC)</th></tr>${r.rows.map((x) => `<tr><td>${esc(x.username)}</td><td>${esc(x.user_id)}</td><td>${x.server_authorized ? "Yes" : "No"}</td><td>${x.dm_authorized ? "Yes" : "No"}</td><td>${x.linked_at ? esc(new Date(x.linked_at).toISOString().replace("T", " ").slice(0, 19)) : ""}</td></tr>`).join("") || "<tr><td colspan=5>Nobody has linked yet.</td></tr>"}</table></div></div>`;
        render(req, res, "roles", content);
      } catch (e) { console.error(e); res.status(500).send("Linked Roles failed to load."); }
    });
    app.post("/dashboard/roles/refresh", logged, verifyOrigin, async (req, res) => {
      if (!client.isReady()) flash(req, "Start the bot first.");
      else {
        try {
          const n = await registerMetadata(), s = await syncAll();
          await log("linked_roles_refreshed", { fields: n, updated: s.ok, failed: s.failed }, req.session.owner);
          flash(req, `Registered ${n} role requirements with Discord.\nUpdated ${s.ok} linked member${s.ok === 1 ? "" : "s"}${s.failed ? `\n${s.failed} could not be updated (they may need to link again)` : ""}.`);
        } catch (e) { flash(req, `Refresh failed: ${String(e.message).slice(0, 200)}`); }
      }
      res.redirect(303, "/dashboard/roles");
    });
  }

  return { registerMetadata, link, syncUser, syncAll, unlink, mountUi, verificationUrl };
};
