// Public website for AutoAuth: home, info, terms, privacy policy, plus the shared page layout.
// It does not touch any /dashboard or /login route.
const fs = require("node:fs");
const path = require("node:path");
const icons = require("./icons");
const embedded = require("./embedded-images");

const SITE = (() => { try { return new URL(process.env.REDIRECT_URI).origin; } catch { return "https://autoauth.cfd"; } })();
// Everything personal comes from Render environment variables (see README). Unset links are simply hidden.
const OPERATOR = process.env.SITE_OPERATOR || "the site owner";
const LINKS = {
  docs: process.env.LINK_DOCS || "",
  tiktok: process.env.LINK_TIKTOK || "",
  youtube: process.env.LINK_YOUTUBE || "",
  x: process.env.LINK_X || "",
  twitch: process.env.LINK_TWITCH || "",
  discord: process.env.LINK_DISCORD || "",
};
// Optional links in running text: shows a link only when the variable is set.
const ext = (url, label) => (url ? `<a href="${url}" data-ext target="_blank" rel="noopener">${label}</a>` : label);

// Images are served from ./public (bg.webp = background, icon.webp = site icon / favicon).
const IMAGES = { "bg.webp": true, "icon.webp": true };
const PUBLIC_DIR = path.join(__dirname, "public");

const svg = (name, label) =>
  `<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" role="img" aria-label="${label}"><path d="${icons[name]}"/></svg>`;

const CSS = `
*{box-sizing:border-box}html{scroll-behavior:smooth;scrollbar-gutter:stable}
html.lock,html:has(dialog[open]){overflow:hidden}
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
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:22px 0}
.stat{border:1px solid #e5e5e5;border-radius:14px;padding:16px 18px}.stat b{display:block;font-size:30px;line-height:1.2}.stat span{color:#666;font-size:14px}
details{border-bottom:1px solid #e5e5e5;padding:12px 0}summary{cursor:pointer;font-weight:600}details p{margin:8px 0 0}
.authgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:24px 0}
.authopt{font:inherit;text-align:left;cursor:pointer;background:#fff;border:1px solid #d4d4d8;border-radius:16px;padding:20px;transition:box-shadow .15s,transform .15s,border-color .15s}
.authopt:hover{box-shadow:0 8px 24px rgba(0,0,0,.12);transform:translateY(-2px);border-color:#000}
.authopt b{display:block;font-size:18px;margin-bottom:6px;color:#111}.authopt span{color:#555;font-size:14px;line-height:1.45;display:block}
.notice{border-radius:10px;padding:12px 14px;margin:0 0 16px;background:#fffbeb;color:#92400e;border:1px solid #fde68a}.banner{border-radius:10px;padding:12px 14px;margin:16px 0;background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
dialog.dlg{border:0;border-radius:18px;padding:26px;width:min(560px,92vw);max-height:88vh;overflow:auto;color:#1a1a1a;box-shadow:0 30px 80px rgba(0,0,0,.45)}
dialog.dlg::backdrop{background:rgba(0,0,0,.6)}
dialog.dlg h2{margin:0 0 8px;font-size:22px}
.btns{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}
.btn{font:inherit;font-weight:650;border:0;border-radius:10px;padding:11px 20px;cursor:pointer;color:#fff}
.btn.green{background:#16a34a}.btn.green:hover{background:#15803d}.btn.blue{background:#2563eb}.btn.blue:hover{background:#1d4ed8}.btn.gray{background:#e5e7eb;color:#111}.btn:disabled{opacity:.5;cursor:not-allowed}
.agree-list{margin:10px 0 14px;padding-left:20px}.agree-list li{margin:6px 0}
.chk{display:flex;gap:10px;align-items:flex-start;margin:14px 0;font-size:14px}.chk input{margin-top:4px;width:18px;height:18px}
.linkbtn{background:none;border:0;color:#2563eb;cursor:pointer;font:inherit;text-decoration:underline;padding:0}
footer{background:#000;color:#fff;padding:64px 28px 48px;min-height:260px;display:grid;grid-template-columns:1fr 1fr auto;gap:48px;align-items:start}
.fcol h3{margin:0 0 14px;font-size:20px;font-weight:700;color:#fff}.fcol p,.fcol li{color:#d1d5db;font-size:15px;line-height:1.7;margin:0 0 10px}.fcol ul{margin:0;padding:0;list-style:none}.fcol code{background:#1f2937;color:#fff;padding:2px 6px;border-radius:5px;font-size:.92em}
.foot{text-align:right}
.foot h3{margin:0 0 16px;font-size:20px;font-weight:700;color:#fff}
.icons{display:flex;justify-content:flex-end;gap:20px;margin-bottom:26px}
.icons a{color:#fff;display:inline-flex;transition:opacity .15s,transform .15s}
.icons a:hover{opacity:.7;transform:translateY(-2px)}
.legal a{display:block;color:#9ca3af;text-decoration:underline;font-size:14px;line-height:1.9}
.legal a:hover{color:#d1d5db}
@media(max-width:860px){footer{grid-template-columns:1fr;gap:36px}.foot{text-align:left}.icons{justify-content:flex-start}.authgrid{grid-template-columns:1fr}}
@media(max-width:600px){
body{font-size:15.5px}.nav{padding:0 8px;gap:2px}.nav .grp{gap:2px}.nav a.tab{padding:8px 8px;font-size:14px}.nav a.tab.login{padding:8px 12px}.nav .logo{width:30px;height:30px;margin-left:4px}
.spacer{height:min(var(--gap,72vh),46vh)}.panel{padding:36px 18px 56px;border-radius:18px 18px 0 0}h2{font-size:20px;margin-top:28px}.lead{font-size:17px}
code{word-break:break-word}.cta{display:block;text-align:center}.stats{grid-template-columns:repeat(3,1fr);gap:8px}.stat{padding:12px}.stat b{font-size:22px}
table,tbody,tr,td{display:block;width:100%}tr:first-child:has(th){display:none}tr{border:1px solid #e5e5e5;border-radius:12px;padding:6px 4px;margin:10px 0}td{border:0;padding:6px 10px}td[data-l]::before{content:attr(data-l);display:block;font-size:12px;font-weight:700;color:#777;text-transform:uppercase;letter-spacing:.4px}
dialog.dlg{padding:20px 18px}.btns .btn{flex:1}footer{padding:44px 18px 32px}}
`;

