// Public website for AutoAuth: home, info, terms, privacy policy.
// Added alongside the existing dashboard; it does not touch any /dashboard or /login route.
const fs = require("node:fs");
const path = require("node:path");
const icons = require("./icons");

const SITE = "https://autoauth-hbsb.onrender.com";
const LINKS = {
  docs: "https://github.com/civwest/AutoAuth",
  tiktok: "https://www.tiktok.com/@civwest",
  youtube: "https://www.youtube.com/@civwes",
  x: "https://x.com/civwes",
  twitch: "https://www.twitch.tv/civwest",
  discord: "https://discord.gg/N7EBbT2U67",
};

// Drop bg.webp and icon.webp into ./public to serve them from this site.
// Until then, the original Discord CDN links are used as a fallback (those links expire).
const IMAGES = {
  "bg.webp": "https://cdn.discordapp.com/attachments/1550769562411212852/1550769657529503754/temp_image_1BB73E3C-B6C3-4DB0-B42F-17322250C41A.webp?ex=6acd340a&is=6acbe28a&hm=402729b8df978d817a017cffe758c7a19bc9b45d721f1416ab687e2706645689&",
  "icon.webp": "https://cdn.discordapp.com/attachments/1550769562411212852/1550769659807014952/temp_image_AFC5DC73-24B4-4D49-A972-EED392BF3D39.webp?ex=6acd340a&is=6acbe28a&hm=34409f97a4bb7fa977dd75be497203defa61357da64e5d7f1e922ac7a17785ec&",
};
const PUBLIC_DIR = path.join(__dirname, "public");

const svg = (name, label) =>
  `<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" role="img" aria-label="${label}"><path d="${icons[name]}"/></svg>`;

const CSS = `
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;background:#000}
a{color:inherit}
.bg{position:fixed;inset:0;z-index:-1;background:#111 url(/assets/bg.webp) 50% 18%/cover no-repeat}
.nav{position:fixed;top:0;left:0;right:0;height:56px;background:#000;z-index:10;display:flex;justify-content:space-between;align-items:center;gap:6px;padding:0 20px}
.nav .grp{display:flex;align-items:center;gap:6px}
.nav a.tab.login{background:#fff;color:#000;padding:8px 18px}.nav a.tab.login:hover{background:#d1d5db}
.nav a.tab{color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-weight:600;font-size:15px}
.nav a.tab:hover,.nav a.tab.on{background:#222}
.nav .logo{display:block;width:34px;height:34px;margin-left:8px;border-radius:8px;object-fit:cover}
.spacer{height:var(--gap,72vh)}
.panel{position:relative;background:#fff;border-radius:22px 22px 0 0;min-height:70vh;padding:56px 24px 80px;box-shadow:0 -12px 40px rgba(0,0,0,.35)}
.in{max-width:820px;margin:0 auto}
h1{font-size:clamp(30px,5vw,46px);line-height:1.15;margin:0 0 12px}
h2{font-size:22px;margin:36px 0 8px}
p,li{color:#333}
.dot{display:inline-block;vertical-align:middle;position:relative;top:-3px;width:12px;height:12px;border-radius:50%;background:#22c55e;margin-right:10px;box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:pulse 2s infinite}
.dot.off{background:#f59e0b;animation:none}
@keyframes pulse{70%{box-shadow:0 0 0 12px rgba(34,197,94,0)}100%{box-shadow:0 0 0 0 rgba(34,197,94,0)}}
.lead{font-size:19px;color:#444}
table{border-collapse:collapse;width:100%;margin:12px 0}
td,th{text-align:left;padding:10px 12px;border-bottom:1px solid #e5e5e5;vertical-align:top}
code{background:#f1f1f1;padding:2px 6px;border-radius:5px;font-size:.92em}
.updated{color:#777;font-size:14px}
.cta{display:inline-block;background:#000;color:#fff;text-decoration:none;font-weight:600;padding:11px 22px;border-radius:10px}.cta:hover{background:#222}
footer{background:#000;color:#fff;padding:64px 28px 48px;min-height:260px;display:grid;grid-template-columns:1fr 1fr auto;gap:48px;align-items:start}
.fcol h3{margin:0 0 14px;font-size:20px;font-weight:700;color:#fff}.fcol p,.fcol li{color:#d1d5db;font-size:15px;line-height:1.7;margin:0 0 10px}.fcol ul{margin:0;padding:0;list-style:none}.fcol code{background:#1f2937;color:#fff;padding:2px 6px;border-radius:5px;font-size:.92em}
.foot{text-align:right}
.foot h3{margin:0 0 16px;font-size:20px;font-weight:700;color:#fff}
.icons{display:flex;justify-content:flex-end;gap:20px;margin-bottom:26px}
.icons a{color:#fff;display:inline-flex;transition:opacity .15s,transform .15s}
.icons a:hover{opacity:.7;transform:translateY(-2px)}
.legal a{display:block;color:#9ca3af;text-decoration:underline;font-size:14px;line-height:1.9}
.legal a:hover{color:#d1d5db}
@media(max-width:860px){footer{grid-template-columns:1fr;gap:36px}.foot{text-align:left}.icons{justify-content:flex-start}}
@media(max-width:600px){.nav{padding:0 10px}.nav a.tab{padding:8px 9px;font-size:14px}footer{padding:48px 20px 36px}}
`;

