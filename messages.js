// Owner-only messaging and profiles. Needs no Discord connection, only the dashboard login.
//   /channels/@me            list of conversations
//   /channels/@me/:id        one chat (the id is created once per pair of owners and never changes)
//   /users/profile           view a profile (own by default, ?user=<key> for the other owner)
//   /users/profile/edit      edit your profile
// Chat messages live in memory only. They are never written to the database or the logs, and they are
// cleared when someone presses "Close chat" or when both owners have left the chat.
const crypto = require("node:crypto");

module.exports = function mountMessages(c) {
  const { app, pool, express, logged, verifyOrigin, esc, render, admins, ADMIN_PERMS } = c;
  const OWNERS = admins.map((a) => ({ key: a.key, user: a.user })); // every dashboard user can message every other one
  const keyOf = (u) => (OWNERS.find((o) => o.user === u) || {}).key;
  const userOf = (k) => (OWNERS.find((o) => o.key === k) || {}).user;
  const json = (o) => JSON.stringify(o).replace(/</g, "\\u003c");

  const chats = new Map(); // conversation id -> { msgs, nextId, epoch, seen: {ownerKey: ms} }
  const chat = (id) => { let x = chats.get(id); if (!x) { x = { msgs: [], nextId: 1, epoch: 1, seen: {} }; chats.set(id, x); } return x; };
  setInterval(() => { // everybody has left the chat: clear it
    const now = Date.now();
    for (const x of chats.values()) {
      if (!x.msgs.length) continue;
      const last = Math.max(0, ...Object.values(x.seen));
      if (now - last > 2 * 60 * 1000) { x.msgs = []; x.epoch++; }
    }
  }, 30000).unref();

  const owner = (req, res, next) => { req.me = keyOf(req.session.owner); if (!req.me) return res.status(403).send("This area is for dashboard owners."); next(); };

  // ---------- profiles ----------
  async function getProfile(key) {
    const r = await pool.query("SELECT display_name,pronouns,bio,status_emoji,status_text,accent,timezone,links,discord,(avatar IS NOT NULL) AS has_av,(banner IS NOT NULL) AS has_bn,updated_at FROM owner_profiles WHERE owner_key=$1", [key]);
    const x = r.rows[0] || {};
    return { key, user: userOf(key) || "", name: x.display_name || userOf(key) || "Owner", pronouns: x.pronouns || "", bio: x.bio || "", emoji: x.status_emoji || "", status: x.status_text || "",
      accent: x.accent || "#7289da", tz: x.timezone || "", links: x.links || "", discord: x.discord || "", hasAv: !!x.has_av, hasBn: !!x.has_bn, ver: x.updated_at ? new Date(x.updated_at).getTime() : 0 };
  }
  // A Discord entry may be a user ID, a discord.com/users or discord.gg link, or just a username (shown without a link).
  const discordHref = (v) => { v = String(v || "").trim(); if (/^\d{17,20}$/.test(v)) return "https://discord.com/users/" + v; if (/^https:\/\/(discord\.com\/users\/\d{17,20}|discord\.gg\/[\w-]{2,32}|discord\.com\/invite\/[\w-]{2,32})$/i.test(v)) return v; return ""; };
  const avatar = (p, cls = "") => p.hasAv ? `<img class="av ${cls}" alt="" src="/users/profile/avatar/${esc(p.key)}?v=${p.ver}">` : `<div class="av ${cls}" style="background:${esc(p.accent)}">${esc((p.name || "?").slice(0, 1).toUpperCase())}</div>`;
  const online = (key) => { for (const x of chats.values()) if (Date.now() - (x.seen[key] || 0) < 12000) return true; return false; };
  const statusLine = (p) => `<span class="dot ${online(p.key) ? "on" : ""}"></span>${online(p.key) ? "In chat" : "Away"}${p.status || p.emoji ? ` · ${esc(p.emoji)} ${esc(p.status)}` : ""}`;

  app.get("/users/profile/avatar/:key", logged, owner, async (req, res) => {
    const r = await pool.query("SELECT avatar,avatar_type FROM owner_profiles WHERE owner_key=$1 AND avatar IS NOT NULL", [String(req.params.key)]);
    if (!r.rows[0]) return res.status(404).end();
    res.set({ "Content-Type": r.rows[0].avatar_type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" }).send(r.rows[0].avatar);
  });

  app.get("/users/profile/banner/:key", logged, owner, async (req, res) => {
    const r = await pool.query("SELECT banner,banner_type FROM owner_profiles WHERE owner_key=$1 AND banner IS NOT NULL", [String(req.params.key)]);
    if (!r.rows[0]) return res.status(404).end();
    res.set({ "Content-Type": r.rows[0].banner_type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" }).send(r.rows[0].banner);
  });
  const bannerStyle = (p) => p.hasBn ? `background:url(/users/profile/banner/${esc(p.key)}?v=${p.ver}) center/cover` : `background:${esc(p.accent)}`;

  app.get("/users/profile", logged, owner, async (req, res) => {
    const key = OWNERS.some((o) => o.key === req.query.user) ? String(req.query.user) : req.me;
    const p = await getProfile(key), mine = key === req.me;
    let local = "";
    if (p.tz) { try { local = new Date().toLocaleTimeString("en-US", { timeZone: p.tz, hour: "numeric", minute: "2-digit" }) + " (" + p.tz + ")"; } catch {} }
    const links = p.links.split("\n").filter((l) => /^https?:\/\//i.test(l.trim())).slice(0, 3).map((l) => `<div><a href="${esc(l.trim())}" target="_blank" rel="noopener noreferrer nofollow" style="text-decoration:underline">${esc(l.trim())}</a></div>`).join("");
    const other = OWNERS.find((o) => o.key !== req.me);
    const content = `<div class="top"><div><h1>${mine ? "My profile" : esc(p.name)}</h1></div><div>${mine ? `<a class="btn" href="/users/profile/edit">Edit profile</a>` : `<a class="btn" href="/channels/@me">Message</a>`}</div></div>
<div class="card" style="max-width:640px;overflow:hidden"><div class="banner" style="${bannerStyle(p)}"></div><div style="display:flex;gap:16px;align-items:flex-end;margin-top:-48px">${avatar(p, "lg")}<div style="padding-bottom:6px"><h2 style="margin:0">${esc(p.name)}</h2><div class="muted">${esc(p.user)}${p.pronouns ? " · " + esc(p.pronouns) : ""}</div></div></div>
<p>${p.emoji || p.status ? `${esc(p.emoji)} ${esc(p.status)}` : '<span class="muted">No status set</span>'}</p>
${p.discord ? `<h3>Discord</h3><p>${discordHref(p.discord) ? `<a href="${esc(discordHref(p.discord))}" target="_blank" rel="noopener noreferrer nofollow" style="text-decoration:underline">${esc(p.discord)}</a>` : esc(p.discord)}</p>` : ""}${p.bio ? `<h3>About</h3><p style="white-space:pre-wrap">${esc(p.bio)}</p>` : ""}${local ? `<h3>Local time</h3><p>${esc(local)}</p>` : ""}${links ? `<h3>Links</h3>${links}` : ""}</div>${!mine && !other ? "" : ""}`;
    render(req, res, "profile", content + (mine ? await linkedCard(req) : ""));
  });

  // Connect / disconnect Discord, Google and X for signing in to the dashboard.
  async function linkedCard(req) {
    const social = c.social, dl = (await pool.query("SELECT discord_id,username FROM dashboard_discord WHERE owner_key=$1", [req.me])).rows[0];
    const ids = c.ownerIdent ? await c.ownerIdent.list(req.me) : [];
    const unl = (action) => `<form method="post" action="${action}" style="margin:0"><button class="secondary" style="width:auto">Unlink</button></form>`;
    const row = (label, linked, link, unlink) => `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)"><div style="flex:1;min-width:120px"><b>${label}</b><div class="muted">${linked ? esc(linked) : "Not linked"}</div></div>${linked ? unlink : `<div style="width:230px;max-width:100%">${link}</div>`}</div>`;
    const rows = [row("Discord", dl && (dl.username || dl.discord_id), social.btn("discord", "Link Discord", { post: "/users/profile/discord-link", fields: { return: "/users/profile" } }), unl("/users/profile/discord-unlink"))]
      .concat(["google", "x"].map((k) => { const i = ids.find((x) => x.provider === k); return row(social.PROV[k].label, i && (i.name || "Linked"), social.btn(k, `Link ${social.PROV[k].label}`, { href: `/auth/${k}/start?intent=olink` }), unl(`/users/profile/unlink/${k}`)); }));
    return `<div class="card" style="max-width:640px;margin-top:16px"><h2>Linked accounts</h2>${rows.join("")}</div>`;
  }
  app.post("/users/profile/unlink/:provider", logged, owner, verifyOrigin, async (req, res) => {
    if (["google", "x"].includes(req.params.provider) && c.ownerIdent) { await c.ownerIdent.unlink(req.me, req.params.provider); req.session.flash = "Unlinked."; }
    res.redirect(303, "/users/profile");
  });

  app.get("/users/profile/edit", logged, owner, async (req, res) => {
    const p = await getProfile(req.me);
    let zones = []; try { zones = Intl.supportedValuesOf("timeZone"); } catch {}
    const content = `<div class="top"><div><h1>Edit profile</h1></div><a class="btn secondary" href="/users/profile">Cancel</a></div>
<div class="card" style="max-width:640px"><label style="margin-top:0">Banner</label><div id="bn-prev" class="bnprev" style="${bannerStyle(p)}"></div>
<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><button type="button" class="secondary" id="bn-pick">Upload banner</button><button type="button" class="secondary" id="bn-rm">Remove banner</button></div>
<input type="file" id="bn-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
<div style="display:flex;gap:16px;align-items:center;margin-top:18px"><div id="av-prev">${avatar(p, "lg")}</div><div><label style="margin:0">Profile picture</label><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><button type="button" class="secondary" id="pf-pick">Upload picture</button><button type="button" class="secondary" id="pf-rm">Remove picture</button></div><input type="file" id="pf-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden></div></div>
<label>Display name</label><input id="pf-name" maxlength="32" value="${esc(p.name)}">
<label>Pronouns</label><input id="pf-pro" maxlength="24" value="${esc(p.pronouns)}" placeholder="e.g. they/them">
<label>Status</label><div style="display:flex;gap:8px"><input id="pf-emoji" maxlength="4" style="width:70px" value="${esc(p.emoji)}" placeholder="🙂"><input id="pf-status" maxlength="100" value="${esc(p.status)}" placeholder="What are you up to?"></div>
<label>About me</label><textarea id="pf-bio" maxlength="400" style="min-height:90px">${esc(p.bio)}</textarea>
<label>Time zone</label><select id="pf-tz"><option value="">Not set</option>${zones.map((z) => `<option${z === p.tz ? " selected" : ""}>${esc(z)}</option>`).join("")}</select>
<label>Links (one per line, up to 3, https only)</label><textarea id="pf-links" maxlength="400" style="min-height:70px">${esc(p.links)}</textarea>
<label>Profile colour</label><input type="color" id="pf-accent" value="${esc(p.accent)}" style="width:80px;height:40px;padding:2px">
<div style="margin-top:16px"><button type="button" class="green" id="pf-save">Save profile</button></div></div>

<dialog id="dlg-crop" class="crop-dlg"><div class="cr-head">Edit Image</div>
<div class="cr-stage"><div class="crop-wrap" id="cr-wrap"><canvas id="cr-cv"></canvas><div class="crop-mask" id="cr-mask"></div></div></div>
<div class="cr-zoom"><svg viewBox="0 0 24 24" width="16" height="16" fill="#9da7b3"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg><input type="range" id="cr-zoom" min="0" max="100" value="0"><svg viewBox="0 0 24 24" width="26" height="26" fill="#9da7b3"><path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/></svg></div>
<div class="cr-foot"><button type="button" class="secondary" onclick="closeAll()">Cancel</button><button type="button" class="dbtn" id="cr-ok">Apply</button></div></dialog>
<script>${EDIT_JS}</script>`;
    render(req, res, "profile", content);
  });

  const EDIT_JS = `
var $=function(i){return document.getElementById(i);};var av=null,bn=null,rmAv=false,rmBn=false;
var crop={img:null,s:1,min:1,x:0,y:0,w:320,h:320,ow:256,oh:256,cb:null},ptrs={},pinch=0;
function cdraw(){var c=$('cr-cv'),g=c.getContext('2d');g.clearRect(0,0,crop.w,crop.h);g.drawImage(crop.img,crop.x,crop.y,crop.img.width*crop.s,crop.img.height*crop.s);}
function cclamp(){crop.x=Math.min(0,Math.max(crop.w-crop.img.width*crop.s,crop.x));crop.y=Math.min(0,Math.max(crop.h-crop.img.height*crop.s,crop.y));}
function cscale(ns){ns=Math.max(crop.min,Math.min(crop.min*4,ns));var cx=crop.w/2,cy=crop.h/2,r=ns/crop.s;crop.x=cx-(cx-crop.x)*r;crop.y=cy-(cy-crop.y)*r;crop.s=ns;cclamp();cdraw();$('cr-zoom').value=Math.round((ns/crop.min-1)/3*100);}
function openCrop(file,o){var img=new Image(),url=URL.createObjectURL(file);
 img.onload=function(){crop.img=img;crop.w=o.w;crop.h=o.h;crop.ow=o.ow;crop.oh=o.oh;crop.cb=o.cb;var c=$('cr-cv');c.width=o.w;c.height=o.h;c.style.width=o.w+'px';c.style.height=o.h+'px';$('cr-wrap').style.width=o.w+'px';$('cr-wrap').style.height=o.h+'px';$('cr-mask').className='crop-mask'+(o.round?' round':'');
  crop.min=Math.max(o.w/img.width,o.h/img.height);crop.s=crop.min;crop.x=(o.w-img.width*crop.s)/2;crop.y=(o.h-img.height*crop.s)/2;$('cr-zoom').value=0;cdraw();URL.revokeObjectURL(url);closeAll();openDlg('dlg-crop');};
 img.onerror=function(){showMsg('Image','That file could not be read as an image.');};img.src=url;}
(function(){var c=$('cr-cv');
 function dist(){var k=Object.keys(ptrs);return Math.hypot(ptrs[k[0]].x-ptrs[k[1]].x,ptrs[k[0]].y-ptrs[k[1]].y);}
 c.addEventListener('pointerdown',function(e){e.preventDefault();ptrs[e.pointerId]={x:e.clientX,y:e.clientY};try{c.setPointerCapture(e.pointerId);}catch(x){}if(Object.keys(ptrs).length===2)pinch=dist();});
 c.addEventListener('pointermove',function(e){var p=ptrs[e.pointerId];if(!p)return;var n=Object.keys(ptrs).length;
  if(n===1){crop.x+=e.clientX-p.x;crop.y+=e.clientY-p.y;p.x=e.clientX;p.y=e.clientY;cclamp();cdraw();}
  else if(n===2){p.x=e.clientX;p.y=e.clientY;var d=dist();if(pinch)cscale(crop.s*d/pinch);pinch=d;}});
 function up(e){delete ptrs[e.pointerId];pinch=0;}
 c.addEventListener('pointerup',up);c.addEventListener('pointercancel',up);c.addEventListener('lostpointercapture',up);
 c.addEventListener('wheel',function(e){e.preventDefault();cscale(crop.s*(e.deltaY<0?1.06:1/1.06));},{passive:false});
 $('cr-zoom').addEventListener('input',function(){cscale(crop.min*(1+Number(this.value)/100*3));});
 $('cr-ok').addEventListener('click',function(){var o=document.createElement('canvas');o.width=crop.ow;o.height=crop.oh;var g=o.getContext('2d');g.fillStyle='#000';g.fillRect(0,0,o.width,o.height);g.drawImage(crop.img,-crop.x/crop.s,-crop.y/crop.s,crop.w/crop.s,crop.h/crop.s,0,0,crop.ow,crop.oh);var d=o.toDataURL('image/jpeg',0.88);closeAll();crop.cb(d);});
})();
$('pf-pick').addEventListener('click',function(){$('pf-file').click();});
$('bn-pick').addEventListener('click',function(){$('bn-file').click();});
$('pf-file').addEventListener('change',function(){var f=this.files[0];this.value='';if(!f)return;openCrop(f,{w:320,h:320,ow:256,oh:256,round:true,cb:function(d){av=d;rmAv=false;$('av-prev').innerHTML='';var i=document.createElement('img');i.className='av lg';i.src=d;$('av-prev').appendChild(i);}});});
$('bn-file').addEventListener('change',function(){var f=this.files[0];this.value='';if(!f)return;var w=Math.min(420,Math.max(240,window.innerWidth-90));openCrop(f,{w:w,h:Math.round(w*0.4),ow:1000,oh:400,round:false,cb:function(d){bn=d;rmBn=false;$('bn-prev').style.background='url('+d+') center/cover';}});});
$('pf-rm').addEventListener('click',function(){av=null;rmAv=true;var p=$('av-prev');p.innerHTML='';var d=document.createElement('div');d.className='av lg';d.textContent=($('pf-name').value||'?').slice(0,1).toUpperCase();p.appendChild(d);});
$('bn-rm').addEventListener('click',function(){bn=null;rmBn=true;$('bn-prev').style.background=$('pf-accent').value;});
$('pf-save').addEventListener('click',async function(){var b=this;b.disabled=true;
 try{var r=await fetch('/users/profile/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('pf-name').value,pronouns:$('pf-pro').value,emoji:$('pf-emoji').value,status:$('pf-status').value,bio:$('pf-bio').value,tz:$('pf-tz').value,links:$('pf-links').value,accent:$('pf-accent').value,avatar:av,removeAvatar:rmAv,banner:bn,removeBanner:rmBn})});
  var j=await r.json().catch(function(){return {};});if(r.ok){location.href='/users/profile';}else{showMsg('Could not save',j.error||'Something went wrong.');b.disabled=false;}
 }catch(e){showMsg('Could not save',e.message);b.disabled=false;}});
`;

  app.post("/users/profile/edit", logged, owner, verifyOrigin, express.json({ limit: "1mb" }), async (req, res) => {
    const b = req.body || {}, t = (v, n) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);
    const accent = /^#[0-9a-f]{6}$/i.test(String(b.accent)) ? String(b.accent) : "#7289da";
    let tz = t(b.tz, 64); if (tz) { try { new Intl.DateTimeFormat("en", { timeZone: tz }); } catch { tz = ""; } }
    const links = String(b.links || "").split("\n").map((l) => l.trim()).filter((l) => /^https:\/\/[^\s]{3,200}$/i.test(l)).slice(0, 3).join("\n");
    const name = t(b.name, 32) || userOf(req.me);
    
    let av = null, avType = null;
    if (typeof b.avatar === "string" && b.avatar) {
      const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(b.avatar);
      if (!m) return res.status(400).json({ error: "Unsupported picture format." });
      const buf = Buffer.from(m[2], "base64");
      const okMagic = m[1] === "image/jpeg" ? buf.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) : buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      if (!okMagic || buf.length > 400 * 1024) return res.status(400).json({ error: "The picture is invalid or too large." });
      av = buf; avType = m[1];
    }
    let bnBuf = null;
    if (typeof b.banner === "string" && b.banner) {
      const mm = /^data:(image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(b.banner);
      if (!mm) return res.status(400).json({ error: "Unsupported banner format." });
      bnBuf = Buffer.from(mm[2], "base64");
      if (!bnBuf.slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || bnBuf.length > 600 * 1024) return res.status(400).json({ error: "The banner is invalid or too large." });
    }
    try {
      await pool.query(`INSERT INTO owner_profiles(owner_key,display_name,pronouns,bio,status_emoji,status_text,accent,timezone,links,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT(owner_key) DO UPDATE SET display_name=$2,pronouns=$3,bio=$4,status_emoji=$5,status_text=$6,accent=$7,timezone=$8,links=$9,updated_at=NOW()`,
        [req.me, name, t(b.pronouns, 24), t(b.bio, 400), t(b.emoji, 8), t(b.status, 100), accent, tz, links]);
      if (av) await pool.query("UPDATE owner_profiles SET avatar=$2, avatar_type=$3 WHERE owner_key=$1", [req.me, av, avType]);
      else if (b.removeAvatar) await pool.query("UPDATE owner_profiles SET avatar=NULL, avatar_type=NULL WHERE owner_key=$1", [req.me]);
      if (bnBuf) await pool.query("UPDATE owner_profiles SET banner=$2, banner_type='image/jpeg' WHERE owner_key=$1", [req.me, bnBuf]);
      else if (b.removeBanner) await pool.query("UPDATE owner_profiles SET banner=NULL, banner_type=NULL WHERE owner_key=$1", [req.me]);
      res.json({ ok: true });
    } catch (e) { console.error("Profile save failed", e.message); res.status(500).json({ error: "Could not save your profile." }); }
  });

  // ---------- add a dashboard user ----------
  // Creates a username + password hash for the owner to paste into Render. Nothing is stored here: the password is only hashed in memory.
  const hashPw = (pw) => { const salt = crypto.randomBytes(16); return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 }).toString("hex")}`; };
  const nextSlot = () => { for (let n = 1; n <= 9; n++) if (!admins.some((a) => a.key === String(n))) return n; return 0; };
  const fullAccess = (req) => { const a = admins.find((x) => x.user === req.session.owner); return !!a && ADMIN_PERMS.every((p) => a.perms.has(p)); };
  const PERM_LABELS = { bot: "Bot Control (status, restart, shut down)", users: "Users (expiry, add to server, DM, opt out)", servers: "Servers", dm: "DM Users", logs: "Logs", projects: "Side Projects" };

  app.get("/users/add", logged, owner, (req, res) => {
    if (!fullAccess(req)) return res.status(403).send("Only dashboard users with every permission can add users.");
    const slot = nextSlot();
    const content = `<div class="top"><div><h1>Add user</h1></div><a class="btn secondary" href="/channels/@me">Back</a></div>
<div class="card" style="max-width:640px">${slot ? `<label>Username</label><input id="au-user" maxlength="32" autocomplete="off" placeholder="letters, numbers, . _ -">
<label>Password (at least 12 characters)</label><input id="au-pw" type="password" autocomplete="new-password" maxlength="128">
<label>Repeat password</label><input id="au-pw2" type="password" autocomplete="new-password" maxlength="128">
<label>Permissions</label>${ADMIN_PERMS.map((p) => `<label style="display:flex;gap:8px;align-items:center;margin:4px 0"><input type="checkbox" class="au-perm" value="${p}" style="width:auto;margin:0"> ${esc(PERM_LABELS[p] || p)}</label>`).join("")}
<div style="margin-top:16px"><button type="button" class="green" id="au-go">Create login</button></div>
<div id="au-out" style="display:none;margin-top:18px"><h3>Add these to Render</h3><p class="muted">Render &gt; your service &gt; Environment. Add all three variables, save, and let it redeploy. The new person can then sign in at the dashboard login with the username and password they chose. The password is not stored anywhere here, so keep it safe.</p>
<label id="au-n1"></label><input id="au-v1" readonly onclick="this.select()">
<label id="au-n2"></label><input id="au-v2" readonly onclick="this.select()">
<label id="au-n3"></label><input id="au-v3" readonly onclick="this.select()">
<div style="margin-top:10px"><button type="button" class="secondary" id="au-copy">Copy all</button></div></div>` : `<p>All 9 dashboard user slots are already used. Remove one in Render first.</p>`}</div>
<script>
var $=function(i){return document.getElementById(i);};var go=$('au-go');if(go){
go.addEventListener('click',async function(){var b=this;b.disabled=true;
 try{var r=await fetch('/users/add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:$('au-user').value,password:$('au-pw').value,password2:$('au-pw2').value,perms:[].slice.call(document.querySelectorAll('.au-perm:checked')).map(function(c){return c.value;})})});
 var j=await r.json().catch(function(){return {};});
 if(!r.ok){showMsg('Could not create the login',j.error||'Something went wrong.');b.disabled=false;return;}
 $('au-n1').textContent=j.userVar;$('au-v1').value=j.username;$('au-n2').textContent=j.hashVar;$('au-v2').value=j.hash;$('au-n3').textContent=j.permVar;$('au-v3').value=j.perms;$('au-out').style.display='block';$('au-pw').value='';$('au-pw2').value='';
 }catch(e){showMsg('Could not create the login',e.message);b.disabled=false;}});
$('au-copy').addEventListener('click',function(){var t=$('au-n1').textContent+'='+$('au-v1').value+'\\n'+$('au-n2').textContent+'='+$('au-v2').value+'\\n'+$('au-n3').textContent+'='+$('au-v3').value;(navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){showMsg('Copied','The variables are on your clipboard.');},function(){showMsg('Copy failed','Select each value and copy it by hand.');});});}
</script>`;
    render(req, res, "msg", content);
  });

  app.post("/users/add", logged, owner, verifyOrigin, express.json({ limit: "5kb" }), (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fullAccess(req)) return res.status(403).json({ error: "Only dashboard users with every permission can add users." });
    const b = req.body || {}, username = String(b.username || "").trim(), pw = String(b.password || "");
    const slot = nextSlot();
    if (!slot) return res.status(400).json({ error: "All 9 dashboard user slots are used." });
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) return res.status(400).json({ error: "The username must be 3 to 32 characters: letters, numbers, dot, underscore or dash." });
    const perms = ADMIN_PERMS.filter((p) => Array.isArray(b.perms) && b.perms.includes(p));
    if (OWNERS.some((o) => o.user.toLowerCase() === username.toLowerCase())) return res.status(400).json({ error: "That username is already used." });
    if (pw.length < 12 || pw.length > 128) return res.status(400).json({ error: "The password must be 12 to 128 characters." });
    if (pw !== String(b.password2 || "")) return res.status(400).json({ error: "The two passwords do not match." });
    res.json({ username, hash: hashPw(pw), userVar: `DASHBOARD_ADMIN${slot}_USER`, hashVar: `DASHBOARD_ADMIN${slot}_PASSWORD_HASH`, permVar: `DASHBOARD_ADMIN${slot}_PERMISSIONS`, perms: perms.length === ADMIN_PERMS.length ? "all" : perms.join(",") || "none" });
  });

  app.post("/users/profile/discord-unlink", logged, owner, verifyOrigin, async (req, res) => {
    await c.unlinkDiscord(req.me);
    req.session.flash = "Discord account unlinked.";
    res.redirect(303, "/users/profile");
  });

  // ---------- conversations ----------
  async function convFor(a, b) {
    const [x, y] = [a, b].sort();
    const id = String(BigInt("0x" + crypto.randomBytes(8).toString("hex")) % 10n ** 17n + 10n ** 17n); // 18 digits
    await pool.query("INSERT INTO owner_dms(id,owner_a,owner_b) VALUES($1,$2,$3) ON CONFLICT(owner_a,owner_b) DO NOTHING", [id, x, y]);
    return (await pool.query("SELECT id FROM owner_dms WHERE owner_a=$1 AND owner_b=$2", [x, y])).rows[0].id;
  }

  app.get("/channels/@me", logged, owner, async (req, res) => {
    const rows = await Promise.all(OWNERS.filter((o) => o.key !== req.me).map(async (o) => ({ p: await getProfile(o.key), id: await convFor(req.me, o.key) })));
    const content = `<div class="top"><div><h1>Messages</h1></div>${fullAccess(req) ? '<a class="btn" href="/users/add">Add user</a>' : ""}</div>
<div class="card"><h2>Direct messages</h2>${rows.map((r) => `<a class="dmrow" href="/channels/@me/${esc(r.id)}">${avatar(r.p)}<div><b>${esc(r.p.name)}</b><div class="muted" style="font-size:13px">${statusLine(r.p)}</div></div></a>`).join("") || '<p class="muted">No other owner is set up yet.</p>'}</div>`;
    render(req, res, "msg", content);
  });

  async function member(req, res) {
    const id = String(req.params.id || "");
    const r = /^\d{18}$/.test(id) ? await pool.query("SELECT owner_a,owner_b FROM owner_dms WHERE id=$1", [id]) : { rows: [] };
    const row = r.rows[0];
    if (!row || (row.owner_a !== req.me && row.owner_b !== req.me)) { res.redirect(303, "/channels/@me"); return null; }
    return { id, other: row.owner_a === req.me ? row.owner_b : row.owner_a };
  }

  app.get("/channels/@me/:id", logged, owner, async (req, res) => {
    const m = await member(req, res); if (!m) return;
    const [me, them] = await Promise.all([getProfile(req.me), getProfile(m.other)]);
    chat(m.id).seen[req.me] = Date.now();
    const cfg = { id: m.id, me: req.me, people: { [me.key]: { name: me.name, hasAv: me.hasAv, ver: me.ver, accent: me.accent }, [them.key]: { name: them.name, hasAv: them.hasAv, ver: them.ver, accent: them.accent } } };
    const content = `<div class="top"><div style="display:flex;align-items:center;gap:12px"><a href="/channels/@me" class="muted">← Messages</a>${avatar(them)}<div><b><a href="/users/profile?user=${esc(them.key)}">${esc(them.name)}</a></b><div class="muted" style="font-size:13px" id="their-status">${statusLine(them)}</div></div></div>
<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="secondary" id="dl">Download transcript</button><form method="post" action="/channels/@me/${esc(m.id)}/close" style="margin:0" onsubmit="return confirm('Close the chat? All messages are deleted for both of you.')"><button class="danger">Close chat</button></form></div></div>
<div class="card chat"><div class="msgs" id="msgs"></div><p class="muted" style="font-size:12px;margin:6px 0 0">Messages are kept in memory only and are deleted when the chat is closed or both of you have left. Download a transcript first if you want to keep it.</p>
<form class="composer" id="composer" autocomplete="off"><textarea id="txt" maxlength="2000" placeholder="Message ${esc(them.name)}" rows="1"></textarea><button class="green">Send</button></form></div>
<script type="application/json" id="chat-cfg">${json(cfg)}</script><script>${CHAT_JS}</script>`;
    render(req, res, "msg", content);
  });

  const CHAT_JS = `
var C=JSON.parse(document.getElementById('chat-cfg').textContent),box=document.getElementById('msgs'),last=0,epoch=0,all=[];
function avEl(k){var p=C.people[k]||{name:'?',accent:'#7289da'},d;
 if(p.hasAv){d=document.createElement('img');d.src='/users/profile/avatar/'+k+'?v='+p.ver;d.alt='';}else{d=document.createElement('div');d.textContent=(p.name||'?').charAt(0).toUpperCase();d.style.background=p.accent;}
 d.className='av';return d;}
function add(m){all.push(m);var p=C.people[m.from]||{name:'?'},row=document.createElement('div');row.className='msg';row.appendChild(avEl(m.from));
 var b=document.createElement('div'),h=document.createElement('div'),w=document.createElement('span'),t=document.createElement('span'),x=document.createElement('div');
 w.className='who';w.textContent=p.name;t.className='when';t.textContent=new Date(m.at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});x.className='txt';x.textContent=m.text;
 h.appendChild(w);h.appendChild(t);b.appendChild(h);b.appendChild(x);row.appendChild(b);box.appendChild(row);}
async function poll(){try{var r=await fetch('/channels/@me/'+C.id+'/messages?after='+last+'&epoch='+epoch,{cache:'no-store'});
 if(r.status===401||r.redirected){location.href='/login?next='+encodeURIComponent(location.pathname);return;}
 var j=await r.json();
 if(j.epoch!==epoch){box.innerHTML='';all=[];last=0;epoch=j.epoch;}
 var near=box.scrollHeight-box.scrollTop-box.clientHeight<80;
 j.messages.forEach(function(m){add(m);last=Math.max(last,m.id);});
 if(j.messages.length&&near)box.scrollTop=box.scrollHeight;
 var s=document.getElementById('their-status');if(s){var d=s.querySelector('.dot');if(d)d.className='dot'+(j.online?' on':'');}
 }catch(e){}}
document.getElementById('composer').addEventListener('submit',async function(e){e.preventDefault();var t=document.getElementById('txt'),v=t.value.trim();if(!v)return;t.value='';
 try{var r=await fetch('/channels/@me/'+C.id+'/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:v})});
  if(!r.ok){showMsg('Not sent',(await r.json().catch(function(){return {};})).error||'The message could not be sent.');t.value=v;}else{await poll();box.scrollTop=box.scrollHeight;}
 }catch(err){showMsg('Not sent',err.message);t.value=v;}});
document.getElementById('txt').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('composer').requestSubmit();}});
document.getElementById('dl').addEventListener('click',function(){var lines=all.map(function(m){return '['+new Date(m.at).toLocaleString()+'] '+(C.people[m.from]||{name:'?'}).name+': '+m.text;}).join('\\n');
 var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([lines||'(no messages)'],{type:'text/plain'}));a.download='chat-transcript.txt';a.click();});