// Shared client script: scroll lock while any popup is open, and the "leaving the site" popup.
const CLIENT_JS = `
function openDlg(id){var d=document.getElementById(id);if(!d)return;document.documentElement.classList.add('lock');d.showModal();}
function closeDlg(id){var d=document.getElementById(id);if(d)d.close();}
document.addEventListener('close',function(){if(!document.querySelector('dialog[open]'))document.documentElement.classList.remove('lock');},true);
var extUrl='';
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-ext]');if(!a)return;e.preventDefault();extUrl=a.href;openDlg('leave');});
function goExternal(){window.open(extUrl,'_blank','noopener,noreferrer');closeDlg('leave');}
`;

let probe = () => ({ offline: false });
const SUPPORT_EMAIL = (() => { const e = String(process.env.SUPPORT_EMAIL || "").trim(); if (/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e)) return e; try { return "support@" + new URL(process.env.REDIRECT_URI).hostname.replace(/^www\./, ""); } catch { return ""; } })();
const UNDER_CONSTRUCTION = "The controls for some project permissions";
function notices(active) {
  let out = "";
  if (probe().offline) out += `<div class="banner" role="status" style="margin-top:0"><b>Offline.</b> The bot is not running right now.</div>`;
  if (active === "home") out += `<div class="notice"><b>Under construction:</b> ${UNDER_CONSTRUCTION} are not built yet.</div>`;
  return out;
}