function layout({ title, active, gap = "72vh", body }) {
  const nav = (href, label, key) =>
    `<a class="tab${active === key ? " on" : ""}" href="${href}">${label}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="AutoAuth is a Discord bot that adds authorized members to your server.">
${/^[\w-]{20,100}$/.test(process.env.GOOGLE_SITE_VERIFICATION || "") ? `<meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION}">` : ""}
<link rel="icon" type="image/webp" href="/assets/icon.webp">
<link rel="apple-touch-icon" href="/assets/icon.webp">
<style>${CSS}</style></head><body>
<div class="bg"></div>
<header class="nav">
<div class="grp"><a class="tab login" href="/login">Login</a></div>
<div class="grp">${nav("/", "Home", "home")}${nav("/info", "Info", "info")}<a class="tab" href="${LINKS.docs}" target="_blank" rel="noopener">Documentation</a>
<a href="/" aria-label="AutoAuth home"><img class="logo" src="/assets/icon.webp" alt="AutoAuth"></a></div>
</header>
<div class="spacer" style="--gap:${gap}"></div>
<main class="panel"><div class="in">${body}</div></main>
<footer>
<div class="fcol"><h3>About AutoAuth</h3>
<p>AutoAuth is a Discord bot that lets members link their account once, so server admins can add them to a server without sending invites.</p>
<p>Your account is saved with encrypted tokens, and you can remove access any time in Discord under User Settings → Authorized Apps.</p>
<p style="font-size:13px;color:#9ca3af">AutoAuth is an independent project run by civwest. It is not affiliated with, endorsed by, or sponsored by Discord Inc.</p></div>
<div class="fcol"><h3>What it can do</h3>
<ul>
<li><code>/auth</code> Get a private link to connect your Discord account.</li>
<li><code>/optout</code> Opt out and delete your saved data.</li>
<li><code>/addusers</code> Admins: add every authorized member to the server.</li>
<li><code>/adduser</code> Admins: add one authorized member by user ID.</li>
</ul></div>
<div class="foot">
<h3>Follow the creator</h3>
<div class="icons">
<a href="${LINKS.tiktok}" target="_blank" rel="noopener" title="TikTok" aria-label="TikTok">${svg("tiktok", "TikTok")}</a>
<a href="${LINKS.youtube}" target="_blank" rel="noopener" title="YouTube" aria-label="YouTube">${svg("youtube", "YouTube")}</a>
<a href="${LINKS.x}" target="_blank" rel="noopener" title="X" aria-label="X">${svg("x", "X")}</a>
<a href="${LINKS.twitch}" target="_blank" rel="noopener" title="Twitch" aria-label="Twitch">${svg("twitch", "Twitch")}</a>
<a href="${LINKS.discord}" target="_blank" rel="noopener" title="Join the Discord" aria-label="Join the Discord">${svg("discord", "Join the Discord")}</a>
</div>
<div class="legal"><a href="/tos">Terms of Service</a><a href="/privacy-policy">Privacy Policy</a></div>
</div></footer></body></html>`;
}

const homeBody = (online) => `
<h1><span class="dot${online ? "" : " off"}"></span>${online ? "AutoAuth is now online" : "AutoAuth is starting up"}</h1>
<p class="lead">${online ? "The bot is connected to Discord and ready to go." : "The bot is connecting to Discord. Refresh in a moment."}</p>
<h2>How it works</h2>
<ol>
<li>A member runs <code>/auth</code> in Discord and approves the link.</li>
<li>Their account is saved securely, with encrypted tokens.</li>
<li>A server admin runs <code>/addusers</code> or <code>/adduser</code> to bring authorized members into that server.</li>
</ol>
<p>See the <a href="/info">Info</a> page for every command and what each one does.</p>`;

const infoBody = `
<h1>About AutoAuth</h1>
<p class="lead">AutoAuth is a Discord bot that lets members link their account once, so server admins can add them to new servers without sending invites.</p>
<h2>Commands</h2>
<table>
<tr><th>Command</th><th>Who</th><th>What it does</th></tr>
<tr><td><code>/auth</code></td><td>Anyone</td><td>Sends you a private link to authorize AutoAuth with your Discord account (scopes: identify, guilds.join).</td></tr>
<tr><td><code>/optout</code></td><td>Anyone authorized</td><td>Revokes your authorization and deletes your saved data and related log entries.</td></tr>
<tr><td><code>/addusers</code></td><td>Server administrators</td><td>Adds every authorized member who is not already in the server.</td></tr>
<tr><td><code>/adduser user_id</code></td><td>Server administrators</td><td>Adds one authorized member, by Discord user ID, to the server.</td></tr>
</table>
<h2>Your control</h2>
<p>You can remove AutoAuth's access at any time in Discord under <b>User Settings → Authorized Apps</b>. See the <a href="/privacy-policy">Privacy Policy</a> for what is stored and how to request deletion.</p>
<h2>Documentation</h2>
<p>Setup instructions and source code are on <a href="${LINKS.docs}" target="_blank" rel="noopener">GitHub</a>.</p>`;

const UPDATED = "October 11, 2026";

const privacyBody = `
<h1>Privacy Policy</h1>
<p class="updated">Last updated: ${UPDATED}</p>
<p>This policy explains what AutoAuth (“the bot”, “we”) collects, why, and the choices you have. AutoAuth is a Discord bot and website operated by civwest at ${SITE}.</p>

