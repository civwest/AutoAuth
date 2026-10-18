"use strict";
// Signed-up accounts: Discord sign-up/login, a dashboard per account at /dashboard/<username>, per-project dashboards and support chat.
const crypto = require("node:crypto");

const RESERVED = new Set(["users", "servers", "dm", "logs", "projects", "support", "messages", "discord", "database", "presence", "shutdown", "restart", "roles", "admin", "login", "logout", "signup", "account", "api", "oauth", "auth", "channels", "profile", "static", "public"]);
const NAME = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;
const MAX_PROJECTS = 10;

const SETUP = {
  oauth: (u) => [`In the Discord Developer Portal open your application > OAuth2 > Redirects and add <code>${u}</code>.`, "Build your authorize link with the same redirect URI and send people to it. Authorized users show up in the Users tab when storing is on."],
  interactions: (u) => [`Developer Portal > your application > General Information > Interactions Endpoint URL: <code>${u}</code>.`, "Copy the application's public key from the same page into this project. Discord checks the endpoint when you save."],
  webhook: (u) => [`Developer Portal > your application > Webhooks > Events URL: <code>${u}</code>.`, "Copy the application's public key from General Information into this project."],
  terms: (u) => [`Developer Portal > your application > General Information > Terms of Service URL: <code>${u}</code>.`],
  privacy: (u) => [`Developer Portal > your application > General Information > Privacy Policy URL: <code>${u}</code>.`],
  invite: (u) => [`Share <code>${u}</code>. It sends people to Discord's authorize page for your bot.`],
};