function layout({ title, active, gap = "72vh", body }) {
  const nav = (href, label, key) =>
    `<a class="tab${active === key ? " on" : ""}" href="${href}">${label}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="AutoAuth is a Discord authorization bot. Members approve it once through Discord, and with their permission it can add them to servers that run the bot and let the owners send direct messages. Everything can be withdrawn at any time.">
${/^[\w-]{20,100}$/.test(process.env.GOOGLE_SITE_VERIFICATION || "") ? `<meta name="google-site-verification" content="${process.env.GOOGLE_SITE_VERIFICATION}">` : ""}
<link rel="icon" type="image/webp" href="/assets/icon.webp">
<link rel="apple-touch-icon" href="/assets/icon.webp">
<style>${CSS}</style></head><body>
<div class="bg"></div>
<header class="nav">
<div class="grp"><a class="tab login" href="/login">Login</a></div>
<div class="grp">${nav("/", "Home", "home")}${nav("/info", "Info", "info")}${nav("/auth", "Authorization", "auth")}${LINKS.docs ? `<a class="tab" href="${LINKS.docs}" data-ext target="_blank" rel="noopener">Documentation</a>` : ""}
<a href="/" aria-label="AutoAuth home"><img class="logo" src="/assets/icon.webp" alt="AutoAuth"></a></div>
</header>
<div class="spacer" style="--gap:${gap}"></div>
<main class="panel"><div class="in">${notices(active)}${body}</div></main>
<dialog class="dlg" id="leave"><h2>You're leaving the site</h2>
<p>This link leads to an external website. Are you sure you want to open it?</p>
<div class="btns"><button type="button" class="btn green" onclick="goExternal()">Yes, do it!</button><button type="button" class="btn blue" onclick="closeDlg('leave')">No, I want to stay.</button></div></dialog>
<footer>
<div class="fcol"><h3>About AutoAuth</h3>
<p>AutoAuth is a Discord authorization bot and website. Members approve it once through Discord's OAuth2 sign-in, choosing server joins, direct messages or both. With that approval, server administrators and the owners can add them to servers that run the bot, and the owners can message them through the bot.</p>
<p>We store your Discord ID, username and encrypted tokens for only what you approved. Nothing happens without your approval, and you can opt out any time on the <a href="/optout">opt-out page</a> or with <code>/optout</code> in Discord. <a href="/info" style="text-decoration:underline">Read the full details</a>.</p>
<p style="font-size:13px;color:#9ca3af">AutoAuth is an independent project run by ${OPERATOR}. It is not affiliated with, endorsed by, or sponsored by Discord Inc.</p></div>
<div class="fcol"><h3>What it can do</h3>
<ul>
<li><code>/auth</code> Open the authorization page.</li>
<li><code>/optout</code> Opt out of servers, DMs or everything, and delete your data.</li>
<li><code>/addusers</code> Admins: add every authorized member to the server.</li>
<li><code>/adduser</code> Admins: add one authorized member by user ID.</li>
</ul></div>
<div class="foot">
<h3>Follow the creator</h3>
<div class="icons">
${LINKS.tiktok ? `<a href="${LINKS.tiktok}" target="_blank" rel="noopener" title="TikTok" aria-label="TikTok">${svg("tiktok", "TikTok")}</a>` : ""}
${LINKS.youtube ? `<a href="${LINKS.youtube}" target="_blank" rel="noopener" title="YouTube" aria-label="YouTube">${svg("youtube", "YouTube")}</a>` : ""}
${LINKS.x ? `<a href="${LINKS.x}" target="_blank" rel="noopener" title="X" aria-label="X">${svg("x", "X")}</a>` : ""}
${LINKS.twitch ? `<a href="${LINKS.twitch}" target="_blank" rel="noopener" title="Twitch" aria-label="Twitch">${svg("twitch", "Twitch")}</a>` : ""}
${LINKS.discord ? `<a href="${LINKS.discord}" target="_blank" rel="noopener" title="Join the Discord" aria-label="Join the Discord">${svg("discord", "Join the Discord")}</a>` : ""}
</div>
${SUPPORT_EMAIL ? `<p style="margin:14px 0 0"><a href="mailto:${SUPPORT_EMAIL}" style="color:#fff;text-decoration:underline">${SUPPORT_EMAIL}</a></p>` : ""}
<div class="legal"><a href="/terms-of-service">Terms of Service</a><a href="/privacy-policy">Privacy Policy</a></div>
</div></footer><script>${CLIENT_JS}</script></body></html>`;
}

