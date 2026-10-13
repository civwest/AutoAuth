// DM Users: one chat per person. Shows messages the owners sent from the dashboard and messages people
// send to the bot in Discord DMs. Tags: "Mutual server DM" (the sender shares a server with the bot),
// "Authorized DM" (the sender allowed DMs on the website), or "Other DM".
// Messages are stored in the bot_dms table and purged after DM_RETENTION_DAYS (default 30).
module.exports = function mountDms(c) {
  const { app, pool, client, esc, logged, verifyOrigin, render, lk, ov } = c;
  const json = (o) => JSON.stringify(o).replace(/</g, "\\u003c");
  const validUid = (s) => /^\d{17,20}$/.test(String(s || ""));
  const httpsOnly = (u) => (typeof u === "string" && /^https:\/\/[^\s]+$/i.test(u) ? u : "");

  // ---- recording ----
  async function recordOutbound(userId, username, owner, content, files) {
    await pool.query("INSERT INTO bot_dms(user_id,username,direction,sender,content,attachments,is_read) VALUES($1,$2,'out',$3,$4,$5,TRUE)",
      [userId, username || null, owner || null, String(content || "").slice(0, 4000), JSON.stringify((files || []).map((f) => ({ name: String(f.name || "file").slice(0, 100) })))]);
  }
  async function recordInbound(m) {
    const uid = m.author.id;
    let mutual = false, mutualGuild = null;
    for (const g of client.guilds.cache.values()) { try { await g.members.fetch(uid); mutual = true; mutualGuild = g.id; break; } catch {} }
    const a = await pool.query("SELECT dm_authorized FROM authorized_users WHERE user_id=$1", [uid]);
    const authorized = !!(a.rows[0] && a.rows[0].dm_authorized);
    const atts = [...m.attachments.values()].slice(0, 10).map((x) => ({ name: String(x.name || "file").slice(0, 100), url: httpsOnly(x.url) }));
    await pool.query("INSERT INTO bot_dms(user_id,username,avatar_url,direction,content,attachments,mutual,authorized,is_read,mutual_guild) VALUES($1,$2,$3,'in',$4,$5,$6,$7,FALSE,$8)",
      [uid, (m.author.globalName || m.author.username || uid).slice(0, 80), httpsOnly(m.author.displayAvatarURL({ extension: "png", size: 128 })) || null, String(m.content || "").slice(0, 4000), JSON.stringify(atts), mutual, authorized, mutualGuild]);
  }
  async function purge() {
    const days = Number(process.env.DM_RETENTION_DAYS ?? 30);
    if (days > 0) await pool.query("DELETE FROM bot_dms WHERE created_at < NOW() - make_interval(days => $1)", [days]);
  }
  purge().catch(() => {});
  setInterval(() => purge().catch(() => {}), 6 * 3600 * 1000).unref();

  // ---- helpers ----
  const tagsFor = (authorized, mutual) => [
    mutual ? '<span class="badge dm">Mutual server DM</span>' : "",
    authorized ? '<span class="badge">Authorized DM</span>' : "",
    !mutual && !authorized ? '<span class="badge none" style="background:#2b3038;color:#c2c9d3">Other DM</span>' : "",
  ].join("");
  const avatar = (name, url, cls = "") => httpsOnly(url) && /^https:\/\/cdn\.discordapp\.com\//.test(url) ? `<img class="av ${cls}" alt="" src="${esc(url)}">` : `<div class="av ${cls}">${esc(String(name || "?").slice(0, 1).toUpperCase())}</div>`;
  const chatUrl = (uid, guild) => `/channels/${/^\d{17,20}$/.test(String(guild || "")) ? guild : "@dm"}/${uid}`;
  const ago = (d) => { const s = Math.max(1, Math.round((Date.now() - new Date(d).getTime()) / 1000)); return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : s < 86400 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d"; };

  async function conversations() {
    const [msgs, users] = await Promise.all([
      pool.query(`SELECT user_id,(array_agg(username ORDER BY id DESC))[1] AS username,(array_agg(avatar_url ORDER BY id DESC))[1] AS avatar_url,MAX(created_at) AS last_at,
        (array_agg(content ORDER BY id DESC))[1] AS last_content,COUNT(*) FILTER (WHERE direction='in' AND NOT is_read)::int AS unread,COALESCE(bool_or(mutual) FILTER (WHERE direction='in'),false) AS mutual,(array_agg(mutual_guild ORDER BY id DESC) FILTER (WHERE mutual_guild IS NOT NULL))[1] AS guild
        FROM bot_dms GROUP BY user_id`),
      pool.query("SELECT user_id,username,dm_authorized FROM authorized_users"),
    ]);
    const map = new Map();
    for (const u of users.rows) if (u.dm_authorized) map.set(u.user_id, { user_id: u.user_id, username: u.username, authorized: true, mutual: false, unread: 0, last_at: null, last_content: "" });
    const flag = new Map(users.rows.map((u) => [u.user_id, !!u.dm_authorized]));
    for (const m of msgs.rows) map.set(m.user_id, { ...(map.get(m.user_id) || {}), user_id: m.user_id, username: m.username || (map.get(m.user_id) || {}).username || m.user_id, avatar_url: m.avatar_url, authorized: !!flag.get(m.user_id), mutual: m.mutual, unread: m.unread, guild: m.guild, last_at: m.last_at, last_content: m.last_content });
    return [...map.values()].sort((a, b) => (b.last_at ? new Date(b.last_at).getTime() : 0) - (a.last_at ? new Date(a.last_at).getTime() : 0));
  }

  // ---- list ----
  app.get("/dashboard/dm", logged, async (req, res) => {
    try {
      const list = await conversations();
      const content = `<div class="top"><div><h1>DM Users</h1><p class="muted">One chat per person: people who allowed DMs on the website, and anyone who messages the bot in Discord. Messages are kept ${Number(process.env.DM_RETENTION_DAYS ?? 30) > 0 ? "for " + Number(process.env.DM_RETENTION_DAYS ?? 30) + " days" : "until you delete them"}.</p></div></div>
  <div class="card${lk()}">${ov()}${list.map((u) => `<a class="dmrow" href="${esc(chatUrl(u.user_id, u.guild))}">${avatar(u.username, u.avatar_url)}<div style="flex:1;min-width:0"><div><b>${esc(u.username)}</b> ${tagsFor(u.authorized, u.mutual)}</div><div class="muted" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${u.last_content ? esc(u.last_content) : "No messages yet"}</div></div><div class="muted" style="font-size:12px;text-align:right">${u.last_at ? esc(ago(u.last_at)) : ""}${u.unread ? `<div><span class="badge" style="background:#7289da;color:#fff;margin:4px 0 0">${u.unread} new</span></div>` : ""}</div></a>`).join("") || '<p class="muted">No DM chats yet. People appear here when they allow DMs on the website or message the bot.</p>'}</div>`;
      render(req, res, "dm", content);
    } catch (e) { console.error(e); res.status(500).send("DM page failed to load."); }
  });

  // ---- chat ----
  app.get("/dashboard/dm/:uid", logged, (req, res) => res.redirect(301, chatUrl(String(req.params.uid).replace(/\D/g, ""), null)));
  app.get("/channels/:gid/:uid", logged, async (req, res, next) => {
    const uid = String(req.params.uid), gid = String(req.params.gid);
    if (gid === "@me" || !(gid === "@dm" || /^\d{17,20}$/.test(gid))) return next();
    if (!validUid(uid)) return res.redirect(303, "/dashboard/dm");
    try {
      const [u, a, m] = await Promise.all([
        pool.query("SELECT (array_agg(username ORDER BY id DESC))[1] AS username,(array_agg(avatar_url ORDER BY id DESC))[1] AS avatar_url,COALESCE(bool_or(mutual) FILTER (WHERE direction='in'),false) AS mutual,(array_agg(mutual_guild ORDER BY id DESC) FILTER (WHERE mutual_guild IS NOT NULL))[1] AS guild FROM bot_dms WHERE user_id=$1", [uid]),
        pool.query("SELECT username,dm_authorized FROM authorized_users WHERE user_id=$1", [uid]),
        pool.query("SELECT 1 FROM bot_dms WHERE user_id=$1 LIMIT 1", [uid]),
      ]);
      const name = (u.rows[0] && u.rows[0].username) || (a.rows[0] && a.rows[0].username) || uid;
      if (!a.rows[0] && !m.rows[0]) return res.redirect(303, "/dashboard/dm");
      const authorized = !!(a.rows[0] && a.rows[0].dm_authorized), mutual = !!(u.rows[0] && u.rows[0].mutual);
      const want = chatUrl(uid, u.rows[0] && u.rows[0].guild);
      if (req.path !== want) return res.redirect(302, want);
      const cfg = { uid, name };
      const content = `<div class="top"><div style="display:flex;align-items:center;gap:12px"><a href="/dashboard/dm" class="muted">← DM Users</a>${avatar(name, u.rows[0] && u.rows[0].avatar_url)}<div><b>${esc(name)}</b> ${tagsFor(authorized, mutual)}<div class="muted" style="font-size:12px">${esc(uid)}</div></div></div>
  <form method="post" action="/dashboard/dm/${esc(uid)}/delete" style="margin:0" onsubmit="return confirm('Delete the stored messages with this person? This cannot be undone.')"><button class="danger">Delete conversation</button></form></div>
  <div class="card chat"><div class="msgs" id="msgs"></div></div>
  <div class="card${lk()}">${ov()}<textarea id="dc-msg" maxlength="2000" placeholder="Message ${esc(name)}" style="min-height:70px"></textarea><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px"><input type="file" id="dc-files" multiple style="flex:1;min-width:200px"><button type="button" class="green" id="dc-send">Send</button></div><p class="muted" style="font-size:12px;margin:8px 0 0">Up to 5 files, 8 MB total. Discord may refuse a DM if the person has blocked the bot.</p></div>
  <script type="application/json" id="dc-cfg">${json(cfg)}</script><script>${CHAT_JS}</script>`;
      render(req, res, "dm", content);
    } catch (e) { console.error(e); res.status(500).send("Chat failed to load."); }
  });

  app.get("/dashboard/dm/:uid/messages", logged, async (req, res) => {
    const uid = String(req.params.uid);
    if (!validUid(uid)) return res.status(400).json({ error: "bad id" });
    const after = Number(req.query.after) || 0;
    const r = await pool.query("SELECT id,direction,sender,content,attachments,created_at FROM bot_dms WHERE user_id=$1 AND id>$2 ORDER BY id ASC LIMIT 300", [uid, after]);
    await pool.query("UPDATE bot_dms SET is_read=TRUE WHERE user_id=$1 AND direction='in' AND NOT is_read", [uid]);
    res.set("Cache-Control", "no-store").json({ messages: r.rows.map((x) => ({ id: Number(x.id), dir: x.direction, sender: x.sender, text: x.content, files: (x.attachments || []).map((f) => ({ name: f.name, url: httpsOnly(f.url) })), at: new Date(x.created_at).getTime() })) });
  });

  app.post("/dashboard/dm/:uid/delete", logged, verifyOrigin, async (req, res) => {
    const uid = String(req.params.uid);
    if (validUid(uid)) await pool.query("DELETE FROM bot_dms WHERE user_id=$1", [uid]);
    res.redirect(303, "/dashboard/dm");
  });

  const CHAT_JS = `
var C=JSON.parse(document.getElementById('dc-cfg').textContent),box=document.getElementById('msgs'),last=0;
function row(m){var r=document.createElement('div'),av=document.createElement('div'),b=document.createElement('div'),h=document.createElement('div'),w=document.createElement('span'),t=document.createElement('span'),x=document.createElement('div');
 var who=m.dir==='in'?C.name:(m.sender||'AutoAuth');r.className='msg';av.className='av';av.textContent=who.charAt(0).toUpperCase();if(m.dir==='out')av.style.background='#3b5bdb';
 w.className='who';w.textContent=who+(m.dir==='out'?' (bot)':'');t.className='when';t.textContent=new Date(m.at).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});x.className='txt';x.textContent=m.text||'';
 h.appendChild(w);h.appendChild(t);b.appendChild(h);b.appendChild(x);
 (m.files||[]).forEach(function(f){var d=document.createElement('div');if(f.url){var a=document.createElement('a');a.href=f.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent='📎 '+f.name;a.style.textDecoration='underline';d.appendChild(a);}else{d.textContent='📎 '+f.name;}b.appendChild(d);});
 r.appendChild(av);r.appendChild(b);return r;}
async function poll(){try{var r=await fetch('/dashboard/dm/'+C.uid+'/messages?after='+last,{cache:'no-store'});if(r.redirected){location.reload();return;}var j=await r.json();
 var near=box.scrollHeight-box.scrollTop-box.clientHeight<80;
 if(!last&&!j.messages.length)box.innerHTML='<p class="muted">No messages yet.</p>';
 else if(j.messages.length&&!last)box.innerHTML='';
 j.messages.forEach(function(m){box.appendChild(row(m));last=Math.max(last,m.id);});
 if(j.messages.length&&(near||j.messages.length===box.children.length))box.scrollTop=box.scrollHeight;}catch(e){}}
document.getElementById('dc-send').addEventListener('click',async function(){var b=this,msg=document.getElementById('dc-msg').value.trim(),fl=[].slice.call(document.getElementById('dc-files').files);
 if(!msg&&!fl.length){showMsg('Nothing to send','Write a message or attach a file.');return;}
 if(fl.length>5){showMsg('Too many files','Attach at most 5 files.');return;}
 var tot=0;fl.forEach(function(f){tot+=f.size;});if(tot>8*1024*1024){showMsg('Too large','Attachments must total 8 MB or less.');return;}
 b.disabled=true;
 try{var files=await Promise.all(fl.map(function(f){return new Promise(function(ok,no){var r=new FileReader();r.onload=function(){ok({name:f.name,data:String(r.result).split(',')[1]});};r.onerror=no;r.readAsDataURL(f);});}));
  var res=await fetch('/dashboard/dm/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[C.uid],message:msg,files:files})});
  var j=await res.json().catch(function(){return {error:'Unexpected response (are you still signed in?)'};});
  if(!res.ok){showMsg('Not sent',j.error||'Failed');}
  else if(j.failed){showMsg('Message failed',(j.errors&&j.errors.length?j.errors.join('\\n'):'Discord did not deliver the message.'));}
  else{document.getElementById('dc-msg').value='';document.getElementById('dc-files').value='';await poll();box.scrollTop=box.scrollHeight;}
 }catch(e){showMsg('Not sent',e.message);}
 b.disabled=false;});
poll();setInterval(poll,3000);
`;

  return { recordInbound, recordOutbound };
};
