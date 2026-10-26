// Side projects: small Discord-bot web endpoints kept in the database (no environment variables).
// Each project lives under /projects/<slug>/... and has one type (below).
const crypto = require("node:crypto");

const TYPES = {
  oauth: { label: "OAuth2 callback", path: "/oauth/callback",
    fields: [["client_id", "Client ID"], ["client_secret", "Client secret", "secret"], ["message", "Success message"], ["redirect", "Redirect after success (https, optional)"], ["scopes", "Permissions to ask for", "scopes"], ["bot_token", "Bot token (only to add users to servers)", "secret_opt"], ["store", "Store users and tokens", "bool"], ["storage", "Where to store them", "storage"]] },
  interactions: { label: "Interactions endpoint", path: "/interactions",
    fields: [["public_key", "Public key"], ["reply", "Reply to commands"]] },
  webhook: { label: "Webhook events", path: "/webhook", fields: [["public_key", "Public key"]] },
  terms: { label: "Terms of Service", path: "/terms", fields: [["title", "Title"], ["body", "Text", "area"]] },
  privacy: { label: "Privacy Policy", path: "/privacy", fields: [["title", "Title"], ["body", "Text", "area"]] },
  invite: { label: "Invite redirect", path: "/invite", fields: [["client_id", "Client ID"], ["permissions", "Bot permissions number"], ["scopes", "Permissions to ask for", "scopes"]] },
};

// Every Discord OAuth2 scope: [key, what it gives, how to set it up, needs Discord approval].
// Scopes that need Discord's own approval are not offered (see REMOVED and the "Permissions missing?" panel).
const ALL_SCOPES = [
  ["identify", "Username, avatar and user ID", "Nothing extra to set up. Always select this one so you know who authorized.", 0],
  ["email", "The user's email address", "Fetch it with GET /users/@me using the stored access token (turn on Store users and tokens).", 0],
  ["connections", "Linked accounts (Steam, YouTube, Twitch and more)", "Fetch with GET /users/@me/connections using the stored access token.", 0],
  ["guilds", "List of servers the user is in", "Fetch with GET /users/@me/guilds using the stored access token.", 0],
  ["guilds.join", "Add the user to a server", "Your bot must be in the target server with Create Instant Invite. Call PUT /guilds/{guild}/members/{user} with the bot token and the stored access token. Turn on Store users and tokens.", 0],
  ["guilds.members.read", "The user's member info in a server", "Fetch with GET /users/@me/guilds/{guild}/member using the stored access token.", 0],
  ["bot", "Add your bot to a server", "Choose permissions in the Invite project type, or add the permissions number to your link. The server owner must approve.", 0],
  ["applications.commands", "Slash commands in servers or as a user install", "For user installs, turn on User Install under Installation in the Developer Portal and add integration_type=1 to the link.", 0],
  ["applications.commands.update", "Update your own slash commands with a client credentials token", "Request a token with the client_credentials grant, not a user login.", 0],
  ["applications.commands.permissions.update", "Change command permissions in a server", "The server's admin must authorize it. Use the returned token with the command permissions endpoints.", 0],
  ["webhook.incoming", "Create a webhook in a channel the user picks", "Discord returns the webhook in the token response when the user picks a channel.", 0],
  ["role_connections.write", "Update the user's Linked Roles data", "Set Linked Roles Verification URL in the Developer Portal and register your metadata with PUT /applications/{id}/role-connections/metadata.", 0],
  ["openid", "OpenID Connect sign-in", "Use together with identify. The token response includes an id_token.", 0],
  ["applications.entitlements", "Read the user's entitlements for your app", "Needs a monetized app. Fetch with the entitlements endpoints.", 0],
  ["gdm.join", "Join the user to a group DM", "Discord approval required.", 1],
  ["messages.read", "Read messages from the local Discord client", "Discord approval required. Used by apps running on the user's computer.", 1],
  ["dm_channels.read", "Read the user's DM channels", "Discord approval required.", 1],
  ["relationships.read", "Read the user's friends list", "Discord approval required.", 1],
  ["relationships.write", "Send friend requests for the user", "Discord approval required.", 1],
  ["presences.read", "Read the user's friends' presences", "Discord approval required.", 1],
  ["presences.write", "Update the user's presence", "Discord approval required.", 1],
  ["activities.read", "Read the user's activity", "Discord approval required.", 1],
  ["activities.write", "Update the user's activity", "Discord approval required.", 1],
  ["activities.invites.write", "Send activity invites", "Discord approval required.", 1],
  ["voice", "Connect to the user's voice", "Discord approval required.", 1],
  ["lobbies.write", "Create and manage lobbies", "Discord approval required. Part of the Social SDK.", 1],
  ["sdk.social_layer", "Social SDK features", "Discord approval required.", 1],
  ["sdk.social_layer_presence", "Social SDK presence", "Discord approval required.", 1],
  ["rpc", "Control the local Discord client over RPC", "Discord approval required.", 1],
  ["rpc.notifications.read", "Read client notifications over RPC", "Discord approval required.", 1],
  ["rpc.voice.read", "Read voice settings over RPC", "Discord approval required.", 1],
  ["rpc.voice.write", "Change voice settings over RPC", "Discord approval required.", 1],
  ["rpc.video.read", "Read video settings over RPC", "Discord approval required.", 1],
  ["rpc.video.write", "Change video settings over RPC", "Discord approval required.", 1],
  ["rpc.screenshare.read", "Read screenshare settings over RPC", "Discord approval required.", 1],
  ["rpc.screenshare.write", "Change screenshare settings over RPC", "Discord approval required.", 1],
  ["rpc.activities.write", "Update activities over RPC", "Discord approval required.", 1],
  ["applications.builds.read", "Read your application's builds", "Discord approval required.", 1],
  ["applications.builds.upload", "Upload builds for your application", "Discord approval required.", 1],
  ["applications.store.update", "Update your application's store listing", "Discord approval required.", 1],
];
const SCOPES = ALL_SCOPES.filter((s) => !s[3]);
const REMOVED = ALL_SCOPES.filter((s) => s[3]).map((s) => [s[0], s[1]]);
const SCOPE_KEYS = new Set(SCOPES.map((s) => s[0]));
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ED25519_DER = Buffer.from("302a300506032b6570032100", "hex");