<h2>1. What we collect</h2>
<p>When you use <code>/auth</code> and approve the Discord authorization, we receive and store:</p>
<ul>
<li>Your Discord user ID and username (or display name).</li>
<li>An OAuth2 access token and refresh token for your account, limited to the <code>identify</code> and <code>guilds.join</code> scopes. Both tokens are stored encrypted (AES-256-GCM).</li>
<li>The token expiry time and the time you authorized.</li>
</ul>
<p>We do not receive your email address, password, messages, friends list, or the list of servers you are in.</p>
<p>When commands are used we also keep an audit log: the command used, the Discord user ID of the person who ran it, the server ID and name, and the outcome (for example, how many members were added). When an owner signs in to the private dashboard, we log the sign-in and IP address, and set a session cookie that is used only for that dashboard. Visitors to the public pages receive no cookies from us.</p>

<h2>2. How we use it</h2>
<ul>
<li>To add you to a Discord server when a server administrator runs <code>/addusers</code> or <code>/adduser</code> (this is the purpose of the <code>guilds.join</code> scope).</li>
<li>To refresh your authorization so it keeps working.</li>
<li>To keep the service secure and troubleshoot problems, using the audit log.</li>
</ul>
<p>We do not sell your data, use it for advertising, or share it with anyone other than the service providers below.</p>

<h2>3. Important: being added to servers</h2>
<p>By authorizing AutoAuth you agree that a server administrator who has the bot in their server may add you to that server. Authorizing is your consent for this. If you do not want that, do not authorize, or revoke access as described below.</p>

<h2>4. Where it is stored</h2>
<p>Data is stored in a PostgreSQL database and the bot runs on Render. Discord processes the authorization and any data you give Discord under its own <a href="https://discord.com/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>

<h2>5. Retention</h2>
<p>Authorization data is kept until you opt out with <code>/optout</code> or ask us to delete it. Audit log entries are kept for security and troubleshooting; those that contain your user ID are deleted when you opt out.</p>

<h2>6. Your choices</h2>
<ul>
<li><b>Revoke access:</b> in Discord, go to User Settings → Authorized Apps and remove AutoAuth. The stored tokens then stop working.</li>
<li><b>Opt out and delete your data:</b> run <code>/optout</code> in Discord. It revokes your authorization with Discord and deletes your stored record and the audit log entries that contain your user ID. You can also ask in our <a href="${LINKS.discord}" target="_blank" rel="noopener">Discord server</a>. Deleting your record does not remove you from servers you already joined; leave those from Discord.</li>
</ul>

