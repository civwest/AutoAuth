// Side projects: small Discord-bot web endpoints kept in the database (no environment variables).
// Each project lives under /projects/<slug>/... and has one type (below).
const crypto = require("node:crypto");

const TYPES = {
  oauth: { label: "OAuth2 callback", path: "/oauth/callback",
    fields: [["client_id", "Client ID"], ["client_secret", "Client secret", "secret"], ["message", "Success message"], ["redirect", "Redirect after success (https, optional)"], ["store", "Store users and tokens", "bool"]] },
  interactions: { label: "Interactions endpoint", path: "/interactions",
    fields: [["public_key", "Public key"], ["reply", "Reply to commands"]] },
  webhook: { label: "Webhook events", path: "/webhook", fields: [["public_key", "Public key"]] },
  terms: { label: "Terms of Service", path: "/terms", fields: [["title", "Title"], ["body", "Text", "area"]] },
  privacy: { label: "Privacy Policy", path: "/privacy", fields: [["title", "Title"], ["body", "Text", "area"]] },
  invite: { label: "Invite redirect", path: "/invite", fields: [["client_id", "Client ID"], ["permissions", "Permissions"], ["scopes", "Scopes"]] },
};
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const ED25519_DER = Buffer.from("302a300506032b6570032100", "hex");

