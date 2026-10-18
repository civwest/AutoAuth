// Authorization flow: /auth page (three options, each with an agreement popup),
// /auth/start, and /oauth/callback.
//
// Security notes:
//  - The Discord "state" is signed (HMAC) and carries the chosen mode + expiry. Plain Discord authorize
//    links (no state) are also accepted; the mode is then worked out from the granted scopes.
//  - There is no captcha. Attempts are rate limited per IP.
const crypto = require("node:crypto");

// scope strings and whether the user-install integration type is used
const MODES = {
  server: { code: "s", scope: ["identify", "guilds.join", "guilds"], userInstall: false },
  dm: { code: "d", scope: ["identify", "guilds", "applications.commands"], userInstall: true },
  optout: { code: "o", scope: ["identify"], userInstall: false },
  all: { code: "a", scope: ["identify", "guilds.join", "guilds", "applications.commands"], userInstall: true },
  account: { code: "u", scope: ["identify"], userInstall: false, dash: true }, // sign-up / log-in for project accounts
  link: { code: "k", scope: ["identify", "guilds", "guilds.members.read"], userInstall: false, dash: true }, // links a Discord account to a dashboard login (uses the separate login callback URL)
};
const BY_CODE = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [v.code, k]));

module.exports = function mountAuth(app, ctx) {
  const { site, pool, enc, log, equal, verifyOrigin, optOutUser, dashDiscord, loginRedirect, accountDiscord } = ctx;
  const secret = process.env.SESSION_SECRET;
  const used = new Map(); // nonce -> expiry (single-use state tokens)
  const hits = new Map(); // rate limiting

  const hmac = (s) => crypto.createHmac("sha256", secret).update(s).digest("hex");
  const sweep = () => { const n = Date.now(); for (const [k, t] of used) if (t < n) used.delete(k); for (const [k, v] of hits) if (v.until < n) hits.delete(k); };
  setInterval(sweep, 60000).unref();
  function limited(key, max, windowMs) {
    const now = Date.now(); let h = hits.get(key);
    if (!h || h.until < now) h = { n: 0, until: now + windowMs };
    h.n++; hits.set(key, h); return h.n > max;
  }

  // ---- state ----
  function makeState(mode) {
    const p = `${MODES[mode].code}.${crypto.randomBytes(16).toString("hex")}.${Date.now() + 60 * 60 * 1000}`;
    return `${p}.${hmac("state:" + p)}`;
  }
  let lastReason = "";
  function consumeState(st) {
    lastReason = "";
    const [c, n, exp, sig] = String(st || "").split(".");
    if (!c || !n || !exp || !sig || !BY_CODE[c]) { lastReason = "state missing or malformed"; return null; }
    if (!equal(sig, hmac(`state:${c}.${n}.${exp}`))) { lastReason = "state signature mismatch (SESSION_SECRET changed or link altered)"; return null; }
    if (!(Number(exp) > Date.now())) { lastReason = "state expired"; return null; }
    if (used.has("s" + n)) { lastReason = "state already used (page reloaded or opened twice)"; return null; }
    used.set("s" + n, Number(exp));
    return BY_CODE[c];
  }
  function discordUrlFor(mode) { return discordUrl(mode); }
  function discordUrl(mode) {
    const m = MODES[mode], u = new URL("https://discord.com/oauth2/authorize");
    u.searchParams.set("client_id", process.env.CLIENT_ID);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", m.dash ? loginRedirect : process.env.REDIRECT_URI);
    if (m.userInstall) u.searchParams.set("integration_type", "1");
    u.searchParams.set("scope", m.scope.join(" "));
    u.searchParams.set("state", makeState(mode));
    return u.toString();
  }

  // ---- pages ----
  const ERRORS = {
    agree: "You need to tick the agreement box to continue.",
    rate: "Too many attempts. Please wait a few minutes and try again.",
  };

  app.get("/auth", (req, res) => {
    const err = ERRORS[req.query.error] ? `<div class="banner">${ERRORS[req.query.error]}</div>` : "";
    const reopen = ["server", "dm", "all"].includes(req.query.mode) && ERRORS[req.query.error] ? req.query.mode : "";
    res.set("Cache-Control", "no-store").send(site.page("Authorization", `<h1>Authorization</h1>
<p class="lead">Choose what you want to allow. You will read and agree to the details, and then approve on Discord.</p>
${err}
<div class="authgrid">
<button type="button" class="authopt" onclick="openAgree('server')"><b>Allow Server Joins</b><span>Let server admins and the owners add you to servers that use AutoAuth.</span></button>
<button type="button" class="authopt" onclick="openAgree('dm')"><b>Allow Direct Messages</b><span>Let the owners send you DMs through the bot. Installs AutoAuth to your account.</span></button>
<button type="button" class="authopt" onclick="openAgree('all')"><b>Allow Both</b><span>Server joins and direct messages in one approval.</span></button>
</div>
<noscript><p class="banner">JavaScript is required to open the agreement on this page.</p></noscript>
<p class="updated">Already authorized? Opt out any time on the <a href="/optout">opt-out page</a> or with <code>/optout</code> in Discord to opt out of servers, DMs or everything. AutoAuth is an independent project run by ${process.env.SITE_OPERATOR || "the site owner"} and is not affiliated with Discord Inc.</p>
<dialog class="dlg" id="agree">
<form method="post" action="/auth/start" id="agree-form">
<h2 id="ag-title"></h2>
<p>By continuing you agree to the following:</p>
<ul class="agree-list" id="ag-list"></ul>
<input type="hidden" name="mode" id="ag-mode">
<label class="chk"><input type="checkbox" name="agree" value="yes" id="ag-chk" required><span>I have read and agree to the <a href="/terms-of-service" target="_blank">Terms of Service</a> and <a href="/privacy-policy" target="_blank">Privacy Policy</a>, and I consent to the above.</span></label>
<div class="btns"><button class="btn green" type="submit">I agree, continue to Discord</button><button type="button" class="btn gray" onclick="closeDlg('agree')">Cancel</button></div>
</form></dialog>
<script>
var MODES={
 server:{t:'Allow server joins',l:['AutoAuth stores your Discord username and ID, and encrypted access tokens.','Server administrators and the AutoAuth owners can add you to servers where AutoAuth is installed, and the owners can remove you from them.']},
 dm:{t:'Allow direct messages',l:['AutoAuth stores your Discord username and ID, and encrypted access tokens.','AutoAuth is installed to your Discord account so its commands work anywhere.','The AutoAuth owners can send you direct messages, which may include attachments, through the bot.']},
 all:{t:'Allow server joins and direct messages',l:['AutoAuth stores your Discord username and ID, and encrypted access tokens.','Server administrators and the AutoAuth owners can add you to servers where AutoAuth is installed, and the owners can remove you from them.','AutoAuth is installed to your Discord account, and the owners can send you direct messages, which may include attachments.']}
};
var COMMON='You can opt out at any time with /optout in Discord. Your authorization stays active until you opt out, unless the owners set an expiry.';
function openAgree(m){var d=MODES[m];if(!d)return;document.getElementById('ag-title').textContent=d.t;var ul=document.getElementById('ag-list');ul.innerHTML='';d.l.concat([COMMON]).forEach(function(x){var li=document.createElement('li');li.textContent=x;ul.appendChild(li);});document.getElementById('ag-mode').value=m;document.getElementById('ag-chk').checked=false;openDlg('agree');}
${reopen ? `document.addEventListener('DOMContentLoaded',function(){openAgree(${JSON.stringify(reopen)});});` : ""}
</script>`, "auth"));
  });

  app.post("/auth/start", verifyOrigin, async (req, res) => {
    const ip = req.ip || "?", body = req.body || {}, mode = String(body.mode || "");
    if (!MODES[mode]) return res.redirect(303, "/auth");
    if (limited("start:" + ip, 40, 10 * 60 * 1000)) return res.redirect(303, `/auth?error=rate&mode=${mode}`);
    if (body.agree !== "yes") return res.redirect(303, `/auth?error=agree&mode=${mode}`);
    await log("auth_flow_started", { mode });
    const url = discordUrl(mode);
    // Backup copy of the state: some Discord install flows return without it.
    res.cookie("aa_state", new URL(url).searchParams.get("state"), { httpOnly: true, secure: true, sameSite: "lax", maxAge: 60 * 60 * 1000, path: "/oauth" });
    return res.set("Cache-Control", "no-store").redirect(303, url);
  });


  // ---- self-service opt-out page ----
  function makeTicket(uid) { const p = `${uid}.${Date.now() + 10 * 60 * 1000}.${crypto.randomBytes(8).toString("hex")}`; return `${p}.${hmac("optout:" + p)}`; }
  app.get("/optout", (_, res) => res.send(site.page("Opt out", `<h1>Opt out of AutoAuth</h1><p>Sign in with Discord so we know the request is really from you. We only read your username and ID, and the sign-in token is revoked immediately. Then choose to turn off server joins, direct messages, or delete everything.</p>
<form method="post" action="/optout/start"><button class="btn blue">Continue with Discord</button></form><p class="updated">You can also run <code>/optout</code> in Discord.</p>`, "auth")));
  app.post("/optout/start", verifyOrigin, (req, res) => {
    if (limited("optout:" + (req.ip || "?"), 15, 10 * 60 * 1000)) return res.status(429).send("Too many attempts. Try again later.");
    return res.set("Cache-Control", "no-store").redirect(303, discordUrlFor("optout"));
  });
  app.post("/optout/confirm", async (req, res) => {
    const [uid, exp, n, sig] = String((req.body || {}).ticket || "").split(".");
    const type = String((req.body || {}).type || "");
    if (!uid || !exp || !n || !sig || !equal(sig, hmac(`optout:${uid}.${exp}.${n}`)) || !(Number(exp) > Date.now()) || used.has("o" + n) || !["server", "dm", "all"].includes(type)) {
      return res.status(400).send(site.page("Opt out", "<h1>This request expired</h1><p>Please <a href='/optout'>start again</a>.</p>", "auth"));
    }
    used.set("o" + n, Number(exp));
    try {
      const r = await optOutUser(uid, type);
      if (!r.deleted) await log("user_optout", { user_id: uid, type, source: "website" });
      const msg = r.deleted ? "Your authorization was revoked and your data was deleted." : type === "server" ? "Server joins are turned off. Your other permission is still active." : "Direct messages are turned off. Your other permission is still active.";
      res.send(site.page("Opt out", `<h1>Done</h1><p>${msg}</p>`, "auth"));
    } catch (e) { console.error(e); res.status(500).send(site.page("Opt out", "<h1>Something went wrong</h1><p>Please try again in a moment.</p>", "auth")); }
  });

  // Starts linking a Discord account to the signed-in dashboard login (button on the profile edit page).
  app.post("/users/profile/discord-link", verifyOrigin, (req, res) => {
    if (!req.session || !req.session.owner) return res.redirect(303, "/login");
    req.session.linkPending = Date.now() + 10 * 60 * 1000;
    req.session.linkReturn = ["/dashboard/servers", "/users/profile/edit"].includes((req.body || {}).return) ? req.body.return : "/users/profile/edit";
    req.session.save(() => res.set("Cache-Control", "no-store").redirect(303, discordUrl("link")));
  });

  // Starts Discord sign-up / log-in for project accounts.
  app.post("/signup/discord", (req, res) => {
    if (limited("su:" + req.ip, 20, 600000)) return res.status(429).send("Too many attempts. Try again later.");
    const it = (req.body || {}).intent; req.session.acctIntent = it === "login" ? "login" : it === "link" && req.session.acct ? "link" : "signup";
    req.session.save(() => res.set("Cache-Control", "no-store").redirect(303, discordUrl("account")));
  });

  // Dashboard sign-in with Discord has its own callback URL (LOGIN_REDIRECT_URI, default /login/callback). Add it under OAuth2 > Redirects in the Developer Portal.
  app.get(new URL(loginRedirect).pathname, async (req, res) => {
    res.set({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
    const fail = (msg, status) => res.status(status || 400).send(site.page("Dashboard sign-in", `<h1>Could not sign in</h1><p>${msg}</p><p><a class="cta" href="/login">Back to the dashboard login</a></p>`, "auth"));
    const { code, error } = req.query;
    if (error) return res.redirect(303, "/login");
    if (typeof code !== "string" || !code) return fail("Discord did not return a code. Please try again.");
    const st = typeof req.query.state === "string" && req.query.state ? consumeState(req.query.state) : null;
    const mode = st === "link" ? "link" : st === "account" ? "account" : "login";
    try {
      const r = await fetch("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: loginRedirect }) });
      const t = await r.json();
      if (!r.ok) { await log("dashboard_discord_exchange_failed", { status: r.status, error: t.error }); return fail("Discord rejected the sign-in. Make sure the login callback URL is added in the Developer Portal, then try again.", 502); }
      const ur = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${t.access_token}` } }), u = await ur.json();
      if (!ur.ok || !u.id) return fail("Discord did not return your account details. Please try again.", 502);
      let out;
      if (mode === "account") out = await accountDiscord(req, u, t);
      else {
        out = await dashDiscord(req, u, mode, t);
        if (mode === "login" && !out.redirect && out.status === 403) {
          const acct = await ctx.accountLogin(req, u);
          out = acct || { status: 404, title: "No account found", error: "There is no account for this Discord user yet.", back: "/signup" };
        }
      }
      if (out.redirect) return res.redirect(303, out.redirect);
      return res.status(out.status || 403).send(site.page("Dashboard sign-in", `<h1>${out.title || "Could not sign in"}</h1><p>${out.error}</p><p><a class="cta" href="${out.back || "/login"}">${out.back ? "Back" : "Go to the dashboard login"}</a></p>`, "auth"));
    } catch (e) { console.error(e); await log("dashboard_discord_error", { error: e.message }); return fail("Something went wrong. Please try again.", 500); }
  });

  // Old direct link now just leads to the page.
  app.get("/auth/start", (_, res) => res.redirect(302, "/auth"));

  const retry = "<p><a class='cta' href='/auth'>Back to Authorization</a></p>";
  app.get("/oauth/callback", async (req, res) => {
    res.set({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
    const { code, error } = req.query;
    const cookieState = String(req.headers.cookie || "").split(/;\s*/).map((c) => c.split("=")).find((c) => c[0] === "aa_state");
    const state = typeof req.query.state === "string" ? req.query.state : (cookieState ? decodeURIComponent(cookieState[1] || "") : "");
    let mode = null, why = "";
    if (!(typeof code === "string" && code)) why = "Discord did not return a code";
    else if (!state) why = "Discord did not return the state";
    else { mode = consumeState(state); why = lastReason; }
    res.clearCookie("aa_state", { path: "/oauth" });
    if (error) {
      await log("oauth_denied", { error: String(error) });
      return res.status(400).send(site.page("Authorization cancelled", `<h1>Authorization cancelled</h1><p>You did not approve AutoAuth, so nothing was saved.</p>${retry}`, "auth"));
    }
    // A plain Discord authorize link (no state from this site) is fine: the mode is worked out from the scopes Discord granted.
    if (typeof code !== "string" || !code) {
      await log("oauth_invalid_state", { has_code: !!code, has_state: typeof req.query.state === "string", has_cookie: !!cookieState, reason: why, keys: Object.keys(req.query).join(",").slice(0, 100) });
      return res.status(400).send(site.page("Authorization incomplete", `<h1>Authorization incomplete</h1><p>Discord did not send back an authorization code, so nothing was saved. Please try again from the <a href="/auth">Authorization page</a> or with one of the authorization links.</p><p class="muted" style="font-size:12px">Reason: ${why.replace(/[<>&"']/g, "")}.</p>${retry}`, "auth"));
    }
    try {
      const r = await fetch("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: process.env.REDIRECT_URI }) });
      const t = await r.json();
      if (!r.ok) { await log("oauth_exchange_failed", { status: r.status, error: t.error }); return res.status(502).send(site.page("Authorization failed", `<h1>Authorization failed</h1><p>Discord rejected the sign-in. Please try again.</p>${retry}`, "auth")); }
      const ur = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${t.access_token}` } }), u = await ur.json();
      if (!ur.ok || !u.id) { await log("oauth_user_fetch_failed", { status: ur.status }); return res.status(502).send(site.page("Authorization failed", `<h1>Could not read your account</h1><p>Discord did not return your account details. Please try again.</p>${retry}`, "auth")); }
      const grantedScopes = typeof t.scope === "string" ? t.scope.split(/[ +]/) : (mode ? MODES[mode].scope : []);
      if (!mode) {
        mode = grantedScopes.includes("guilds.join") && grantedScopes.includes("applications.commands") ? "all"
          : grantedScopes.includes("guilds.join") ? "server"
          : grantedScopes.includes("applications.commands") ? "dm" : null;
        if (!mode) {
          fetch("https://discord.com/api/v10/oauth2/token/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, token: t.access_token, token_type_hint: "access_token" }) }).catch(() => {});
          return res.status(400).send(site.page("Nothing was enabled", `<h1>Nothing was enabled</h1><p>That link did not grant any AutoAuth permission. To opt out, use the <a href="/optout">opt-out page</a>. To sign in to the dashboard use the <a href="/login">login page</a>.</p>${retry}`, "auth"));
        }
      }
      if (mode === "optout") {
        // Identity only: revoke this temporary token straight away, nothing is stored.
        fetch("https://discord.com/api/v10/oauth2/token/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, token: t.access_token, token_type_hint: "access_token" }) }).catch(() => {});
        const q = await pool.query("SELECT server_authorized, dm_authorized FROM authorized_users WHERE user_id=$1", [u.id]);
        const name = u.global_name || u.username || u.id;
        if (!q.rows[0]) return res.send(site.page("Opt out", `<h1>Nothing to remove</h1><p>Hi ${String(name).replace(/[<>&"']/g, "")}, AutoAuth has no saved authorization for your account.</p>`, "auth"));
        const row = q.rows[0];
        const have = [row.server_authorized ? "server joins" : "", row.dm_authorized ? "direct messages" : ""].filter(Boolean).join(" and ") || "nothing active";
        const ticket = makeTicket(u.id);
        return res.send(site.page("Opt out", `<h1>Opt out of AutoAuth</h1><p>Signed in as <b>${String(name).replace(/[<>&"']/g, "")}</b>. Currently allowed: <b>${have}</b>.</p>
<form method="post" action="/optout/confirm" style="display:flex;flex-direction:column;gap:10px;max-width:420px"><input type="hidden" name="ticket" value="${ticket}">
${row.server_authorized ? '<button class="btn gray" name="type" value="server">Opt out of server joins only</button>' : ""}${row.dm_authorized ? '<button class="btn gray" name="type" value="dm">Opt out of direct messages only</button>' : ""}<button class="btn blue" name="type" value="all">Opt out of everything and delete my data</button></form>
<p>Opting out of everything revokes the grant with Discord and deletes your saved record. You are not removed from any servers.</p>`, "auth"));
      }
      // What was actually granted decides the flags; fall back to what was requested if Discord omits the scope field.
      const granted = grantedScopes;
      const serverOk = mode !== "dm" && granted.includes("guilds.join");
      const dmOk = mode !== "server" && granted.includes("applications.commands");
      if (!serverOk && !dmOk) { await log("oauth_no_scopes", { mode }); return res.status(400).send(site.page("Nothing was enabled", `<h1>Nothing was enabled</h1><p>Discord did not grant the permissions needed. Please try again.</p>${retry}`, "auth")); }
      // A DM-only approval must not overwrite tokens that already carry guilds.join.
      await pool.query(`INSERT INTO authorized_users(user_id,username,access_token_enc,refresh_token_enc,expires_at,authorized_at,server_authorized,dm_authorized,auth_expires_at)
        VALUES($1,$2,$3,$4,$5,NOW(),$6,$7,NULL)
        ON CONFLICT(user_id) DO UPDATE SET username=EXCLUDED.username,
          access_token_enc=CASE WHEN EXCLUDED.server_authorized OR NOT authorized_users.server_authorized THEN EXCLUDED.access_token_enc ELSE authorized_users.access_token_enc END,
          refresh_token_enc=CASE WHEN EXCLUDED.server_authorized OR NOT authorized_users.server_authorized THEN EXCLUDED.refresh_token_enc ELSE authorized_users.refresh_token_enc END,
          expires_at=CASE WHEN EXCLUDED.server_authorized OR NOT authorized_users.server_authorized THEN EXCLUDED.expires_at ELSE authorized_users.expires_at END,
          server_authorized=authorized_users.server_authorized OR EXCLUDED.server_authorized,
          dm_authorized=authorized_users.dm_authorized OR EXCLUDED.dm_authorized,
          authorized_at=NOW(),auth_expires_at=NULL`,
        [u.id, u.global_name || u.username || u.id, enc(t.access_token), enc(t.refresh_token), Date.now() + Number(t.expires_in || 604800) * 1000, serverOk, dmOk]);
      await log("oauth_success", { user_id: u.id, username: u.global_name || u.username, mode, server: serverOk, dm: dmOk });
      const what = [serverOk ? "server joins" : "", dmOk ? "direct messages" : ""].filter(Boolean).join(" and ");
      res.send(site.page("Connected", `<h1>You are connected</h1><p>You allowed <b>${what}</b>.</p>${serverOk ? "<p>A server admin can now add you with <code>/addusers</code> or <code>/adduser</code>.</p>" : ""}${dmOk ? "<p>The owners can now message you through the bot.</p>" : ""}<p>Change your mind any time with <code>/optout</code> in Discord.</p><p><a class="cta" href="/">Back to AutoAuth</a></p>`, "auth"));
    } catch (e) {
      await log("oauth_callback_error", { error: e.message }); console.error(e);
      res.status(500).send(site.page("Something went wrong", `<h1>Something went wrong</h1><p>We could not finish connecting your account. Please try again in a moment.</p>${retry}`, "auth"));
    }
  });
};