<h2>7. Security</h2>
<p>Tokens are encrypted at rest, the dashboard is limited to the owners, and connections use HTTPS. No system is perfectly secure, so we cannot guarantee absolute security.</p>

<h2>8. Children</h2>
<p>AutoAuth is not intended for anyone under the minimum age to use Discord in their country (13 in most places). We do not knowingly collect data from them.</p>

<h2>9. Changes</h2>
<p>We may update this policy and will change the date above when we do.</p>

<h2>10. Contact</h2>
<p>Questions or requests: join the <a href="${LINKS.discord}" target="_blank" rel="noopener">Discord server</a>.</p>`;

const tosBody = `
<h1>Terms of Service</h1>
<p class="updated">Last updated: ${UPDATED}</p>
<p>By authorizing or using AutoAuth you agree to these terms.</p>
<h2>1. The service</h2>
<p>AutoAuth lets Discord members link their account so that server administrators can add them to a server. It is provided “as is”, without warranties, and may change or stop at any time.</p>
<h2>2. Your responsibilities</h2>
<ul>
<li>Follow the <a href="https://discord.com/terms" target="_blank" rel="noopener">Discord Terms of Service</a> and <a href="https://discord.com/guidelines" target="_blank" rel="noopener">Community Guidelines</a>.</li>
<li>Only authorize with your own account.</li>
<li>Administrators must only add members who have authorized, and must not use the bot to harass, spam, or add people against their wishes.</li>
</ul>
<h2>3. Consent to being added</h2>
<p>By running <code>/auth</code> and approving, you agree that administrators of servers with the bot may add you to their server. You can withdraw at any time by removing AutoAuth under User Settings → Authorized Apps.</p>
<h2>4. Misuse</h2>
<p>We may block users or servers, or remove stored data, at our discretion if the service is misused.</p>
<h2>5. Liability</h2>
<p>To the extent permitted by law, we are not liable for any damages arising from use of the service.</p>
<h2>6. Privacy</h2>
<p>How we handle data is described in the <a href="/privacy-policy">Privacy Policy</a>.</p>
<h2>7. Contact</h2>
<p>Questions: join the <a href="${LINKS.discord}" target="_blank" rel="noopener">Discord server</a>.</p>`;

module.exports = function mountSite(app, client) {
  const page = (title, body) => layout({ title: title + " | AutoAuth", gap: "20vh", body });
  // Images: serve local copy from ./public when present, otherwise fall back to the Discord CDN link.
  app.get("/assets/:file", (req, res) => {
    const f = req.params.file;
    if (!Object.hasOwn(IMAGES, f)) return res.status(404).end();
    const local = path.join(PUBLIC_DIR, f);
    if (fs.existsSync(local)) return res.type("image/webp").set("Cache-Control", "public, max-age=86400").sendFile(local);
    return res.redirect(302, IMAGES[f]);
  });
  // Google Search Console HTML-file verification: set GOOGLE_VERIFICATION_FILE=googleXXXXXXXX.html in Render.
  app.get(/^\/google[0-9a-f]{8,}\.html$/, (req, res) =>
    req.path.slice(1) === (process.env.GOOGLE_VERIFICATION_FILE || "google955a81d5fc1c3942.html")
      ? res.type("text/html").send("google-site-verification: " + req.path.slice(1))
      : res.status(404).end());
  app.get("/favicon.ico", (_, res) => res.redirect(301, "/assets/icon.webp"));

  app.get("/", (_, res) =>
    res.send(layout({ title: "AutoAuth", active: "home", body: homeBody(client.isReady()) })));
  app.get("/home", (_, res) => res.redirect(301, "/"));
  app.get("/info", (_, res) =>
    res.send(layout({ title: "Info | AutoAuth", active: "info", gap: "30vh", body: infoBody })));
  app.get("/tos", (_, res) =>
    res.send(layout({ title: "Terms of Service | AutoAuth", gap: "20vh", body: tosBody })));
  app.get("/privacy-policy", (_, res) =>
    res.send(layout({ title: "Privacy Policy | AutoAuth", gap: "20vh", body: privacyBody })));
  return { page };
};