const homeBody = (online, stats, paused) => `
<h1><span class="dot${online ? "" : " off"}"></span>${online ? "AutoAuth is online" : paused ? "The Discord connection was temporarily severed by the owners" : "AutoAuth is starting up"}</h1>
<p class="lead">${online ? "The bot is connected to Discord and ready to go." : "The bot is connecting to Discord. Refresh in a moment."}</p>
<h2>What AutoAuth is</h2>
<p>AutoAuth is a Discord bot and website that works on explicit, per-person consent. You sign in with Discord's own OAuth2 screen, which lists the exact permissions requested, and Discord hands this site a token for only those permissions. AutoAuth stores your Discord user ID, username and the encrypted tokens, and nothing happens until you approve.</p>
<p>You decide which of two permissions to give. <b>Server joins</b> lets server administrators and the owners add you to a server that runs the bot, with the <code>/addusers</code> and <code>/adduser</code> commands or the owners' dashboard, so nobody has to send you an invite link. <b>Direct messages</b> installs the bot to your Discord account and lets the owners message you through the bot, and lets you reply to it. You can give either or both.</p>
<p>AutoAuth does not read your messages, friends or email and never sees your Discord password. It is not a login for other websites and it does not post on your behalf. You can switch off server joins, direct messages, or everything at any time on the <a href="/optout">opt-out page</a> or with <code>/optout</code>; opting out of everything revokes the token with Discord and deletes your record.</p>
${stats ? `<div class="stats"><div class="stat"><b>${Number(stats.servers) || 0}</b><span>Servers</span></div><div class="stat"><b>${Number(stats.members) || 0}</b><span>Linked members</span></div><div class="stat"><b>${online ? "Online" : "Offline"}</b><span>Bot status</span></div></div>` : ""}
<p><a class="cta" href="/auth">Authorize your account</a></p>
<h2>How it works</h2>
<ol>
<li>Open the <a href="/auth">Authorization</a> page and choose what you allow: server joins, direct messages, or both.</li>
<li>Read and agree to the Terms of Service and Privacy Policy, then approve on Discord.</li>
<li>A server admin can then add you with <code>/addusers</code> or <code>/adduser</code>, and the owners can message you if you allowed DMs.</li>
<li>Change your mind any time on the <a href="/optout">opt-out page</a> or with <code>/optout</code>.</li>
</ol>
<p>See the <a href="/info">Info</a> page for every command, and the questions people ask most.</p>`;