module.exports = function createProjects({ pool, enc, dec, log, express }) {
  const origin = () => { try { return new URL(process.env.REDIRECT_URI).origin; } catch { return ""; } };
  const urlOf = (p) => `${origin()}/projects/${p.slug}${TYPES[p.type].path}`;
  const hits = new Map();
  const limited = (k, max) => { const n = Date.now(), h = hits.get(k); if (!h || h.until < n) { hits.set(k, { n: 1, until: n + 60000 }); return false; } return ++h.n > max; };
  setInterval(() => { const n = Date.now(); for (const [k, v] of hits) if (v.until < n) hits.delete(k); }, 60000).unref();
  const get = async (slug, type) => { const r = await pool.query("SELECT slug,name,type,config FROM side_projects WHERE slug=$1 AND type=$2", [String(slug), type]); return r.rows[0]; };
  const html = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- public endpoints ----------
  function verifySig(req, hex) {
    try {
      const sig = Buffer.from(String(req.get("x-signature-ed25519") || ""), "hex"), ts = String(req.get("x-signature-timestamp") || "");
      if (sig.length !== 64 || !ts || !Buffer.isBuffer(req.body)) return false;
      const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_DER, Buffer.from(hex, "hex")]), format: "der", type: "spki" });
      return crypto.verify(null, Buffer.concat([Buffer.from(ts), req.body]), key, sig);
    } catch { return false; }
  }

  function mountPublic({ app, site }) {
    const page = (res, status, title, body) => res.status(status).set("Cache-Control", "no-store").send(site.page(title, body, ""));

    app.get("/projects/:slug/oauth/callback", async (req, res) => {
      res.set({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
      const p = await get(req.params.slug, "oauth").catch(() => null);
      if (!p) return res.status(404).send("Not found");
      if (limited("o:" + req.ip, 30)) return res.status(429).send("Too many requests.");
      if (req.query.error) return page(res, 400, "Authorization cancelled", "<h1>Authorization cancelled</h1>");
      if (typeof req.query.code !== "string" || !req.query.code) return page(res, 400, "Authorization failed", "<h1>Authorization failed</h1><p>No code was returned.</p>");
      const c = p.config || {};
      try {
        const r = await fetch("https://discord.com/api/v10/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: c.client_id, client_secret: dec(c.client_secret_enc), grant_type: "authorization_code", code: req.query.code, redirect_uri: urlOf(p) }) });
        const t = await r.json();
        if (!r.ok) { await log("project_oauth_failed", { slug: p.slug, status: r.status, error: t.error }); return page(res, 502, "Authorization failed", "<h1>Authorization failed</h1><p>Discord rejected the code.</p>"); }
        const ur = await fetch("https://discord.com/api/v10/users/@me", { headers: { Authorization: `Bearer ${t.access_token}` } }), u = await ur.json();
        if (!ur.ok || !u.id) return page(res, 502, "Authorization failed", "<h1>Authorization failed</h1>");
        if (c.store) await pool.query(`INSERT INTO side_project_users(slug,user_id,username,access_token_enc,refresh_token_enc,expires_at,scope) VALUES($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT(slug,user_id) DO UPDATE SET username=$3,access_token_enc=$4,refresh_token_enc=$5,expires_at=$6,scope=$7,created_at=NOW()`,
          [p.slug, u.id, u.global_name || u.username || u.id, enc(t.access_token), enc(t.refresh_token || ""), Date.now() + Number(t.expires_in || 604800) * 1000, String(t.scope || "")]);
        else fetch("https://discord.com/api/v10/oauth2/token/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: c.client_id, client_secret: dec(c.client_secret_enc), token: t.access_token, token_type_hint: "access_token" }) }).catch(() => {});
        await log("project_oauth_success", { slug: p.slug, user_id: u.id, username: u.global_name || u.username, scope: String(t.scope || ""), stored: !!c.store });
        if (c.redirect) return res.redirect(303, c.redirect);
        return page(res, 200, p.name, `<h1>${html(c.message || "Authorized")}</h1>`);
      } catch (e) { console.error(e); return page(res, 500, "Authorization failed", "<h1>Authorization failed</h1>"); }
    });

    for (const [type, path] of [["interactions", "/interactions"], ["webhook", "/webhook"]]) {
      app.post(`/projects/:slug${path}`, express.raw({ type: "*/*", limit: "200kb" }), async (req, res) => {
        const p = await get(req.params.slug, type).catch(() => null);
        if (!p) return res.status(404).send("Not found");
        if (!verifySig(req, (p.config || {}).public_key || "")) return res.status(401).send("invalid request signature");
        let body = {}; try { body = JSON.parse(req.body.toString("utf8")); } catch {}
        if (type === "webhook") { await log("project_webhook", { slug: p.slug, type: body.type, event: body.event && body.event.type }); return res.status(204).end(); }
        if (body.type === 1) return res.json({ type: 1 });
        await log("project_interaction", { slug: p.slug, type: body.type, command: body.data && body.data.name });
        return res.json({ type: 4, data: { content: String((p.config || {}).reply || "OK").slice(0, 2000), allowed_mentions: { parse: [] } } });
      });
    }

    for (const type of ["terms", "privacy"]) {
      app.get(`/projects/:slug${TYPES[type].path}`, async (req, res) => {
        const p = await get(req.params.slug, type).catch(() => null);
        if (!p) return res.status(404).send("Not found");
        const c = p.config || {};
        const paras = String(c.body || "").split(/\n{2,}/).map((x) => `<p>${html(x.trim()).replace(/\n/g, "<br>")}</p>`).join("");
        return res.send(site.page(c.title || TYPES[type].label, `<h1>${html(c.title || TYPES[type].label)}</h1>${paras}`, ""));
      });
    }

    app.get("/projects/:slug/invite", async (req, res) => {
      const p = await get(req.params.slug, "invite").catch(() => null);
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
      if (kind === "secret") {
        const v = str(i[k], 120);
        if (v) out[k + "_enc"] = enc(v); else if (old && old[k + "_enc"]) out[k + "_enc"] = old[k + "_enc"]; else throw new Error("Client secret is required.");
      } else if (kind === "bool") out[k] = !!i[k];
      else out[k] = str(i[k], kind === "area" ? 20000 : 300);
    }
    if ("client_id" in out && !/^\d{17,20}$/.test(out.client_id)) throw new Error("Client ID must be 17 to 20 digits.");
    if ("public_key" in out && !/^[0-9a-f]{64}$/i.test(out.public_key)) throw new Error("Public key must be 64 hex characters.");
    if ("redirect" in out && out.redirect && !/^https:\/\/[^\s]{3,280}$/i.test(out.redirect)) throw new Error("Redirect must be an https URL.");
    if ("permissions" in out && out.permissions && !/^\d{1,20}$/.test(out.permissions)) throw new Error("Permissions must be a number.");
    if ("scopes" in out && out.scopes && !/^[a-z._]+( [a-z._]+)*$/.test(out.scopes)) throw new Error("Scopes are space separated words.");
    if (("title" in out) && !out.title) throw new Error("A title is required.");
    return out;
  }

  // ---------- dashboard ----------
  function mountUi({ app, logged, verifyOrigin, render, esc }) {
    const json = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
    app.get("/dashboard/projects", logged, async (req, res) => {
      const rows = (await pool.query("SELECT p.slug,p.name,p.type,p.config,p.created_at,(SELECT COUNT(*)::int FROM side_project_users u WHERE u.slug=p.slug) AS users FROM side_projects p ORDER BY p.created_at DESC")).rows;
      const view = rows.map((p) => ({ slug: p.slug, name: p.name, type: p.type, url: urlOf(p), config: Object.fromEntries(Object.entries(p.config || {}).filter(([k]) => !k.endsWith("_enc"))), hasSecret: !!(p.config || {}).client_secret_enc }));
      const types = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, { label: v.label, path: v.path, fields: v.fields }]));
      const content = `<div class="top"><div><h1>Side Projects</h1></div><button type="button" class="green" onclick="spOpen()">Create project</button></div>
<div class="card"><div class="wrap"><table class="stack"><tr><th>Name</th><th>Type</th><th>URL</th><th style="text-align:right">Actions</th></tr>
${rows.map((p, n) => `<tr><td data-l="Name">${esc(p.name)}</td><td data-l="Type">${esc(TYPES[p.type].label)}${p.type === "oauth" && (p.config || {}).store ? ` · ${p.users} stored` : ""}</td><td data-l="URL"><code style="word-break:break-all">${esc(urlOf(p))}</code></td><td class="actcell"><div class="acts"><button type="button" class="secondary" onclick="spCopy(${n})">Copy URL</button><button type="button" class="secondary" onclick="spOpen(${n})">Edit</button><button type="button" class="danger" onclick="spDelete(${n})">Delete</button></div></td></tr>`).join("") || '<tr><td colspan="4">No projects.</td></tr>'}</table></div></div>
<dialog id="dlg-project"><div class="dlg-top"><h2 id="sp-title" style="margin:0">Create project</h2><button type="button" class="secondary" onclick="closeAll()">Close</button></div>
<label>Name</label><input id="sp-name" maxlength="40" autocomplete="off"><div class="muted" id="sp-url" style="font-size:12px;word-break:break-all"></div>
<label>For</label><select id="sp-type"></select><div id="sp-fields"></div>
<div style="margin-top:16px"><button type="button" class="green" id="sp-save">Save</button></div></dialog>
<script type="application/json" id="sp-data">${json({ projects: view, types, origin: origin() })}</script>
<script>
var SP=JSON.parse(document.getElementById('sp-data').textContent),spEdit=null;
function spSlug(s){return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);}
function spUrl(){var t=SP.types[$('sp-type').value];$('sp-url').textContent=SP.origin+'/projects/'+(spEdit?spEdit.slug:(spSlug($('sp-name').value)||'name'))+t.path;}
function spFields(){var t=SP.types[$('sp-type').value],box=$('sp-fields'),c=spEdit&&spEdit.type===$('sp-type').value?spEdit.config:{};box.innerHTML='';
 t.fields.forEach(function(f){var k=f[0],lab=document.createElement('label');lab.textContent=f[1];var el;
  if(f[2]==='bool'){el=document.createElement('input');el.type='checkbox';el.style.width='auto';el.checked=!!c[k];lab.style.display='flex';lab.style.gap='8px';lab.style.alignItems='center';lab.insertBefore(el,lab.firstChild);box.appendChild(lab);}
  else{el=f[2]==='area'?document.createElement('textarea'):document.createElement('input');if(f[2]==='secret'){el.type='password';el.autocomplete='new-password';el.placeholder=spEdit&&spEdit.hasSecret?'Saved. Leave blank to keep':'';}else el.value=c[k]||'';if(f[2]==='area')el.style.minHeight='140px';box.appendChild(lab);box.appendChild(el);}
  el.dataset.k=k;el.dataset.kind=f[2]||'';});spUrl();}
function spOpen(n){spEdit=n===undefined?null:SP.projects[n];$('sp-title').textContent=spEdit?'Edit project':'Create project';$('sp-name').value=spEdit?spEdit.name:'';$('sp-name').disabled=!!spEdit;
 var s=$('sp-type');s.innerHTML='';Object.keys(SP.types).forEach(function(k){var o=document.createElement('option');o.value=k;o.textContent=SP.types[k].label;s.appendChild(o);});if(spEdit){s.value=spEdit.type;}s.disabled=!!spEdit;spFields();openDlg('dlg-project');}
$('sp-type').addEventListener('change',spFields);$('sp-name').addEventListener('input',spUrl);
$('sp-save').addEventListener('click',async function(){var b=this,cfg={};[].slice.call($('sp-fields').querySelectorAll('[data-k]')).forEach(function(e){cfg[e.dataset.k]=e.dataset.kind==='bool'?e.checked:e.value;});b.disabled=true;
 try{var r=await fetch(spEdit?'/dashboard/projects/'+spEdit.slug:'/dashboard/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('sp-name').value,type:$('sp-type').value,config:cfg})});var j=await r.json().catch(function(){return {};});
  if(r.ok){location.reload();}else{showMsg('Could not save',j.error||'Something went wrong.');b.disabled=false;}}catch(e){showMsg('Could not save',e.message);b.disabled=false;}});
function spCopy(n){var u=SP.projects[n].url;(navigator.clipboard?navigator.clipboard.writeText(u):Promise.reject()).then(function(){toast('URL copied.');},function(){showMsg('URL',u);});}
async function spDelete(n){var p=SP.projects[n];if(!confirm('Delete '+p.name+'?'))return;var r=await fetch('/dashboard/projects/'+p.slug+'/delete',{method:'POST'});if(r.ok)location.reload();else showMsg('Could not delete','Something went wrong.');}
</script>`;
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
      const p = (await pool.query("SELECT slug,type,config FROM side_projects WHERE slug=$1", [String(req.params.slug)])).rows[0];
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
      await pool.query("DELETE FROM side_project_users WHERE slug=$1", [slug]);
      await pool.query("DELETE FROM side_projects WHERE slug=$1", [slug]);
      await log("project_deleted", { slug }, req.session.owner);
      res.json({ ok: true });
    });
  }

  return { mountPublic, mountUi, TYPES };
};
