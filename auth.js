// Authorization flow: /auth page (three options, each with an agreement popup + captcha),
// /auth/captcha, /auth/start, and /oauth/callback.
//
// Security notes:
//  - The Discord "state" is signed (HMAC) and carries the chosen mode + expiry, so the callback only
//    accepts flows that were started from this site after the agreement and captcha were completed.
//  - The captcha is built in (no third-party service). Its answer is never sent to the browser; the
//    token is an HMAC of the answer and every token is single-use.
const crypto = require("node:crypto");

// scope strings and whether the user-install integration type is used
const MODES = {
  server: { code: "s", scope: ["guilds.join", "identify"], userInstall: false },
  dm: { code: "d", scope: ["identify", "applications.commands"], userInstall: true },
  all: { code: "a", scope: ["identify", "applications.commands", "guilds.join"], userInstall: true },
};
const BY_CODE = Object.fromEntries(Object.entries(MODES).map(([k, v]) => [v.code, k]));

module.exports = function mountAuth(app, ctx) {
  const { site, pool, enc, log, equal, verifyOrigin } = ctx;
  const secret = process.env.SESSION_SECRET;
  const used = new Map(); // nonce -> expiry (single-use state + captcha tokens)
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
  function consumeState(st) {
    const [c, n, exp, sig] = String(st || "").split(".");
    if (!c || !n || !exp || !sig || !BY_CODE[c]) return null;
    if (!equal(sig, hmac(`state:${c}.${n}.${exp}`)) || !(Number(exp) > Date.now()) || used.has("s" + n)) return null;
    used.set("s" + n, Number(exp));
    return BY_CODE[c];
  }
  function discordUrl(mode) {
    const m = MODES[mode], u = new URL("https://discord.com/oauth2/authorize");
    u.searchParams.set("client_id", process.env.CLIENT_ID);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", process.env.REDIRECT_URI);
    if (m.userInstall) u.searchParams.set("integration_type", "1");
    u.searchParams.set("scope", m.scope.join(" "));
    u.searchParams.set("state", makeState(mode));
    return u.toString();
  }

  // ---- captcha ----
  const CH = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const rnd = (a, b) => a + (crypto.randomInt(0, 10000) / 10000) * (b - a);
  function captchaSvg(text) {
    const col = () => `rgb(${Math.floor(rnd(20, 120))},${Math.floor(rnd(20, 120))},${Math.floor(rnd(20, 120))})`;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="64" viewBox="0 0 200 64" role="img" aria-label="Captcha image"><rect width="200" height="64" rx="8" fill="#f3f4f6"/>`;
    for (let i = 0; i < 5; i++) s += `<path d="M${rnd(0, 20).toFixed(1)} ${rnd(5, 59).toFixed(1)} C ${rnd(50, 90).toFixed(1)} ${rnd(0, 64).toFixed(1)}, ${rnd(110, 150).toFixed(1)} ${rnd(0, 64).toFixed(1)}, ${rnd(180, 200).toFixed(1)} ${rnd(5, 59).toFixed(1)}" stroke="${col()}" stroke-width="1.4" fill="none" opacity=".65"/>`;
    [...text].forEach((ch, i) => {
      const x = 22 + i * 32;
      s += `<text x="${x}" y="${rnd(38, 48).toFixed(1)}" font-family="monospace" font-size="${rnd(30, 36).toFixed(1)}" font-weight="700" fill="${col()}" transform="rotate(${rnd(-22, 22).toFixed(1)} ${x} 40)">${ch}</text>`;
    });
    for (let i = 0; i < 30; i++) s += `<circle cx="${rnd(0, 200).toFixed(1)}" cy="${rnd(0, 64).toFixed(1)}" r="${rnd(0.6, 1.4).toFixed(1)}" fill="${col()}" opacity=".7"/>`;
    return s + "</svg>";
  }
  function newCaptcha() {
    const text = Array.from({ length: 5 }, () => CH[crypto.randomInt(CH.length)]).join("");
    const nonce = crypto.randomBytes(8).toString("hex"), exp = Date.now() + 5 * 60 * 1000;
    return { token: `${nonce}.${exp}.${hmac(`captcha:${text}:${nonce}:${exp}`)}`, svg: captchaSvg(text) };
  }
  function checkCaptcha(token, answer) {
    const [nonce, exp, sig] = String(token || "").split(".");
    if (!nonce || !exp || !sig || !(Number(exp) > Date.now()) || used.has("c" + nonce)) return false;
    used.set("c" + nonce, Number(exp)); // consumed on every attempt, right or wrong
    return equal(sig, hmac(`captcha:${String(answer || "").trim().toUpperCase()}:${nonce}:${exp}`));
  }

  // ---- pages ----
  const ERRORS = {
    captcha: "That captcha answer was not correct. Please try again.",
    agree: "You need to tick the agreement box to continue.",
    rate: "Too many attempts. Please wait a few minutes and try again.",
  };

  app.get("/auth", (req, res) => {
    const err = ERRORS[req.query.error] ? `<div class="banner">${ERRORS[req.query.error]}</div>` : "";
    const reopen = ["server", "dm", "all"].includes(req.query.mode) && ERRORS[req.query.error] ? req.query.mode : "";
    res.set("Cache-Control", "no-store").send(site.page("Authorization", `<h1>Authorization</h1>
<p class="lead">Choose what you want to allow. You will read and agree to the details, complete a quick check, and then approve on Discord.</p>
${err}
<div class="authgrid">
<button type="button" class="authopt" onclick="openAgree('server')"><b>Allow Server Joins</b><span>Let server admins and the owners add you to servers that use AutoAuth.</span></button>
<button type="button" class="authopt" onclick="openAgree('dm')"><b>Allow Direct Messages</b><span>Let the owners send you DMs through the bot. Installs AutoAuth to your account.</span></button>
<button type="button" class="authopt" onclick="openAgree('all')"><b>Allow Both</b><span>Server joins and direct messages in one approval.</span></button>
</div>
<noscript><p class="banner">JavaScript is required for the captcha on this page.</p></noscript>
<p class="updated">Already authorized? Run <code>/optout</code> in Discord any time to opt out of servers, DMs or everything. AutoAuth is an independent project run by civwest and is not affiliated with Discord Inc.</p>
<dialog class="dlg" id="agree">
<form method="post" action="/auth/start" id="agree-form">
<h2 id="ag-title"></h2>
<p>By continuing you agree to the following:</p>
<ul class="agree-list" id="ag-list"></ul>
<input type="hidden" name="mode" id="ag-mode">
<label class="chk"><input type="checkbox" name="agree" value="yes" id="ag-chk" required><span>I have read and agree to the <a href="/terms-of-service" target="_blank">Terms of Service</a> and <a href="/privacy-policy" target="_blank">Privacy Policy</a>, and I consent to the above.</span></label>
<p style="margin:12px 0 4px"><b>Quick check</b>: type the characters you see.</p>
<div class="capbox"><div id="cap-img"></div><input name="answer" id="cap-ans" autocomplete="off" maxlength="8" required aria-label="Captcha answer"><button type="button" class="linkbtn" onclick="loadCaptcha()">New image</button></div>
<input type="hidden" name="token" id="cap-token">
<div class="btns"><button class="btn green" type="submit">I agree, continue to Discord</button><button type="button" class="btn gray" onclick="closeDlg('agree')">Cancel</button></div>
</form></dialog>
<script>
var MODES={
 server:{t:'Allow server joins',l:['AutoAuth stores your Discord username and ID, and encrypted access tokens.','Server administrators and the AutoAuth owners can add you to servers where AutoAuth is installed, and the owners can remove you from them.']},
 dm:{t:'Allow direct messages',l:['AutoAuth stores your Discord username and ID, and encrypted access tokens.','AutoAuth is installed to your Discord account so its commands work anywhere.','The AutoAuth owners can send you direct messages, which may include attachments, through the bot.']},
 all:{t:'Allow server joins and direct messages',l:['AutoAuth stores your Discord username and ID, and encrypted access tokens.','Server administrators and the AutoAuth owners can add you to servers where AutoAuth is installed, and the owners can remove you from them.','AutoAuth is installed to your Discord account, and the owners can send you direct messages, which may include attachments.']}
};
var COMMON='You can opt out at any time with /optout in Discord. Your authorization stays active until you opt out, unless the owners set an expiry.';
async function loadCaptcha(){var i=document.getElementById('cap-img');i.textContent='Loading…';try{var r=await fetch('/auth/captcha',{cache:'no-store'});var j=await r.json();i.innerHTML=j.svg;document.getElementById('cap-token').value=j.token;document.getElementById('cap-ans').value='';}catch(e){i.textContent='Could not load the captcha. Reload the page.';}}
function openAgree(m){var d=MODES[m];if(!d)return;document.getElementById('ag-title').textContent=d.t;var ul=document.getElementById('ag-list');ul.innerHTML='';d.l.concat([COMMON]).forEach(function(x){var li=document.createElement('li');li.textContent=x;ul.appendChild(li);});document.getElementById('ag-mode').value=m;document.getElementById('ag-chk').checked=false;loadCaptcha();openDlg('agree');}
${reopen ? `document.addEventListener('DOMContentLoaded',function(){openAgree(${JSON.stringify(reopen)});});` : ""}
</script>`, "auth"));
  });

  app.get("/auth/captcha", (req, res) => {
    if (limited("cap:" + (req.ip || "?"), 40, 10 * 60 * 1000)) return res.status(429).json({ error: "rate" });
    res.set("Cache-Control", "no-store").json(newCaptcha());
  });

  app.post("/auth/start", verifyOrigin, async (req, res) => {
    const ip = req.ip || "?", body = req.body || {}, mode = String(body.mode || "");
    if (!MODES[mode]) return res.redirect(303, "/auth");
    if (limited("start:" + ip, 12, 10 * 60 * 1000)) return res.redirect(303, `/auth?error=rate&mode=${mode}`);
    if (body.agree !== "yes") return res.redirect(303, `/auth?error=agree&mode=${mode}`);
    if (!checkCaptcha(body.token, body.answer)) return res.redirect(303, `/auth?error=captcha&mode=${mode}`);
    await log("auth_flow_started", { mode });
    return res.set("Cache-Control", "no-store").redirect(303, discordUrl(mode));
  });

  // Old direct link now just leads to the page.
  app.get("/auth/start", (_, res) => res.redirect(302, "/auth"));

  const retry = "<p><a class='cta' href='/auth'>Back to Authorization</a></p>";
  app.get("/oauth/callback", async (req, res) => {
    res.set({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
    const { code, state, error } = req.query;
    const mode = typeof state === "string" ? consumeState(state) : null;
    if (error) {
      await log("oauth_denied", { error: String(error) });
      return res.status(400).send(site.page("Authorization cancelled", `<h1>Authorization cancelled</h1><p>You did not approve AutoAuth, so nothing was saved.</p>${retry}`, "auth"));
    }
    if (!mode || typeof code !== "string" || !code) {
      await log("oauth_invalid_state");
      return res.status(400).send(site.page("Start from the website", `<h1>Please start from the website</h1><p>For security, authorization has to be started from the <a href="/auth">Authorization page</a>, where you read the details and complete a quick check. This link is invalid, expired, or was already used.</p>${retry}`, "auth"));
    }
    try {
      const r = await fetch("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: process.env.REDIRECT_URI }) });
      const t = await r.json();
      if (!r.ok) { await log("oauth_exchange_failed", { status: r.status, error: t.error }); return res.status(502).send(site.page("Authorization failed", `<h1>Authorization failed</h1><p>Discord rejected the sign-in. Please try again.</p>${retry}`, "auth")); }
      const ur = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${t.access_token}` } }), u = await ur.json();
      if (!ur.ok || !u.id) { await log("oauth_user_fetch_failed", { status: ur.status }); return res.status(502).send(site.page("Authorization failed", `<h1>Could not read your account</h1><p>Discord did not return your account details. Please try again.</p>${retry}`, "auth")); }
      // What was actually granted decides the flags; fall back to what was requested if Discord omits the scope field.
      const granted = typeof t.scope === "string" ? t.scope.split(/[ +]/) : MODES[mode].scope;
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