const infoBody = `
<h1>About AutoAuth</h1>
<p class="lead">AutoAuth is a Discord authorization bot. A member approves it once through Discord's own OAuth2 sign-in, and AutoAuth then keeps the tokens Discord issues so it can act on only what that member approved: being added to servers that run the bot, and, if allowed, receiving direct messages from the bot's owners.</p>
<h2>How it works in detail</h2>
<p>When you press an option on the <a href="/auth">Authorization</a> page you are sent to discord.com, where Discord shows exactly which permissions are requested. After you approve, Discord returns a one-time code to this site, which exchanges it for an access token and a refresh token. AutoAuth stores your Discord user ID, your username and those two tokens, encrypted at rest (AES-256-GCM), together with which permissions you allowed and when. Your Discord password never reaches this site.</p>
<p>A server administrator who runs the bot in their server can then use <code>/addusers</code> or <code>/adduser</code>. AutoAuth uses each member's stored token to ask Discord's API to add that member to the server (Discord's &ldquo;add guild member&rdquo; request, which needs the <code>guilds.join</code> permission). Tokens are refreshed automatically when they near expiry. If Discord reports that a token was revoked, the authorization is marked inactive.</p>
<h2>What each choice means</h2>
<table>
<tr><th>Choice</th><th>Discord permissions</th><th>What it lets AutoAuth do</th></tr>
<tr><td data-l="Choice">Server joins</td><td data-l="Discord permissions"><code>identify</code>, <code>guilds.join</code>, <code>guilds</code></td><td data-l="What it lets AutoAuth do">Add you to servers where the bot is installed when an administrator or the owners run the add commands, and let the owners remove you from servers they added you to.</td></tr>
<tr><td data-l="Choice">Direct messages</td><td data-l="Discord permissions"><code>identify</code>, <code>guilds</code>, <code>applications.commands</code></td><td data-l="What it lets AutoAuth do">Installs the bot to your Discord account so its commands work anywhere, and lets the owners send you direct messages (with attachments) through the bot. Replies you send to the bot are shown to the owners.</td></tr>
<tr><td data-l="Choice">Both</td><td data-l="Discord permissions">All of the above</td><td data-l="What it lets AutoAuth do">Everything in both rows.</td></tr>
</table>
<p>The <code>guilds</code> permission lets Discord share which servers you are in during sign-in; AutoAuth does not store that list. AutoAuth never reads your messages, your friends list or your email address.</p>
<h2>What the owners and administrators can and cannot do</h2>
<ul>
<li>They can add you to servers, remove you from servers the bot can manage, send you direct messages if you allowed them, set an expiry on your authorization, and opt you out.</li>
<li>They cannot see your Discord password or read your other messages. Tokens are never shown in the dashboard.</li>
<li>Only people who have authorized AutoAuth appear in the owners' dashboard. Direct messages from anyone else are ignored.</li>
</ul>
<h2>Commands</h2>
<table>
<tr><th>Command</th><th>Who</th><th>What it does</th></tr>
<tr><td data-l="Command"><code>/auth</code></td><td data-l="Who">Anyone</td><td data-l="What it does">Sends you a link to the <a href="/auth">Authorization page</a>, where you choose server joins, DMs or both.</td></tr>
<tr><td data-l="Command"><code>/optout</code></td><td data-l="Who">Anyone authorized</td><td data-l="What it does">Opt out of server joins, DMs, or everything. Opting out of everything revokes your authorization and deletes your saved data and related log entries.</td></tr>
<tr><td data-l="Command"><code>/addusers</code></td><td data-l="Who">Server administrators</td><td data-l="What it does">Adds every member who allowed server joins and is not already in the server.</td></tr>
<tr><td data-l="Command"><code>/adduser user_id</code></td><td data-l="Who">Server administrators</td><td data-l="What it does">Adds one member who allowed server joins, by Discord user ID.</td></tr>
</table>
<h2>Frequently asked questions</h2>
<details><summary>What am I allowing when I authorize?</summary><p>You choose. <b>Server joins</b> lets admins add you to servers with AutoAuth. <b>Direct messages</b> lets the owners DM you through the bot. <b>Both</b> allows each. Details are shown before you continue.</p></details>
<details><summary>Do you see my password, email or messages?</summary><p>No. Sign-in happens on discord.com. We receive your username, your ID, and tokens for the permissions you approve (stored encrypted). Discord also tells us which servers you are in during sign-in, but we do not keep that list.</p></details>
<details><summary>How do I stop?</summary><p>Use the <a href="/optout">opt-out page</a>, or run <code>/optout</code> in Discord and pick servers, DMs or everything. You can also remove AutoAuth under User Settings → Authorized Apps.</p></details>
<details><summary>Does my authorization expire?</summary><p>By default it stays active until you opt out. The owners can set an expiry for an authorization, after which it can no longer be used.</p></details>
<details><summary>Can I be removed from a server?</summary><p>Yes. The owners can remove members they added, using the bot, and server administrators have their own tools.</p></details>
<details><summary>Why did a DM not arrive?</summary><p>Discord can refuse a bot's message, for example if you have blocked the bot or Discord limits it. If you allowed direct messages and still receive nothing, check your Discord privacy settings.</p></details>
<h2>Documentation</h2>
<p>Setup instructions and source code are on ${ext(LINKS.docs, "GitHub")}.</p>`;

const UPDATED = "October 14, 2026";