module.exports = function createAccounts({ pool, enc, dec, log, express, projects, pdata, site, esc, isOwnerName = () => false }) {
  const fp = (req) => crypto.createHash("sha256").update(String(req.get("user-agent") || "unknown")).digest("hex");
  const origin = () => { try { return new URL(process.env.REDIRECT_URI).origin; } catch { return ""; } };
  const hits = new Map();
  const limited = (k, max, ms = 60000) => { const n = Date.now(), h = hits.get(k); if (!h || h.until < n) { hits.set(k, { n: 1, until: n + ms }); return false; } return ++h.n > max; };
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.until < n) hits.delete(k); }, 60000).unref();
  const save = (req) => new Promise((ok) => req.session.save(ok));
  const regen = (req) => new Promise((ok, no) => req.session.regenerate((e) => (e ? no(e) : ok())));
  const clip = (s, n) => String(s ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);

  const DISCORD_ICON = require("./icons").discord;
  // One page layout shared by /login and /signup.
  const AUTH_CSS = "body{font:16px system-ui;background:#0d1117;color:#e6edf3}.box{max-width:420px;margin:10vh auto;padding:28px;background:#161b22;border:1px solid #30363d;border-radius:14px}input,button,.alt{width:100%;padding:12px;margin:8px 0 14px;box-sizing:border-box;border-radius:8px;border:1px solid #30363d;font:inherit}input{background:#0d1117;color:white}button.go{background:#7289da;color:white;border:0;cursor:pointer}.alt{display:block;text-align:center;color:#e6edf3;text-decoration:none;margin:8px 0 0}.or{display:flex;align-items:center;gap:10px;color:#9da7b3;font-size:13px;margin:6px 0}.or span{flex:1;height:1px;background:#30363d}.dc{display:flex;align-items:center;justify-content:center;gap:10px;padding:12px;border-radius:6px;background:#5865F2;color:#fff;text-decoration:none;font-weight:600;border:0;cursor:pointer;width:100%;margin:0;font-size:16px}.err{color:#ff8a8a}.muted{color:#9da7b3;font-size:14px}";
  const dcIcon = `<svg viewBox="0 0 24 24" width="22" height="22" fill="#fff" aria-hidden="true"><path d="${DISCORD_ICON}"/></svg>`;
  const discordLink = (href, label) => social.btn("discord", label, { href });
  const discordPost = (intent, label) => social.btn("discord", label, { post: "/signup/discord", fields: { intent } });
  const authPage = ({ title, sub, error, top, form, foot }) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${AUTH_CSS}</style><div class="box"><h1>AutoAuth</h1><p>${esc(sub)}</p>${error ? `<p class="err">${esc(error)}</p>` : ""}<div style="display:flex;flex-direction:column;gap:10px">${top}</div><div class="or"><span></span>or<span></span></div>${form}${foot}</div>`;

  const slugName = (s) => { let u = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, ""); if (u.length < 3) u = (u + "user").slice(0, 20); return u; };
  async function freeUsername(base) {
    for (let n = 0; n < 50; n++) {
      const suffix = n === 0 ? "" : String(n + 1), u = base.slice(0, 20 - suffix.length).replace(/-+$/, "") + suffix;
      if (!NAME.test(u) || RESERVED.has(u) || isOwnerName(u)) continue;
      if (!(await pool.query("SELECT 1 FROM accounts WHERE username=$1", [u])).rows[0]) return u;
    }
    return "user" + crypto.randomBytes(4).toString("hex");
  }
  const hashPw = (pw) => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex")}`; };
  const checkPw = (pw, h) => { try { const [alg, salt, exp] = String(h).split("$"); if (alg !== "scrypt") return false; const got = crypto.scryptSync(pw, Buffer.from(salt, "hex"), 32, { N: 16384, r: 8, p: 1 }); return crypto.timingSafeEqual(got, Buffer.from(exp, "hex")); } catch { return false; } };
  async function createAccount({ username, name, discordId, avatar, passwordHash }) {
    const r = await pool.query("INSERT INTO accounts(username,display_name,discord_id,discord_name,avatar,password_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,username", [username, name, discordId || null, discordId ? name : null, avatar || null, passwordHash || null]);
    await pool.query("INSERT INTO support_messages(account_id,from_admin,sender,body,read_admin) VALUES($1,true,'Support',$2,true)", [r.rows[0].id, "Welcome. Message us here if you need help with a project."]);
    await log("account_created", { username });
    return r.rows[0];
  }

  // Discord sign-up: the account takes its name from the Discord account.
  async function accountDiscord(req, u) {
    const name = clip(u.global_name || u.username || u.id, 60);
    const avatar = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : "";
    const row = (await pool.query("SELECT id,username FROM accounts WHERE discord_id=$1", [u.id])).rows[0];
    if (req.session.acctIntent === "link" && req.session.acct) {
      const s = req.session.acct, back = `/dashboard/${s.username}/profile`;
      if (row && String(row.id) !== s.id) return { status: 409, title: "Already linked", error: "That Discord account is linked to another account.", back };
      await pool.query("UPDATE accounts SET discord_id=$2,discord_name=$3,avatar=COALESCE(avatar,$4) WHERE id=$1", [s.id, u.id, name, avatar || null]);
      req.session.flash = "Discord linked."; delete req.session.acctIntent; await save(req);
      return { redirect: back };
    }
    if (row) return start(req, row);
    if (req.session.acctIntent === "login") return { status: 404, title: "No account found", error: "There is no account for this Discord user yet.", back: "/signup" };
    const acct = await createAccount({ username: await freeUsername(slugName(u.username || u.global_name)), name, discordId: u.id, avatar });
    return start(req, acct);
  }
  // Used by the login page's Discord button.
  async function accountLogin(req, u) {
    const row = (await pool.query("SELECT id,username FROM accounts WHERE discord_id=$1", [u.id])).rows[0];
    return row ? start(req, row) : null;
  }
  async function start(req, row) {
    await regen(req);
    req.session.acct = { id: String(row.id), username: row.username };
    req.session.acctFp = fp(req);
    await save(req);
    await pool.query("UPDATE accounts SET last_login=NOW() WHERE id=$1", [row.id]).catch(() => {});
    return { redirect: "/dashboard/" + row.username };
  }
  async function passwordLogin(username, pw) {
    const r = (await pool.query("SELECT id,username,password_hash FROM accounts WHERE username=$1", [String(username).trim().toLowerCase()])).rows[0];
    if (!r || !r.password_hash) { checkPw(pw, "scrypt$00$00"); return null; }
    return checkPw(pw, r.password_hash) ? r : null;
  }

  const social = require("./social")({ pool, log, esc, origin, clip, save, limited, slugName, freeUsername, createAccount, start, authPage });
  const socialButtons = (intent) => social.buttons(intent);

  function mountPublic(app) {
    social.mountPublic(app);
    pdata.mountPublic(app);
    app.get("/signup", (req, res) => {
      if (req.session && req.session.acct) return res.redirect(303, "/dashboard/" + req.session.acct.username);
      const e = { taken: "That username is taken.", name: "Use 3 to 20 letters, numbers or dashes.", pw: "Use a password of at least 8 characters.", rate: "Too many attempts. Try again later." }[req.query.e] || "";
      res.set("Cache-Control", "no-store").send(authPage({ title: "AutoAuth Sign up", sub: "Create an account", error: e, top: discordPost("signup", "Sign up with Discord") + socialButtons("signup"),
        form: `<form method="post" action="/signup"><label>Username</label><input name="username" maxlength="20" autocomplete="username" required><label>Password</label><input type="password" name="password" minlength="8" autocomplete="new-password" required><button class="go">Create account</button></form>`,
        foot: `<p class="muted">Already have an account? <a href="/login" style="color:#9db4ff">Log in</a></p><p class="muted">Project data is encrypted. AutoAuth's admins cannot read it or open your dashboard.</p>` }));
    });
    app.post("/signup", async (req, res) => {
      if (limited("sp:" + req.ip, 10, 600000)) return res.redirect(303, "/signup?e=rate");
      const u = clip((req.body || {}).username, 20).toLowerCase(), pw = String((req.body || {}).password || "");
      if (!NAME.test(u) || RESERVED.has(u) || isOwnerName(u)) return res.redirect(303, "/signup?e=name");
      if (pw.length < 8 || pw.length > 200) return res.redirect(303, "/signup?e=pw");
      try {
        const acct = await createAccount({ username: u, name: u, passwordHash: hashPw(pw) });
        const out = await start(req, acct); res.redirect(303, out.redirect);
      } catch (e) { if (e.code === "23505") return res.redirect(303, "/signup?e=taken"); console.error(e); res.status(500).send("Something went wrong."); }
    });
    app.post("/account/logout", (req, res) => { req.session.destroy(() => res.redirect(303, "/")); });
  }

  // ---------- helpers for dashboards ----------
  const acctOnly = async (req, res, next) => {
    const s = req.session && req.session.acct;
    if (!s) return res.redirect(303, "/signup");
    if (req.session.acctFp !== fp(req)) return req.session.destroy(() => res.redirect(303, "/signup"));
    if (req.params.u && req.params.u !== s.username) return res.redirect(303, "/dashboard/" + s.username);
    const a = (await pool.query("SELECT id,username,display_name,discord_name,avatar FROM accounts WHERE id=$1", [s.id])).rows[0];
    if (!a) return req.session.destroy(() => res.redirect(303, "/signup"));
    req.acct = a; next();
  };

  function mountDash({ app, renderFor, verifyOrigin, sendDm }) {
    const json = express.json({ limit: "100kb" });
    const nav = (a, tab) => {
      const l = (k, h, t) => `<a class="${tab === k ? "on" : ""}" href="${h}">${t}</a>`;
      return l("projects", `/dashboard/${a.username}`, "Projects") + l("support", `/dashboard/${a.username}/support`, "Support") + l("profile", `/dashboard/${a.username}/profile`, "Profile");
    };
    const page = (req, res, tab, content) => renderFor(req, res, tab, content, { nav: nav(req.acct, tab), who: req.acct.username, whoHref: `/dashboard/${req.acct.username}/profile`, logout: "/account/logout" });
    const full = (a, name) => `${a.username}/${name}`;
    const own = async (a, name) => (await pool.query("SELECT slug,name,type,config,locked FROM side_projects WHERE slug=$1 AND owner_account=$2", [full(a, String(name)), a.id])).rows[0];
    const short = (a, p) => ({ ...p, slug: p.slug.slice(a.username.length + 1) });

    // projects list
    app.get("/dashboard/:u", acctOnly, async (req, res) => {
      const a = req.acct;
      const rows = (await pool.query("SELECT p.slug,p.name,p.type,p.config,p.locked,(SELECT COUNT(*)::int FROM side_project_users u WHERE u.slug=p.slug) AS users FROM side_projects p WHERE p.owner_account=$1 ORDER BY p.created_at DESC", [a.id])).rows.map((p) => short(a, p));
      const content = projects.editor(rows, `/dashboard/${a.username}/projects`, esc, {
        prefix: a.username + "/", urlFn: (p) => projects.urlOf({ type: p.type, slug: full(a, p.slug) }),
        extra: (p) => `<a class="btn secondary" href="/dashboard/${a.username}/${esc(p.slug)}/setup">Open</a>`,
      });
      page(req, res, "projects", content + `<p class="muted" style="margin-top:14px">Data collected by your projects is encrypted. AutoAuth's admins cannot read it or open this dashboard.</p>`);
    });
    app.post("/dashboard/:u/projects", acctOnly, verifyOrigin, json, async (req, res) => {
      const a = req.acct, b = req.body || {}, name = clip(b.name, 40), type = String(b.type || "");
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      if (!projects.TYPES[type]) return res.status(400).json({ error: "Choose what the project is for." });
      if (!slug) return res.status(400).json({ error: "Enter a name using letters or numbers." });
      if (limited("pc:" + a.id, 10, 3600000)) return res.status(429).json({ error: "Too many projects created. Try again later." });
      const n = (await pool.query("SELECT COUNT(*)::int n FROM side_projects WHERE owner_account=$1", [a.id])).rows[0].n;
      if (n >= MAX_PROJECTS) return res.status(400).json({ error: `You can have up to ${MAX_PROJECTS} projects.` });
      try {
        const config = projects.clean(type, b.config);
        await pool.query("INSERT INTO side_projects(slug,name,type,config,created_by,owner_account) VALUES($1,$2,$3,$4,$5,$6)", [full(a, slug), name, type, JSON.stringify(config), a.username, a.id]);
        await pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,'project_created',$2)", [full(a, slug), JSON.stringify({ type })]);
        res.json({ ok: true, slug });
      } catch (e) { res.status(e.code === "23505" ? 409 : 400).json({ error: e.code === "23505" ? "You already have a project with that name." : e.message }); }
    });
    app.post("/dashboard/:u/projects/:name", acctOnly, verifyOrigin, json, async (req, res) => {
      const p = await own(req.acct, req.params.name);
      if (!p) return res.status(404).json({ error: "Project not found." });
      if (p.locked) return res.status(403).json({ error: "This project is locked." });
      try {
        const config = projects.clean(p.type, (req.body || {}).config, p.config);
        await pool.query("UPDATE side_projects SET config=$2 WHERE slug=$1", [p.slug, JSON.stringify(config)]);
        await pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,'project_updated','{}')", [p.slug]);
        res.json({ ok: true });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });
    app.post("/dashboard/:u/projects/:name/delete", acctOnly, verifyOrigin, async (req, res) => {
      const p = await own(req.acct, req.params.name);
      if (!p) return res.status(404).json({ error: "Project not found." });
      await pool.query("DELETE FROM side_project_users WHERE slug=$1", [p.slug]);
      await pool.query("DELETE FROM project_logs WHERE slug=$1", [p.slug]);
      await pool.query("DELETE FROM side_projects WHERE slug=$1", [p.slug]);
      res.json({ ok: true });
    });

    // per-project dashboard: Setup, Users (when storing), Logs
    const sub = (a, p, tab) => {
      const stores = p.type === "oauth" && (p.config || {}).store;
      const t = (k, l) => `<a class="btn ${tab === k ? "" : "secondary"}" href="/dashboard/${a.username}/${esc(p.slug.slice(a.username.length + 1))}/${k}">${l}</a>`;
      return `<div class="top"><div><a class="muted" href="/dashboard/${a.username}">← Projects</a><h1 style="margin:6px 0">${esc(p.name)}</h1></div><div class="row" style="gap:8px;flex-wrap:wrap">${t("setup", "Setup")}${stores ? t("users", "Users") : ""}${pdata.tabsFor(p).map(([k, l]) => t(k, l)).join("")}${t("logs", "Logs")}</div></div>${p.locked ? '<div class="card" style="border-color:#e0556a"><b>This project is locked.</b> Check Support for details.</div>' : ""}`;
    };
    app.get("/dashboard/:u/:name/setup", acctOnly, async (req, res) => {
      const p = await own(req.acct, req.params.name); if (!p) return res.status(404).send("Not found");
      const url = projects.urlOf(p), steps = SETUP[p.type](esc(url));
      const c = p.config || {}, chosen = String(c.scopes || "").split(" ").filter(Boolean);
      let link = "";
      if (p.type === "oauth" && c.client_id) { const q = new URLSearchParams({ client_id: c.client_id, response_type: "code", redirect_uri: url }); q.set("scope", chosen.join(" ") || "identify"); link = "https://discord.com/oauth2/authorize?" + q; }
      if (p.type === "invite") link = url;
      const notes = chosen.map((k) => projects.SCOPES.find((s) => s[0] === k)).filter(Boolean);
      page(req, res, "projects", sub(req.acct, p, "setup") + `<div class="card"><h2>Setup</h2><ol>${steps.map((s) => `<li style="margin:8px 0">${s}</li>`).join("")}</ol>${link && p.type === "oauth" ? `<h3>Authorize link</h3><p><code style="word-break:break-all">${esc(link)}</code></p>` : ""}</div>${notes.length ? `<div class="card" style="margin-top:16px"><h2>Permissions</h2>${notes.map((s) => `<p style="margin:10px 0"><b>${esc(s[0])}</b>: ${esc(s[1])}${s[3] ? " <i>(needs Discord approval)</i>" : ""}<br><span class="muted">${esc(s[2])}</span></p>`).join("")}</div>` : ""}`);
    });
    app.get("/dashboard/:u/:name/users", acctOnly, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name); if (!p) return res.status(404).send("Not found");
      const r = (await pool.query("SELECT user_id,username,scope,created_at FROM side_project_users WHERE slug=$1 ORDER BY created_at DESC LIMIT 500", [p.slug])).rows;
      page(req, res, "projects", sub(a, p, "users") + `<div class="card"><div class="wrap"><table class="stack"><tr><th>User</th><th>ID</th><th>Scopes</th><th>Added</th><th></th></tr>${r.map((x) => `<tr><td data-l="User">${esc(x.username)}</td><td data-l="ID">${esc(x.user_id)}</td><td data-l="Scopes">${esc(x.scope)}</td><td data-l="Added">${esc(new Date(x.created_at).toISOString().slice(0, 16).replace("T", " "))}</td><td class="actcell"><form method="post" action="/dashboard/${esc(a.username)}/${esc(req.params.name)}/users/${esc(x.user_id)}/delete" onsubmit="return confirm('Remove this user and their data?')" style="margin:0"><button class="danger" style="width:auto">Remove</button></form></td></tr>`).join("") || '<tr><td colspan="5">No users yet.</td></tr>'}</table></div></div>`);
    });
    app.get("/dashboard/:u/:name/logs", acctOnly, async (req, res) => {
      const a = req.acct, p = await own(a, req.params.name); if (!p) return res.status(404).send("Not found");
      const r = (await pool.query("SELECT event_type,detail,created_at FROM project_logs WHERE slug=$1 ORDER BY id DESC LIMIT 200", [p.slug])).rows;
      page(req, res, "projects", sub(a, p, "logs") + `<div class="card"><div class="wrap"><table class="stack"><tr><th>Time (UTC)</th><th>Event</th><th>Details</th></tr>${r.map((x) => `<tr><td data-l="Time">${esc(new Date(x.created_at).toISOString().slice(0, 19).replace("T", " "))}</td><td data-l="Event">${esc(x.event_type)}</td><td data-l="Details"><code style="word-break:break-all">${esc(JSON.stringify(x.detail))}</code></td></tr>`).join("") || '<tr><td colspan="3">No events yet.</td></tr>'}</table></div></div>`);
    });

    pdata.mount({ app, acctOnly, verifyOrigin, page, sub, own, json, sendDm });

    // support chat
    app.get("/dashboard/:u/support", acctOnly, async (req, res) => {
      await pool.query("UPDATE support_messages SET read_user=true WHERE account_id=$1 AND from_admin", [req.acct.id]);
      page(req, res, "support", chatHtml(`/dashboard/${req.acct.username}/support`, "Support"));
    });
    app.get("/dashboard/:u/support/poll", acctOnly, async (req, res) => {
      await pool.query("UPDATE support_messages SET read_user=true WHERE account_id=$1 AND from_admin", [req.acct.id]);
      res.set("Cache-Control", "no-store").json(await thread(req.acct.id, Number(req.query.after) || 0));
    });
    app.post("/dashboard/:u/support", acctOnly, verifyOrigin, json, async (req, res) => {
      const body = clip((req.body || {}).text, 2000);
      if (!body) return res.status(400).json({ error: "Write a message first." });
      if (limited("sm:" + req.acct.id, 20)) return res.status(429).json({ error: "Slow down a little." });
      await pool.query("INSERT INTO support_messages(account_id,from_admin,sender,body,read_user) VALUES($1,false,$2,$3,true)", [req.acct.id, req.acct.display_name || req.acct.username, body]);
      res.json({ ok: true });
    });

    // profile
    const methods = async (id) => { const r = (await pool.query("SELECT (password_hash IS NOT NULL) AS pw,(discord_id IS NOT NULL) AS dc FROM accounts WHERE id=$1", [id])).rows[0] || {}; return (r.pw ? 1 : 0) + (r.dc ? 1 : 0) + (await social.identities(id)).length; };
    const back = (req, msg) => { if (msg) req.session.flash = msg; return `/dashboard/${req.acct.username}/profile`; };
    app.get("/dashboard/:u/profile", acctOnly, async (req, res) => {
      const a = req.acct, ids = await social.identities(a.id), hasPw = !!(await pool.query("SELECT 1 FROM accounts WHERE id=$1 AND password_hash IS NOT NULL", [a.id])).rows[0];
      const row = (label, linked, link, unlink) => `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)"><div style="flex:1;min-width:120px"><b>${label}</b><div class="muted">${linked ? esc(linked) : "Not linked"}</div></div>${linked ? unlink : link}</div>`;
      const unl = (p) => `<form method="post" action="/dashboard/${esc(a.username)}/profile/unlink/${p}" style="margin:0"><button class="secondary" style="width:auto">Unlink</button></form>`;
      const lnk = (html) => `<div style="width:230px;max-width:100%">${html}</div>`;
      const social_ = Object.keys(social.PROV).map((k) => { const id = ids.find((i) => i.provider === k); return row(social.PROV[k].label, id && (id.name || "Linked"), lnk(social.linkButton(k)), unl(k)); }).join("");
      page(req, res, "profile", `<div class="top"><div><h1>Profile</h1></div></div><div class="card" style="max-width:560px"><div style="display:flex;gap:14px;align-items:center">${a.avatar ? `<img src="${esc(a.avatar)}" alt="" width="64" height="64" style="border-radius:50%">` : ""}<div><b>${esc(a.display_name || a.username)}</b><div class="muted">@${esc(a.username)}</div></div></div>
<form method="post" action="/dashboard/${esc(a.username)}/profile" style="margin-top:16px"><label>Display name</label><input name="display_name" maxlength="40" value="${esc(a.display_name || "")}"><button class="green" style="margin-top:12px">Save</button></form></div>
<div class="card" style="max-width:560px;margin-top:16px"><h2>Linked accounts</h2>
${row("Discord", a.discord_name, lnk(social.btn("discord", "Link Discord", { post: "/signup/discord", fields: { intent: "link" } })), unl("discord"))}${social_}</div>
<div class="card" style="max-width:560px;margin-top:16px"><h2>Password</h2><form method="post" action="/dashboard/${esc(a.username)}/profile/password">${hasPw ? '<label>Current password</label><input type="password" name="current" autocomplete="current-password" required>' : ""}<label>New password</label><input type="password" name="password" minlength="8" autocomplete="new-password" required><button class="green" style="margin-top:12px">${hasPw ? "Change password" : "Set password"}</button></form></div>
<div class="card" style="max-width:560px;margin-top:16px;border-color:#7a2b35"><h2>Delete account</h2><button type="button" class="danger" onclick="openDlg('dlg-del')">Delete account</button></div>
<dialog id="dlg-del"><div class="dlg-top"><h2 style="margin:0">Delete account</h2><button type="button" class="secondary" onclick="closeAll()">Close</button></div>
<p>This deletes your projects, stored users, logs and support messages. It cannot be undone.</p><form method="post" action="/dashboard/${esc(a.username)}/profile/delete"><label>Type <b>${esc(a.username)}</b> to confirm</label><input name="confirm" autocomplete="off" required><button class="danger" style="margin-top:12px">Delete everything</button></form></dialog>`);
    });
    const form = express.urlencoded({ extended: false, limit: "5kb" });
    app.post("/dashboard/:u/profile", acctOnly, verifyOrigin, form, async (req, res) => {
      const n = clip(req.body.display_name, 40) || req.acct.username;
      await pool.query("UPDATE accounts SET display_name=$2 WHERE id=$1", [req.acct.id, n]);
      res.redirect(303, back(req, "Saved."));
    });
    app.post("/dashboard/:u/profile/password", acctOnly, verifyOrigin, form, async (req, res) => {
      const r = (await pool.query("SELECT password_hash FROM accounts WHERE id=$1", [req.acct.id])).rows[0], pw = String(req.body.password || "");
      if (limited("pw:" + req.acct.id, 10, 600000)) return res.redirect(303, back(req, "Too many attempts."));
      if (r && r.password_hash && !checkPw(String(req.body.current || ""), r.password_hash)) return res.redirect(303, back(req, "Current password is wrong."));
      if (pw.length < 8 || pw.length > 200) return res.redirect(303, back(req, "Use a password of at least 8 characters."));
      await pool.query("UPDATE accounts SET password_hash=$2 WHERE id=$1", [req.acct.id, hashPw(pw)]);
      res.redirect(303, back(req, "Password saved."));
    });
    app.post("/dashboard/:u/profile/unlink/:provider", acctOnly, verifyOrigin, async (req, res) => {
      const p = req.params.provider;
      if (!(p === "discord" || social.PROV[p])) return res.redirect(303, back(req));
      if ((await methods(req.acct.id)) < 2) return res.redirect(303, back(req, "Set a password or link another account first. You need at least one way to log in."));
      if (p === "discord") await pool.query("UPDATE accounts SET discord_id=NULL,discord_name=NULL WHERE id=$1", [req.acct.id]);
      else await pool.query("DELETE FROM account_identities WHERE account_id=$1 AND provider=$2", [req.acct.id, p]);
      res.redirect(303, back(req, "Unlinked."));
    });
    app.post("/dashboard/:u/profile/delete", acctOnly, verifyOrigin, form, async (req, res) => {
      const a = req.acct;
      if (String(req.body.confirm || "").trim().toLowerCase() !== a.username) return res.redirect(303, back(req, "Type your username exactly to delete the account."));
      const slugs = (await pool.query("SELECT slug FROM side_projects WHERE owner_account=$1", [a.id])).rows.map((r) => r.slug);
      if (slugs.length) {
        await pool.query("DELETE FROM side_project_users WHERE slug=ANY($1)", [slugs]);
        await pool.query("DELETE FROM project_logs WHERE slug=ANY($1)", [slugs]);
        await pool.query("DELETE FROM project_data WHERE slug=ANY($1)", [slugs]).catch(() => {});
      }
      await pool.query("DELETE FROM accounts WHERE id=$1", [a.id]); // projects, identities and support messages cascade
      await log("account_deleted", { username: a.username });
      req.session.destroy(() => res.redirect(303, "/"));
    });
  }

  // ---------- support thread (shared by both sides) ----------
  async function thread(accountId, after) {
    const r = (await pool.query("SELECT id,from_admin,sender,body,created_at FROM support_messages WHERE account_id=$1 AND id>$2 ORDER BY id LIMIT 200", [accountId, after])).rows;
    return r.map((m) => ({ id: Number(m.id), admin: m.from_admin, who: m.from_admin ? "Support" : m.sender, text: m.body, at: new Date(m.created_at).getTime() }));
  }
  const CHAT_JS = `(function(){var C=JSON.parse(document.getElementById('chat-cfg').textContent),box=document.getElementById('msgs'),last=0,busy=false;
function add(m){var r=document.createElement('div');r.className='msg';var b=document.createElement('div'),h=document.createElement('div'),w=document.createElement('span'),t=document.createElement('span'),x=document.createElement('div');
w.className='who';w.textContent=m.who;t.className='when';t.textContent=' '+new Date(m.at).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});x.className='txt';x.style.whiteSpace='pre-wrap';x.textContent=m.text;
h.appendChild(w);h.appendChild(t);b.appendChild(h);b.appendChild(x);r.appendChild(b);box.appendChild(r);}
async function poll(){if(busy)return;busy=true;try{var r=await fetch(C.base+'/poll?after='+last,{cache:'no-store'});if(r.ok){var l=await r.json(),near=box.scrollHeight-box.scrollTop-box.clientHeight<80||!last;l.forEach(function(m){add(m);last=Math.max(last,m.id);});if(l.length&&near)box.scrollTop=box.scrollHeight;}}catch(e){}busy=false;}
var f=document.getElementById('composer'),t=document.getElementById('txt');
f.addEventListener('submit',async function(e){e.preventDefault();var v=t.value.trim();if(!v)return;t.value='';try{var r=await fetch(C.base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:v})});if(!r.ok){var j=await r.json().catch(function(){return{};});toast(j.error||'Could not send.',true);t.value=v;}else poll();}catch(x){toast('Could not send.',true);t.value=v;}});
t.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit();}});
poll();setInterval(poll,4000);})();`;
  const chatHtml = (base, title, top) => `<div class="top">${top || `<div><h1>${esc(title)}</h1></div>`}</div>
<div class="card chat"><div class="msgs" id="msgs"></div><form class="composer" id="composer" autocomplete="off"><textarea id="txt" maxlength="2000" placeholder="Write a message" rows="1"></textarea><button class="green">Send</button></form></div>
<script type="application/json" id="chat-cfg">${JSON.stringify({ base }).replace(/</g, "\\u003c")}</script><script>document.addEventListener('DOMContentLoaded',function(){${CHAT_JS}});</script>`;

  // ---------- admin side: Support tab (accounts' names only) ----------
  function mountAdmin({ app, logged, verifyOrigin, render }) {
    pdata.mountAdmin({ app, logged, verifyOrigin });
    const json = express.json({ limit: "20kb" });
    app.get("/dashboard/support", logged, async (req, res) => {
      const r = (await pool.query(`SELECT a.id,a.username,a.display_name,a.created_at,
        (SELECT COUNT(*)::int FROM support_messages m WHERE m.account_id=a.id AND NOT m.from_admin AND NOT m.read_admin) AS unread,
        (SELECT MAX(created_at) FROM support_messages m WHERE m.account_id=a.id) AS last FROM accounts a ORDER BY unread DESC, last DESC NULLS LAST LIMIT 300`)).rows;
      render(req, res, "support", `<div class="top"><div><h1>Support</h1></div></div><div class="card">${r.map((a) => `<a class="dmrow" href="/dashboard/support/${a.id}"><div style="flex:1"><b>${esc(a.display_name || a.username)}</b> <span class="muted">@${esc(a.username)}</span></div>${a.unread ? `<span class="pill">${a.unread} new</span>` : ""}</a>`).join("") || '<p class="muted">No accounts yet.</p>'}</div>` + await pdata.flagsHtml());
    });
    const acc = async (id) => (await pool.query("SELECT id,username,display_name FROM accounts WHERE id=$1", [Number(id) || 0])).rows[0];
    app.get("/dashboard/support/:id", logged, async (req, res) => {
      const a = await acc(req.params.id); if (!a) return res.status(404).send("Not found");
      await pool.query("UPDATE support_messages SET read_admin=true WHERE account_id=$1 AND NOT from_admin", [a.id]);
      render(req, res, "support", chatHtml(`/dashboard/support/${a.id}`, "", `<div><a class="muted" href="/dashboard/support">← Support</a><h1 style="margin:6px 0">${esc(a.display_name || a.username)} <span class="muted" style="font-size:16px">@${esc(a.username)}</span></h1></div>`));
    });
    app.get("/dashboard/support/:id/poll", logged, async (req, res) => {
      const a = await acc(req.params.id); if (!a) return res.status(404).json([]);
      await pool.query("UPDATE support_messages SET read_admin=true WHERE account_id=$1 AND NOT from_admin", [a.id]);
      res.set("Cache-Control", "no-store").json(await thread(a.id, Number(req.query.after) || 0));
    });
    app.post("/dashboard/support/:id", logged, verifyOrigin, json, async (req, res) => {
      const a = await acc(req.params.id); if (!a) return res.status(404).json({ error: "Not found." });
      const body = clip((req.body || {}).text, 2000); if (!body) return res.status(400).json({ error: "Write a message first." });
      await pool.query("INSERT INTO support_messages(account_id,from_admin,sender,body,read_admin) VALUES($1,true,$2,$3,true)", [a.id, req.session.owner, body]);
      res.json({ ok: true });
    });
  }

  // Signed-in accounts that open /dashboard land on their own dashboard.
  const landing = (req) => (req.session && req.session.acct && !req.session.owner ? "/dashboard/" + req.session.acct.username : null);

  return { socialButtons, accountDiscord, accountLogin, passwordLogin, start, authPage, discordLink, mountPublic, mountDash, mountAdmin, landing };
};
