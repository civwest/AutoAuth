// Owner-only messaging and profiles. Needs no Discord connection, only the dashboard login.
//   /channels/@me            list of conversations
//   /channels/@me/:id        one chat (the id is created once per pair of owners and never changes)
//   /users/profile           view a profile (own by default, ?user=<key> for the other owner)
//   /users/profile/edit      edit your profile
// Chat messages live in memory only. They are never written to the database or the logs, and they are
// cleared when someone presses "Close chat" or when both owners have left the chat.
const crypto = require("node:crypto");

module.exports = function mountMessages(c) {
  const { app, pool, express, logged, verifyOrigin, esc, render } = c;
  const OWNERS = ["1", "2"].map((n) => ({ key: n, user: process.env[`DASHBOARD_OWNER${n}_USER`] })).filter((o) => o.user);
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
    const r = await pool.query("SELECT display_name,pronouns,bio,status_emoji,status_text,accent,timezone,links,(avatar IS NOT NULL) AS has_av,updated_at FROM owner_profiles WHERE owner_key=$1", [key]);
    const x = r.rows[0] || {};
    return { key, user: userOf(key) || "", name: x.display_name || userOf(key) || "Owner", pronouns: x.pronouns || "", bio: x.bio || "", emoji: x.status_emoji || "", status: x.status_text || "",
      accent: x.accent || "#7289da", tz: x.timezone || "", links: x.links || "", hasAv: !!x.has_av, ver: x.updated_at ? new Date(x.updated_at).getTime() : 0 };
  }
  const avatar = (p, cls = "") => p.hasAv ? `<img class="av ${cls}" alt="" src="/users/profile/avatar/${esc(p.key)}?v=${p.ver}">` : `<div class="av ${cls}" style="background:${esc(p.accent)}">${esc((p.name || "?").slice(0, 1).toUpperCase())}</div>`;
  const online = (key) => { for (const x of chats.values()) if (Date.now() - (x.seen[key] || 0) < 12000) return true; return false; };
  const statusLine = (p) => `<span class="dot ${online(p.key) ? "on" : ""}"></span>${online(p.key) ? "In chat" : "Away"}${p.status || p.emoji ? ` · ${esc(p.emoji)} ${esc(p.status)}` : ""}`;

  app.get("/users/profile/avatar/:key", logged, owner, async (req, res) => {
    const r = await pool.query("SELECT avatar,avatar_type FROM owner_profiles WHERE owner_key=$1 AND avatar IS NOT NULL", [String(req.params.key)]);
    if (!r.rows[0]) return res.status(404).end();
    res.set({ "Content-Type": r.rows[0].avatar_type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" }).send(r.rows[0].avatar);
  });

  app.get("/users/profile", logged, owner, async (req, res) => {
    const key = OWNERS.some((o) => o.key === req.query.user) ? String(req.query.user) : req.me;
    const p = await getProfile(key), mine = key === req.me;
    let local = "";
    if (p.tz) { try { local = new Date().toLocaleTimeString("en-US", { timeZone: p.tz, hour: "numeric", minute: "2-digit" }) + " (" + p.tz + ")"; } catch {} }
    const links = p.links.split("\n").filter((l) => /^https?:\/\//i.test(l.trim())).slice(0, 3).map((l) => `<div><a href="${esc(l.trim())}" target="_blank" rel="noopener noreferrer nofollow" style="text-decoration:underline">${esc(l.trim())}</a></div>`).join("");
    const other = OWNERS.find((o) => o.key !== req.me);
    const content = `<div class="top"><div><h1>${mine ? "My profile" : esc(p.name)}</h1></div><div>${mine ? `<a class="btn" href="/users/profile/edit">Edit profile</a>` : `<a class="btn" href="/channels/@me">Message</a>`}</div></div>
<div class="card" style="max-width:640px;overflow:hidden"><div class="banner" style="background:${esc(p.accent)}"></div><div style="display:flex;gap:16px;align-items:flex-end;margin-top:-48px">${avatar(p, "lg")}<div style="padding-bottom:6px"><h2 style="margin:0">${esc(p.name)}</h2><div class="muted">${esc(p.user)}${p.pronouns ? " · " + esc(p.pronouns) : ""}</div></div></div>
<p>${p.emoji || p.status ? `${esc(p.emoji)} ${esc(p.status)}` : '<span class="muted">No status set</span>'}</p>
${p.bio ? `<h3>About</h3><p style="white-space:pre-wrap">${esc(p.bio)}</p>` : ""}${local ? `<h3>Local time</h3><p>${esc(local)}</p>` : ""}${links ? `<h3>Links</h3>${links}` : ""}</div>${!mine && !other ? "" : ""}`;
    render(req, res, "profile", content);
  });

  app.get("/users/profile/edit", logged, owner, async (req, res) => {
    const p = await getProfile(req.me);
    let zones = []; try { zones = Intl.supportedValuesOf("timeZone"); } catch {}
    const content = `<div class="top"><div><h1>Edit profile</h1><p class="muted">Only the owners can see this profile.</p></div><a class="btn secondary" href="/users/profile">Cancel</a></div>
<div class="card" style="max-width:640px"><div style="display:flex;gap:16px;align-items:center"><div id="av-prev">${avatar(p, "lg")}</div><div><label style="margin:0">Profile picture</label><input type="file" id="pf-file" accept="image/png,image/jpeg,image/webp,image/gif"><label style="display:flex;gap:8px;align-items:center;margin:8px 0 0"><input type="checkbox" id="pf-rm" style="width:auto;margin:0"> Remove picture</label></div></div>
<label>Display name</label><input id="pf-name" maxlength="32" value="${esc(p.name)}">
<label>Pronouns</label><input id="pf-pro" maxlength="24" value="${esc(p.pronouns)}" placeholder="e.g. they/them">
<label>Status</label><div style="display:flex;gap:8px"><input id="pf-emoji" maxlength="4" style="width:70px" value="${esc(p.emoji)}" placeholder="🙂"><input id="pf-status" maxlength="100" value="${esc(p.status)}" placeholder="What are you up to?"></div>
<label>About me</label><textarea id="pf-bio" maxlength="400" style="min-height:90px">${esc(p.bio)}</textarea>
<label>Time zone</label><select id="pf-tz"><option value="">Not set</option>${zones.map((z) => `<option${z === p.tz ? " selected" : ""}>${esc(z)}</option>`).join("")}</select>
<label>Links (one per line, up to 3, https only)</label><textarea id="pf-links" maxlength="400" style="min-height:70px">${esc(p.links)}</textarea>
<label>Profile colour</label><input type="color" id="pf-accent" value="${esc(p.accent)}" style="width:80px;height:40px;padding:2px">
<div style="margin-top:16px"><button type="button" class="green" id="pf-save">Save profile</button></div></div>
<script>${EDIT_JS}</script>`;
    render(req, res, "profile", content);
  });

  const EDIT_JS = `
var $=function(i){return document.getElementById(i);};var av=null;
$('pf-file').addEventListener('change',function(){var f=this.files[0];if(!f)return;
 var img=new Image(),url=URL.createObjectURL(f);img.onload=function(){var s=256,cv=document.createElement('canvas');cv.width=s;cv.height=s;var cx=cv.getContext('2d');var m=Math.min(img.width,img.height);cx.drawImage(img,(img.width-m)/2,(img.height-m)/2,m,m,0,0,s,s);av=cv.toDataURL('image/jpeg',0.88);$('av-prev').innerHTML='';var i=document.createElement('img');i.className='av lg';i.src=av;$('av-prev').appendChild(i);URL.revokeObjectURL(url);};
 img.onerror=function(){showMsg('Profile picture','That file could not be read as an image.');};img.src=url;});
$('pf-save').addEventListener('click',async function(){var b=this;b.disabled=true;
 try{var r=await fetch('/users/profile/edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:$('pf-name').value,pronouns:$('pf-pro').value,emoji:$('pf-emoji').value,status:$('pf-status').value,bio:$('pf-bio').value,tz:$('pf-tz').value,links:$('pf-links').value,accent:$('pf-accent').value,avatar:av,removeAvatar:$('pf-rm').checked})});
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
    try {
      await pool.query(`INSERT INTO owner_profiles(owner_key,display_name,pronouns,bio,status_emoji,status_text,accent,timezone,links,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
        ON CONFLICT(owner_key) DO UPDATE SET display_name=$2,pronouns=$3,bio=$4,status_emoji=$5,status_text=$6,accent=$7,timezone=$8,links=$9,updated_at=NOW()`,
        [req.me, name, t(b.pronouns, 24), t(b.bio, 400), t(b.emoji, 8), t(b.status, 100), accent, tz, links]);
      if (av) await pool.query("UPDATE owner_profiles SET avatar=$2, avatar_type=$3 WHERE owner_key=$1", [req.me, av, avType]);
      else if (b.removeAvatar) await pool.query("UPDATE owner_profiles SET avatar=NULL, avatar_type=NULL WHERE owner_key=$1", [req.me]);
      res.json({ ok: true });
    } catch (e) { console.error("Profile save failed", e.message); res.status(500).json({ error: "Could not save your profile." }); }
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
    const content = `<div class="top"><div><h1>Messages</h1><p class="muted">A private chat between the owners. Messages are never saved: they disappear when the chat is closed.</p></div><a class="btn secondary" href="/users/profile">My profile</a></div>
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