poll();setInterval(poll,2500);
`;

  app.get("/channels/@me/:id/messages", logged, owner, async (req, res) => {
    const m = await member(req, res); if (!m) return;
    const x = chat(m.id); x.seen[req.me] = Date.now();
    const after = Number(req.query.after) || 0, sameEpoch = Number(req.query.epoch) === x.epoch;
    res.set("Cache-Control", "no-store").json({ epoch: x.epoch, online: online(m.other), messages: (sameEpoch ? x.msgs.filter((g) => g.id > after) : x.msgs) });
  });
  app.post("/channels/@me/:id/messages", logged, owner, verifyOrigin, express.json({ limit: "16kb" }), async (req, res) => {
    const m = await member(req, res); if (!m) return;
    const text = String((req.body || {}).text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
    if (!text) return res.status(400).json({ error: "Write a message first." });
    if (text.length > 2000) return res.status(400).json({ error: "Messages can be at most 2000 characters." });
    const x = chat(m.id); x.seen[req.me] = Date.now();
    x.msgs.push({ id: x.nextId++, from: req.me, text, at: Date.now() });
    if (x.msgs.length > 500) x.msgs.shift();
    res.json({ ok: true });
  });
  app.post("/channels/@me/:id/close", logged, owner, verifyOrigin, async (req, res) => {
    const m = await member(req, res); if (!m) return;
    const x = chat(m.id); x.msgs = []; x.epoch++;
    res.redirect(303, "/channels/@me");
  });
};