const privacyBody = `
<h1>Privacy Policy</h1>
<p class="updated">Last updated: ${UPDATED}</p>
<p>This policy explains what AutoAuth (“the bot”, “we”) collects, why, and the choices you have. AutoAuth is a Discord bot and website operated by ${OPERATOR} at ${SITE}.</p>

<h2>1. What we collect</h2>
<p>When you complete the <a href="/auth">Authorization</a> flow and approve the Discord screen, we receive and store:</p>
<ul>
<li>Your Discord user ID and username (or display name).</li>
<li>An OAuth2 access token and refresh token for your account. The scopes depend on your choice: <code>identify</code>, <code>guilds.join</code> and <code>guilds</code> for server joins, and <code>applications.commands</code>, <code>identify</code> and <code>guilds</code> for direct messages (this installs AutoAuth to your Discord account). Both tokens are stored encrypted (AES-256-GCM).</li>
<li>Which permissions you allowed (server joins, direct messages, or both), when you authorized, and any expiry the owners set on your authorization.</li>
</ul>
<p>We do not receive your email address, password, your messages or your friends list. The <code>guilds</code> scope lets Discord share which servers you are in during authorization; AutoAuth does not store that list.</p>
<p><b>Rate limiting:</b> your IP address may be held in server memory for a few minutes to limit repeated attempts. It is not stored in the database.</p>
<p><b>Logs:</b> we keep an audit log of events such as commands used, authorizations and opt-outs, adds and removals from servers, and direct messages sent. Entries can include the relevant Discord user IDs, server IDs and names, and outcomes. For direct messages the audit log records the recipient, the message length, and the number of attachments, but not the message text or the files. When an owner signs in to the private dashboard, we log the sign-in and IP address and set a session cookie used only for that dashboard. Visitors to the public pages receive no cookies from us.</p>

<h2>2. How we use it</h2>
<ul>
<li>To add you to a Discord server when a server administrator or the owners run <code>/addusers</code>, <code>/adduser</code> or the equivalent dashboard action (this is the purpose of the <code>guilds.join</code> scope).</li>
<li>To let the owners send you direct messages, including attachments, if you allowed DMs.</li>
<li>To remove you from a server when the owners choose to do so.</li>
<li>To refresh your authorization so it keeps working, and to keep the service secure and troubleshoot problems.</li>
</ul>
<p>We do not sell your data, use it for advertising, or share it with anyone other than the service providers below.</p>

<h2>3. Important: server joins, removals and messages</h2>
<p>If you allow server joins, you agree that a server administrator who has the bot in their server, and the owners, may add you to that server, and that the owners may later remove you from it. If you allow direct messages, you agree that the owners may message you through the bot. Your approval on the Authorization page is your consent. If you do not want this, do not authorize, or opt out as described below.</p>

<h2>4. Where it is stored</h2>
<p>Data is stored in a PostgreSQL database and the bot runs on Render. Discord processes the authorization, and any message we send, under its own <a href="https://discord.com/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>

<p><b>Direct messages with the bot:</b> if you have authorized AutoAuth and you message the bot in a Discord DM, or the owners message you, the conversation is stored so the owners can read and reply to it in the dashboard. We keep your Discord username, ID and avatar link, the message text, and the names and links of any attachments. Messages from people who have not authorized AutoAuth are not stored or shown. These messages are deleted automatically after the retention period (30 days by default), when an owner deletes the conversation, or when you opt out of everything.</p>
<h2>5. Retention and expiry</h2>
<p>By default an authorization stays active until you opt out. The owners can set an expiry date on an authorization; once it passes, the authorization is no longer used for adds, and it can be extended or deleted. Audit log entries are kept for security and troubleshooting, and those that contain your user ID are deleted when you opt out of everything.</p>

<h2>6. Your choices</h2>
<ul>
<li><b>Opt out:</b> use the <a href="/optout">opt-out page</a> or run <code>/optout</code> in Discord and choose <b>server joins</b>, <b>direct messages</b>, or <b>everything</b>. Opting out of one keeps your record only for the other. Opting out of everything revokes your authorization with Discord and deletes your stored record and the audit log entries that contain your user ID.</li>
<li><b>Revoke access:</b> in Discord, go to User Settings → Authorized Apps and remove AutoAuth. The stored tokens then stop working.</li>
<li><b>Ask us:</b> you can also ask in our ${ext(LINKS.discord, "Discord server")}. Deleting your record does not remove you from servers you already joined; leave those from Discord.</li>
</ul>

<h2>7. Security</h2>
<p>Tokens are encrypted at rest, the dashboard is limited to the owners, and connections use HTTPS. No system is perfectly secure, so we cannot guarantee absolute security.</p>

<h2>8. Children</h2>
<p>AutoAuth is not intended for anyone under the minimum age to use Discord in their country (13 in most places). We do not knowingly collect data from them.</p>

<h2>9. Changes</h2>
<p>We may update this policy and will change the date above when we do.</p>

<h2>10. Contact</h2>
<p>Questions or requests: join the ${ext(LINKS.discord, "Discord server")}${SUPPORT_EMAIL ? ` or email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>` : ""}.</p>`;