module.exports = function createProjects({ pool, enc, dec, log, express, collect, dataScopes, limits }) {
  const origin = () => { try { return new URL(process.env.REDIRECT_URI).origin; } catch { return ""; } };
  const urlOf = (p) => `${origin()}/projects/${p.slug}${TYPES[p.type].path}`;
  const hits = new Map();
  const limited = (k, max) => { const n = Date.now(), h = hits.get(k); if (!h || h.until < n) { hits.set(k, { n: 1, until: n + 60000 }); return false; } return ++h.n > max; };
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.until < n) hits.delete(k); }, 60000).unref();
  const get = async (slug, type) => { const r = await pool.query("SELECT slug,name,type,config,owner_account,locked FROM side_projects WHERE slug=$1 AND type=$2", [String(slug), type]); const p = r.rows[0]; return p && !p.locked ? p : null; };
  const keyOf = (req) => (req.params.user ? `${req.params.user}/${req.params.slug}` : String(req.params.slug));
  // Projects owned by a signed-up account log to their own table so site admins never see that data.
  const plog = (p, type, detail) => p && p.owner_account ? pool.query("INSERT INTO project_logs(slug,event_type,detail) VALUES($1,$2,$3)", [p.slug, type, JSON.stringify(detail)]).catch(() => {}) : log(type, detail);
  const html = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- public endpoints ----------
  function verifySig(req, hex) {
    try {
      const sig = Buffer.from(String(req.get("x-signature-ed25519") || ""), "hex"), ts = String(req.get("x-signature-timestamp") || "");
      if (sig.length !== 64 || !ts || !Buffer.isBuffer(req.body)) return false;
      if (!/^\d{9,12}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // reject old (replayed) requests
      const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_DER, Buffer.from(hex, "hex")]), format: "der", type: "spki" });
      return crypto.verify(null, Buffer.concat([Buffer.from(ts), req.body]), key, sig);
    } catch { return false; }
  }

  function mountPublic({ app, site }) {
    const page = (res, status, title, body) => res.status(status).set("Cache-Control", "no-store").send(site.page(title, body, ""));

    app.get(["/projects/:slug/oauth/callback", "/projects/:user/:slug/oauth/callback"], async (req, res) => {
      res.set({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
      const p = await get(keyOf(req), "oauth").catch(() => null);
      if (!p) return res.status(404).send("Not found");
      if (limited("o:" + req.ip, 30)) return res.status(429).send("Too many requests.");
      if (req.query.error) return page(res, 400, "Authorization cancelled", "<h1>Authorization cancelled</h1>");
      if (typeof req.query.code !== "string" || !req.query.code) return page(res, 400, "Authorization failed", "<h1>Authorization failed</h1><p>No code was returned.</p>");
      const c = p.config || {};
      try {
        const r = await fetch("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: c.client_id, client_secret: dec(c.client_secret_enc), grant_type: "authorization_code", code: req.query.code, redirect_uri: urlOf(p) }) });
        const t = await r.json();
        if (!r.ok) { await plog(p, "project_oauth_failed", { slug: p.slug, status: r.status, error: t.error }); return page(res, 502, "Authorization failed", "<h1>Authorization failed</h1><p>Discord rejected the code.</p>"); }
        const ur = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${t.access_token}` } }), u = await ur.json();
        if (!ur.ok || !u.id) return page(res, 502, "Authorization failed", "<h1>Authorization failed</h1>");
        const drv = !!(c.store && p.owner_account && c.storage === "drive"); // Google Drive projects keep tokens and data in the owner's Drive, so they are never limited by plan
        const over = !!(c.store && limits && !(await limits.canStore(p, u.id))); // database storage is limited by the owner's plan
        const keep = !!c.store && !over;
        if (keep) await pool.query(`INSERT INTO side_project_users(slug,user_id,username,access_token_enc,refresh_token_enc,expires_at,scope) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(slug,user_id) DO UPDATE SET username=$3,access_token_enc=$4,refresh_token_enc=$5,expires_at=$6,scope=$7,created_at=NOW()`,
          [p.slug, u.id, u.global_name || u.username || u.id, drv ? enc("") : enc(t.access_token), drv ? enc("") : enc(t.refresh_token || ""), Date.now() + Number(t.expires_in || 604800) * 1000, String(t.scope || "")]);
        else fetch("https://discord.com/api/v10/oauth2/token/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.client_id, client_secret: dec(c.client_secret_enc), token: t.access_token, token_type_hint: "access_token" }) }).catch(() => {});
        if (over) await plog(p, "store_limit_reached", { slug: p.slug, note: "A user authorized but was not saved: the database storage limit of the plan is full. Upgrade the plan or switch this project to Google Drive." });
        if (keep && collect && p.owner_account) await collect(p, u, t);
        await plog(p, "project_oauth_success", { slug: p.slug, user_id: u.id, username: u.global_name || u.username, scope: String(t.scope || ""), stored: keep });
        if (c.redirect) return res.redirect(303, c.redirect);
        return page(res, 200, p.name, `<h1>${html(c.message || "Authorized")}</h1>`);
      } catch (e) { console.error(e); return page(res, 500, "Authorization failed", "<h1>Authorization failed</h1>"); }
    });

    for (const [type, path] of [["interactions", "/interactions"], ["webhook", "/webhook"]]) {
      app.post([`/projects/:slug${path}`, `/projects/:user/:slug${path}`], express.raw({ type: "*/*", limit: "200kb" }), async (req, res) => {
        const p = await get(keyOf(req), type).catch(() => null);
        if (!p) return res.status(404).send("Not found");
        if (!verifySig(req, (p.config || {}).public_key || "")) return res.status(401).send("invalid request signature");
        let body = {}; try { body = JSON.parse(req.body.toString("utf8")); } catch {}
        if (type === "webhook") { await plog(p, "project_webhook", { slug: p.slug, type: body.type, event: body.event && body.event.type }); return res.status(204).end(); }
        if (body.type === 1) return res.json({ type: 1 });
        await plog(p, "project_interaction", { slug: p.slug, type: body.type, command: body.data && body.data.name });
        return res.json({ type: 4, data: { content: String((p.config || {}).reply || "OK").slice(0, 2000), allowed_mentions: { parse: [] } } });
      });
    }

    for (const type of ["terms", "privacy"]) {
      app.get([`/projects/:slug${TYPES[type].path}`, `/projects/:user/:slug${TYPES[type].path}`], async (req, res) => {
        const p = await get(keyOf(req), type).catch(() => null);
        if (!p) return res.status(404).send("Not found");
        const c = p.config || {};
        const paras = String(c.body || "").split(/\n{2,}/).map((x) => `<p>${html(x.trim()).replace(/\n/g, "<br>")}</p>`).join("");
        return res.send(site.page(c.title || TYPES[type].label, `<h1>${html(c.title || TYPES[type].label)}</h1>${paras}`, ""));
      });
    }

    app.get(["/projects/:slug/invite", "/projects/:user/:slug/invite"], async (req, res) => {
      const p = await get(keyOf(req), "invite").catch(() => null);
      if (!p) return res.status(404).send("Not found");
      const c = p.config || {}, u = new URL("https://discord.com/oauth2/authorize");
      u.searchParams.set("client_id", c.client_id); u.searchParams.set("scope", c.scopes || "bot applications.commands");
      if (c.permissions) u.searchParams.set("permissions", c.permissions);
      res.redirect(302, u.toString());
    });
  }

  // ---------- validation ----------
  function clean(type, input, old) {
    const t = TYPES[type], i = input || {}, out = {}, str = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);
    for (const [k, , kind] of t.fields) {
      if (kind === "secret_opt") {
        const v = str(i[k], 200);
        if (v) out[k + "_enc"] = enc(v); else if (old && old[k + "_enc"]) out[k + "_enc"] = old[k + "_enc"];
      } else if (kind === "secret") {
        const v = str(i[k], 120);
        if (v) out[k + "_enc"] = enc(v); else if (old && old[k + "_enc"]) out[k + "_enc"] = old[k + "_enc"]; else throw new Error("Client secret is required.");
      } else if (kind === "storage") out[k] = i[k] === "drive" ? "drive" : "database";
      else if (kind === "scopes") out[k] = [...new Set(String(i[k] ?? "").split(/[\s,]+/).filter((x) => SCOPE_KEYS.has(x)))].join(" ");
      else if (kind === "bool") out[k] = !!i[k];
      else out[k] = str(i[k], kind === "area" ? 20000 : 300);
    }
    if (type === "oauth" && dataScopes && out.scopes.split(" ").some((s) => dataScopes.has(s))) out.store = true;
    if ("client_id" in out && !/^\d{17,20}$/.test(out.client_id)) throw new Error("Client ID must be 17 to 20 digits.");
    if ("public_key" in out && !/^[0-9a-f]{64}$/i.test(out.public_key)) throw new Error("Public key must be 64 hex characters.");
    if ("redirect" in out && out.redirect && !/^https:\/\/[^\s]{3,280}$/i.test(out.redirect)) throw new Error("Redirect must be an https URL.");
    if ("permissions" in out && out.permissions && !/^\d{1,20}$/.test(out.permissions)) throw new Error("Permissions must be a number.");
    if (("title" in out) && !out.title) throw new Error("A title is required.");
    return out;
  }

  // ---------- dashboard ----------
  const json = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
  function editor(rows, base, esc, o = {}) {
      const view = rows.map((p) => ({ slug: p.slug, name: p.name, type: p.type, url: o.urlFn ? o.urlFn(p) : urlOf(p), config: Object.fromEntries(Object.entries(p.config || {}).filter(([k]) => !k.endsWith("_enc"))), hasSecret: !!(p.config || {}).client_secret_enc, hasBot: !!(p.config || {}).bot_token_enc }));
      const types = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, { label: v.label, path: v.path, fields: v.fields }]));
      return `<div class="top"><div><h1>${o.title || "Side Projects"}</h1></div><button type="button" class="green" onclick="spOpen()">Create project</button></div>
<div class="card"><div class="wrap"><table class="stack"><tr><th>Name</th><th>Type</th><th>URL</th><th style="text-align:right">Actions</th></tr>
${rows.map((p, n) => `<tr><td data-l="Name">${esc(p.name)}</td><td data-l="Type">${esc(TYPES[p.type].label)}${p.type === "oauth" && (p.config || {}).store ? ` · ${p.users} stored` : ""}</td><td data-l="URL"><code style="word-break:break-all">${esc(o.urlFn ? o.urlFn(p) : urlOf(p))}</code></td><td class="actcell"><div class="acts"><button type="button" class="secondary" onclick="spCopy(${n})">Copy URL</button><button type="button" class="secondary" onclick="spOpen(${n})">Edit</button><button type="button" class="danger" onclick="spDelete(${n})">Delete</button>${o.extra ? o.extra(p) : ""}</div></td></tr>`).join("") || '<tr><td colspan="4">No projects.</td></tr>'}</table></div></div>
<dialog id="dlg-project"><div class="dlg-top"><h2 id="sp-title" style="margin:0">Create project</h2><button type="button" class="secondary" onclick="closeAll()">Close</button></div>
<label>Name</label><input id="sp-name" maxlength="40" autocomplete="off"><div class="muted" id="sp-url" style="font-size:12px;word-break:break-all"></div>
<label>For</label><select id="sp-type"></select><div id="sp-fields"></div>
<div style="margin-top:16px"><button type="button" class="green" id="sp-save">Save</button></div></dialog>
<script type="application/json" id="sp-data">${json({ projects: view, types, origin: origin(), base, prefix: o.prefix || "", scopes: SCOPES, removed: REMOVED })}</script>
<script>
var SP=JSON.parse(document.getElementById('sp-data').textContent),spEdit=null;
function spSlug(s){return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);}
function spUrl(){var t=SP.types[$('sp-type').value];$('sp-url').textContent=SP.origin+'/projects/'+SP.prefix+(spEdit?spEdit.slug:(spSlug($('sp-name').value)||'name'))+t.path;}
function spFields(){var t=SP.types[$('sp-type').value],box=$('sp-fields'),c=spEdit&&spEdit.type===$('sp-type').value?spEdit.config:{};box.innerHTML='';
 t.fields.forEach(function(f){var k=f[0],lab=document.createElement('label');lab.textContent=f[1];var el;
  if(f[2]==='scopes'){var sel=String(c[k]||'').split(' '),wrap=document.createElement('div');wrap.style.cssText='max-height:220px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:8px';
   SP.scopes.forEach(function(s){var l=document.createElement('label'),cb=document.createElement('input');cb.type='checkbox';cb.value=s[0];cb.style.width='auto';cb.checked=sel.indexOf(s[0])>-1;cb.addEventListener('change',spNotes);l.style.cssText='display:flex;gap:8px;align-items:flex-start;margin:4px 0;font-weight:400';l.appendChild(cb);var tx=document.createElement('span');tx.textContent=s[0]+' - '+s[1];l.appendChild(tx);wrap.appendChild(l);});
   var pm=document.createElement('a');pm.href='#';pm.textContent='Permissions missing?';pm.style.cssText='display:block;margin:10px 0 2px;padding-top:8px;border-top:1px solid var(--line);color:#9db4ff;font-weight:600';pm.addEventListener('click',function(e){e.preventDefault();var p=$('sp-missing');p.style.display=p.style.display==='none'?'block':'none';});wrap.appendChild(pm);
   wrap.dataset.k=k;wrap.dataset.kind='scopes';var ms=document.createElement('div');ms.id='sp-missing';ms.style.cssText='display:none;margin-top:10px;padding:12px;border:1px solid var(--line);border-radius:8px;font-size:13px';var mh=document.createElement('b');mh.textContent='Why some permissions are not listed';ms.appendChild(mh);var mp=document.createElement('p');mp.textContent='These permissions only work for apps that Discord itself has approved or let into a private program (they are meant for apps that run on the user\u2019s computer, the Social SDK, voice, friends lists, presences and app builds). If AutoAuth offered them, Discord would refuse the authorization with an invalid scope error and your project would never work, so they are left out instead of shown broken. If Discord approves your application for one, contact Discord developer support about it; AutoAuth does not request them.';ms.appendChild(mp);var ml=document.createElement('p');ml.className='muted';ml.style.wordBreak='break-word';ml.textContent='Left out: '+SP.removed.map(function(x){return x[0];}).join(', ');ms.appendChild(ml);box.appendChild(lab);box.appendChild(wrap);box.appendChild(ms);var nt=document.createElement('div');nt.id='sp-notes';nt.style.marginTop='10px';box.appendChild(nt);return;}
  if(f[2]==='storage'){el=document.createElement('select');[['database','Our database (encrypted, limited by plan)'],['drive','Google Drive (free for everyone, connect it on your Profile)']].forEach(function(o){var op=document.createElement('option');op.value=o[0];op.textContent=o[1];el.appendChild(op);});el.value=c[k]==='drive'?'drive':'database';el.dataset.k=k;el.dataset.kind='storage';box.appendChild(lab);box.appendChild(el);return;}
  if(f[2]==='bool'){el=document.createElement('input');el.type='checkbox';el.style.width='auto';el.checked=!!c[k];lab.style.display='flex';lab.style.gap='8px';lab.style.alignItems='center';lab.insertBefore(el,lab.firstChild);box.appendChild(lab);}
  else{el=f[2]==='area'?document.createElement('textarea'):document.createElement('input');if(f[2]==='secret'||f[2]==='secret_opt'){el.type='password';el.autocomplete='new-password';el.placeholder=spEdit&&(f[2]==='secret'?spEdit.hasSecret:spEdit.hasBot)?'Saved. Leave blank to keep':'';}else el.value=c[k]||'';if(f[2]==='area')el.style.minHeight='140px';box.appendChild(lab);box.appendChild(el);}
  el.dataset.k=k;el.dataset.kind=f[2]||'';});spUrl();spNotes();}
function spChecked(){var w=document.querySelector('#sp-fields [data-kind=scopes]');return w?[].slice.call(w.querySelectorAll('input:checked')).map(function(i){return i.value;}):[];}
function spNotes(){var n=$('sp-notes');if(!n)return;n.innerHTML='';var ch=spChecked();if(!ch.length)return;var h=document.createElement('b');h.textContent='How to set these up';n.appendChild(h);ch.forEach(function(k){var s=SP.scopes.filter(function(x){return x[0]===k;})[0],d=document.createElement('div');d.style.margin='6px 0';d.style.fontSize='13px';d.textContent=k+': '+s[2];n.appendChild(d);});}
function spOpen(n){spEdit=n===undefined?null:SP.projects[n];$('sp-title').textContent=spEdit?'Edit project':'Create project';$('sp-name').value=spEdit?spEdit.name:'';$('sp-name').disabled=!!spEdit;
 var s=$('sp-type');s.innerHTML='';Object.keys(SP.types).forEach(function(k){var o=document.createElement('option');o.value=k;o.textContent=SP.types[k].label;s.appendChild(o);});if(spEdit){s.value=spEdit.type;}s.disabled=!!spEdit;spFields();openDlg('dlg-project');}
document.addEventListener('DOMContentLoaded',function(){$('sp-type').addEventListener('change',spFields);$('sp-name').addEventListener('input',spUrl);
$('sp-save').addEventListener('click',async function(){var b=this,cfg={};[].slice.call($('sp-fields').querySelectorAll('[data-k]')).forEach(function(e){cfg[e.dataset.k]=e.dataset.kind==='bool'?e.checked:e.dataset.kind==='scopes'?[].slice.call(e.querySelectorAll('input:checked')).map(function(i){return i.value;}).join(' '):e.value;});b.disabled=true;
 try{var r=await fetch(spEdit?SP.base+'/'+spEdit.slug:SP.base,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('sp-name').value,type:$('sp-type').value,config:cfg})});var j=await r.json().catch(function(){return {};});
  if(r.ok){location.reload();}else{showMsg('Could not save',j.error||'Something went wrong.');b.disabled=false;}}catch(e){showMsg('Could not save',e.message);b.disabled=false;}});});
function spCopy(n){var u=SP.projects[n].url;(navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(function(){toast('URL copied.');},function(){showMsg('URL',u);});}
async function spDelete(n){var p=SP.projects[n];if(!confirm('Delete '+p.name+'?'))return;var r=await fetch(SP.base+'/'+p.slug+'/delete',{method:'POST'});if(r.ok)location.reload();else showMsg('Could not delete','Something went wrong.');}
</script>`;
  }

  function mountUi({ app, logged, verifyOrigin, render, esc }) {
    app.get("/dashboard/projects", logged, async (req, res) => {
      const rows = (await pool.query("SELECT p.slug,p.name,p.type,p.config,p.created_at,(SELECT COUNT(*)::int FROM side_project_users u WHERE u.slug=p.slug) AS users FROM side_projects p WHERE p.owner_account IS NULL ORDER BY p.created_at DESC")).rows;
      const content = editor(rows, "/dashboard/projects", esc);
      render(req, res, "projects", content);
    });

    app.post("/dashboard/projects", logged, verifyOrigin, express.json({ limit: "100kb" }), async (req, res) => {
      const b = req.body || {}, name = String(b.name || "").trim().slice(0, 40), type = String(b.type || "");
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      if (!TYPES[type]) return res.status(400).json({ error: "Choose what the project is for." });
      if (!name || !SLUG.test(slug)) return res.status(400).json({ error: "Enter a name using letters or numbers." });
      try {
        const config = clean(type, b.config);
        await pool.query("INSERT INTO side_projects(slug,name,type,config,created_by) VALUES($1,$2,$3,$4,$5)", [slug, name, type, JSON.stringify(config), req.session.owner]);
        await log("project_created", { slug, type }, req.session.owner);
        res.json({ ok: true, slug });
      } catch (e) { res.status(e.code === "23505" ? 409 : 400).json({ error: e.code === "23505" ? "A project with that name already exists." : e.message }); }
    });

    app.post("/dashboard/projects/:slug", logged, verifyOrigin, express.json({ limit: "100kb" }), async (req, res) => {
      const p = (await pool.query("SELECT slug,type,config FROM side_projects WHERE slug=$1 AND owner_account IS NULL", [String(req.params.slug)])).rows[0];
      if (!p) return res.status(404).json({ error: "Project not found." });
      try {
        const config = clean(p.type, (req.body || {}).config, p.config);
        await pool.query("UPDATE side_projects SET config=$2 WHERE slug=$1", [p.slug, JSON.stringify(config)]);
        await log("project_updated", { slug: p.slug }, req.session.owner);
        res.json({ ok: true });
      } catch (e) { res.status(400).json({ error: e.message }); }
    });

    app.post("/dashboard/projects/:slug/delete", logged, verifyOrigin, async (req, res) => {
      const slug = String(req.params.slug);
      await pool.query("DELETE FROM side_projects WHERE slug=$1 AND owner_account IS NULL", [slug]);
      await pool.query("DELETE FROM side_project_users WHERE slug=$1 AND NOT EXISTS(SELECT 1 FROM side_projects WHERE slug=$1)", [slug]);
      await log("project_deleted", { slug }, req.session.owner);
      res.json({ ok: true });
    });
  }

  return { mountPublic, mountUi, TYPES, SCOPES, clean, urlOf, editor, plog };
};