const tosBody = `
<h1>Terms of Service</h1>
<p class="updated">Last updated: ${UPDATED}</p>
<p>By authorizing or using AutoAuth you agree to these terms.</p>
<h2>1. The service</h2>
<p>AutoAuth lets Discord members link their account so that server administrators and the owners can add them to a server, and so that the owners can send them direct messages if they allow it. It is provided “as is”, without warranties, and may change or stop at any time.</p>
<h2>2. Your responsibilities</h2>
<ul>
<li>Follow the <a href="https://discord.com/terms" target="_blank" rel="noopener">Discord Terms of Service</a> and <a href="https://discord.com/guidelines" target="_blank" rel="noopener">Community Guidelines</a>.</li>
<li>Only authorize with your own account.</li>
<li>Administrators must only add members who have authorized, and must not use the bot to harass, spam, or add people against their wishes.</li>
</ul>
<h2>3. Consent</h2>
<p>When you complete the Authorization page you choose server joins, direct messages, or both. Server joins means administrators of servers with the bot, and the owners, may add you to their server and the owners may remove you from it. Direct messages means the owners may message you through the bot. You can withdraw at any time with <code>/optout</code> or by removing AutoAuth under User Settings → Authorized Apps.</p>
<h2>4. Expiry</h2>
<p>An authorization stays active until you opt out unless the owners set an expiry on it. Expired authorizations cannot be used.</p>
<h2>5. Misuse</h2>
<p>We may block users or servers, remove members from servers we manage, or delete stored data at our discretion if the service is misused.</p>
<h2>6. Liability</h2>
<p>To the extent permitted by law, we are not liable for any damages arising from use of the service.</p>
<h2>7. Privacy</h2>
<p>How we handle data is described in the <a href="/privacy-policy">Privacy Policy</a>.</p>
<h2>8. Changes</h2>
<p>We may update these terms and will change the date above when we do.</p>
<h2>9. Contact</h2>
<p>Questions: join the ${ext(LINKS.discord, "Discord server")}${SUPPORT_EMAIL ? ` or email <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>` : ""}.</p>`;

module.exports = function mountSite(app, client, getStats, getState) {
  probe = () => ({ offline: !client.isReady() });
  const page = (title, body, active) => layout({ title: title + " | AutoAuth", active, gap: "20vh", body });

  // Images are served from ./public.
  app.get("/assets/:file", (req, res) => {
    const f = req.params.file;
    if (!Object.hasOwn(IMAGES, f)) return res.status(404).end();
    const local = path.join(PUBLIC_DIR, f);
    res.type("image/webp").set("Cache-Control", "public, max-age=86400");
    if (fs.existsSync(local)) return res.send(fs.readFileSync(local)); // your own file in ./public wins
    return res.send(Buffer.from(embedded[f], "base64")); // built-in copy, so the site never loses its images
  });
  // Google Search Console HTML-file verification (only active when GOOGLE_VERIFICATION_FILE is set).
  app.get(/^\/google[0-9a-f]{8,}\.html$/, (req, res) =>
    process.env.GOOGLE_VERIFICATION_FILE && req.path.slice(1) === process.env.GOOGLE_VERIFICATION_FILE
      ? res.type("text/html").send("google-site-verification: " + req.path.slice(1))
      : res.status(404).end());
  app.get("/favicon.ico", (_, res) => res.redirect(301, "/assets/icon.webp"));

  app.get("/", async (_, res) => {
    let stats = null;
    try { stats = getStats ? await getStats() : null; } catch { stats = null; }
    res.send(layout({ title: "AutoAuth", active: "home", body: homeBody(client.isReady(), stats, !!(getState && getState().paused)) }));
  });
  app.get("/home", (_, res) => res.redirect(301, "/"));
  app.get("/info", (_, res) =>
    res.send(layout({ title: "Info | AutoAuth", active: "info", gap: "30vh", body: infoBody })));
  app.get("/terms-of-service", (_, res) =>
    res.send(layout({ title: "Terms of Service | AutoAuth", gap: "20vh", body: tosBody })));
  app.get("/tos", (_, res) => res.redirect(301, "/terms-of-service"));
  app.get("/privacy-policy", (_, res) =>
    res.send(layout({ title: "Privacy Policy | AutoAuth", gap: "20vh", body: privacyBody })));
  return { page, LINKS };
};
