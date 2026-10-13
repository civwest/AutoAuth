// Owner dashboard: Bot Control, Database, DM Users, Logs.
module.exports = function mountDashboard(c) {
  const { roles, app, express, pool, client, esc, log, logged, verifyOrigin, displayActor, displayDetail, ActivityType, core } = c;
  const { OWNER_IDS, isExpired, addUserToGuild, addAllToGuild, kickFromGuild, optOutUser, sendDmTo, connectDiscord, discordState, shutdownBot } = core;

  const EXPIRY = [["30m", "30 minutes"], ["1h", "1 hour"], ["6h", "6 hours"], ["12h", "12 hours"], ["1d", "1 day"], ["7d", "7 days"], ["30d", "30 days"], ["never", "Never"]];
  const INTERVALS = { "30m": "30 minutes", "1h": "1 hour", "6h": "6 hours", "12h": "12 hours", "1d": "1 day", "7d": "7 days", "30d": "30 days" };
  const dmsApi = {};
  const ts = (x) => esc(new Date(x).toISOString().replace("T", " ").slice(0, 19));

  // ---------- layout ----------
  const CSS = `
 :root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--muted:#9da7b3;--text:#e6edf3;--accent:#7289da}*{box-sizing:border-box}html{scrollbar-gutter:stable}html.lock,html:has(dialog[open]){overflow:hidden}body{margin:0;background:var(--bg);color:var(--text);font:15px system-ui}a{color:inherit;text-decoration:none}.layout{display:flex;min-height:100vh}.side{display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto;align-self:flex-start;width:225px;padding:24px 14px;background:#11161d;border-right:1px solid var(--line);flex-shrink:0}.brand{font-size:20px;font-weight:800;padding:0 12px 24px}.nav a{display:block;padding:12px;border-radius:8px;margin:4px 0;color:var(--muted)}.nav .on,.nav a:hover{background:#222a35;color:white}main{padding:28px;width:100%;max-width:1400px;margin:auto}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:20px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:18px;margin:14px 0}.metric{font-size:30px;font-weight:800;margin-top:8px}.pill{background:#263c2c;color:#7ee787;border-radius:20px;padding:5px 9px}.off{background:#3c2528;color:#ff938a}button,.btn{background:var(--accent);border:0;border-radius:8px;color:white;padding:10px 14px;font:inherit;font-weight:650;cursor:pointer}button.secondary,.btn.secondary{background:#303843}button.danger{background:#8b3038}button.green{background:#1f8a43}button:disabled{opacity:.45;cursor:not-allowed}input,select,textarea{width:100%;padding:10px;margin:6px 0 12px;background:#0d1117;color:white;border:1px solid var(--line);border-radius:8px;font:inherit}textarea{min-height:120px;resize:vertical}label{font-size:13px;color:var(--muted)}.row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.row>div{flex:1;min-width:160px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted)}.wrap{overflow:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}.notice{padding:12px;border:1px solid var(--line);border-radius:8px;color:var(--muted)}.flash{padding:12px 14px;border:1px solid #2f6f45;background:#16301f;border-radius:10px;margin:0 0 16px;color:#b6f0c8}
 dialog{background:#161b22;color:var(--text);border:1px solid var(--line);border-radius:14px;padding:22px;width:min(640px,92vw);max-height:84vh;overflow:auto}dialog::backdrop{background:rgba(0,0,0,.65)}.dlg-list{max-height:48vh;overflow:auto;margin:12px 0}.dlg-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}.dlg-row form{margin:0}.dlg-top{display:flex;justify-content:space-between;align-items:center;gap:12px}.opt-actions{display:flex;flex-direction:column;gap:10px;margin-top:14px}
 .card.lk{position:relative;min-height:150px;background:rgba(140,148,160,.22);border-color:rgba(140,148,160,.35)}.card.lk>*:not(.ov){pointer-events:none;filter:grayscale(1);opacity:.35;user-select:none}.ov{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:12px;text-align:center;border-radius:13px;background:rgba(13,17,23,.5);z-index:2}.ov p{margin:0;font-weight:650}.ov form{margin:0}.ov button{padding:8px 16px}.flash-dlg p{margin:12px 0 4px;white-space:pre-wrap}
 .chat{display:flex;flex-direction:column;height:calc(100vh - 150px);min-height:380px}.msgs{flex:1;overflow-y:auto;padding:6px 2px}.msg{display:flex;gap:10px;margin:12px 0;align-items:flex-start}.msg .av{flex-shrink:0}.msg .who{font-weight:700;margin-right:8px}.msg .when{color:var(--muted);font-size:12px}.msg .txt{white-space:pre-wrap;word-break:break-word}.av{width:40px;height:40px;border-radius:50%;background:#222a35;object-fit:cover;display:flex;align-items:center;justify-content:center;font-weight:800;color:white;overflow:hidden}.av.lg{width:96px;height:96px;font-size:34px}.composer{display:flex;gap:10px;margin-top:10px}.composer textarea{flex:1;min-height:46px;max-height:140px;resize:vertical}.dmrow{display:flex;align-items:center;gap:12px;padding:12px;border-radius:10px;border:1px solid var(--line);margin:8px 0;background:#11161d}.dmrow:hover{background:#1a2230}.banner{height:90px;border-radius:12px 12px 0 0;margin:-18px -18px 0}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#6b7280;margin-right:6px}.dot.on{background:#3ba55d}
 .acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}td.actcell{text-align:right;min-width:230px;max-width:430px}.acts button{padding:8px 12px}.badge{display:inline-block;border-radius:20px;padding:2px 9px;font-size:12px;background:#263c2c;color:#7ee787;margin:0 4px 4px 0}.badge.dm{background:#1f2f4d;color:#8fb4ff}.badge.none{background:#3c2528;color:#ff938a}.dm-status{margin-top:10px}
 @media(max-width:700px){.layout{display:block}.side{position:static;height:auto;width:auto;border-right:0;border-bottom:1px solid var(--line)}.nav{display:flex;flex-wrap:wrap}.nav a{padding:9px}.brand{padding-bottom:10px}main{padding:15px}}`;

  // Client-side helpers (no template literals on purpose, this string is embedded in a template).
  const CLIENT_JS = `
var $=function(id){return document.getElementById(id);};
function openDlg(id){var d=$(id);if(!d)return;document.documentElement.classList.add('lock');d.showModal();}
function closeAll(){var o=document.querySelectorAll('dialog[open]');for(var i=0;i<o.length;i++)o[i].close();}
document.addEventListener('close',function(){if(!document.querySelector('dialog[open]'))document.documentElement.classList.remove('lock');},true);
var AA={servers:[],users:[]};try{AA=JSON.parse($('aa-data').textContent);}catch(e){}
function userById(id){for(var i=0;i<AA.users.length;i++)if(AA.users[i].user_id===id)return AA.users[i];return null;}
function mk(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;}
function pickServer(o){
 $('ps-title').textContent=o.title;$('ps-desc').textContent=o.desc;
 var list=$('ps-list');list.innerHTML='';
 if(!AA.connected)list.textContent='The bot is not connected to Discord right now, so servers cannot be listed. Use Retry on the Bot Control page and check the Render logs.';else if(!AA.servers.length)list.textContent='The bot is not in any servers.';
 AA.servers.forEach(function(g){
  var row=mk('div','dlg-row'),info=mk('div');info.appendChild(mk('b','',g.name));
  info.appendChild(mk('div','muted',g.id+' · '+(g.members||'—')+' members')).style.fontSize='12px';
  if(g.status)info.appendChild(mk('div','muted',g.status)).style.fontSize='12px';
  var f=mk('form');f.method='post';f.action=o.action(g);f.onsubmit=function(){return confirm(o.confirm(g));};
  var b=mk('button',o.cls||'',o.button);b.type='submit';f.appendChild(b);row.appendChild(info);row.appendChild(f);list.appendChild(row);
 });
 closeAll();openDlg('dlg-pickserver');
}
function pickUser(o){
 $('pu-title').textContent=o.title;$('pu-desc').textContent=o.desc;$('pu-search').value='';
 var list=$('pu-list');list.innerHTML='';
 var users=AA.users.filter(o.filter||function(){return true;});
 if(!users.length)list.textContent=o.empty||'No users.';
 users.forEach(function(u){
  var row=mk('div','dlg-row'),info=mk('div');info.appendChild(mk('b','',u.username));info.appendChild(mk('div','muted',u.user_id)).style.fontSize='12px';
  row.dataset.s=(u.username+' '+u.user_id).toLowerCase();
  var b=mk('button',o.cls||'',o.button);b.type='button';b.onclick=function(){o.pick(u);};
  row.appendChild(info);row.appendChild(b);list.appendChild(row);
 });
 closeAll();openDlg('dlg-pickuser');
}
function filterUsers(){var v=$('pu-search').value.toLowerCase(),r=$('pu-list').children;for(var i=0;i<r.length;i++)r[i].style.display=((r[i].dataset.s||'').indexOf(v)>-1)?'':'none';}
function quickAdd(){pickServer({title:'Add users to a server',desc:'Adds every authorized user who allowed server joins and is not already in the server.',button:'Add all users',cls:'green',action:function(g){return '/dashboard/servers/'+g.id+'/addusers';},confirm:function(g){return 'Add all authorized users to '+g.name+'?';}});}
function addToServer(id){var u=userById(id);if(!u)return;pickServer({title:'Add '+u.username+' to a server',desc:'Choose the server to add this member to.',button:'Add',cls:'green',action:function(g){return '/dashboard/servers/'+g.id+'/users/'+id+'/add';},confirm:function(g){return 'Add '+u.username+' to '+g.name+'?';}});}
function kickOne(id){var u=userById(id);if(!u)return;pickServer({title:'Remove '+u.username+' from a server',desc:'Kicks this member from the chosen server. The bot needs Kick Members or Administrator there.',button:'Remove',cls:'danger',action:function(g){return '/dashboard/servers/'+g.id+'/users/'+id+'/kick';},confirm:function(g){return 'Kick '+u.username+' from '+g.name+'?';}});}
function quickKick(){pickUser({title:'Remove a member',desc:'Choose a member, then the server to remove them from.',button:'Choose',cls:'danger',pick:function(u){kickOne(u.user_id);}});}
function quickKickAll(){pickServer({title:'Remove all members from a server',desc:'Kicks every AutoAuth-authorized member who is in the chosen server. Other members and the owners are not affected.',button:'Remove all',cls:'danger',action:function(g){return '/dashboard/servers/'+g.id+'/kickusers';},confirm:function(g){return 'Kick ALL authorized members from '+g.name+'? This cannot be undone.';}});}
function quickOptOut(){pickUser({title:'Opt out a user',desc:'Choose a user, then what to opt them out of.',button:'Opt out',cls:'danger',pick:function(u){openOptOut(u.user_id);}});}
function openOptOut(id){
 var u=userById(id);if(!u)return;
 $('oo-title').textContent='Opt out '+u.username;$('oo-form').action='/dashboard/users/'+id+'/optout';
 $('oo-info').textContent='Currently allowed: '+((u.server_authorized?'server joins':'')+(u.server_authorized&&u.dm_authorized?' and ':'')+(u.dm_authorized?'direct messages':'')||'nothing')+'.';
 $('oo-server').disabled=!u.server_authorized;$('oo-dm').disabled=!u.dm_authorized;
 closeAll();openDlg('dlg-optout');
}
function openExpiry(id){
 var u=userById(id);if(!u)return;
 $('ex-title').textContent='Edit expiry for '+u.username;$('ex-form').action='/dashboard/users/'+id+'/expiry';
 $('ex-current').textContent=u.auth_expires_at?('Current expiry: '+new Date(u.auth_expires_at).toUTCString()):'Current: never expires (until the user opts out).';
 $('ex-select').value='never';closeAll();openDlg('dlg-expiry');
}
function showMsg(t,m){$('msg-title').textContent=t;$('msg-text').textContent=m;closeAll();openDlg('dlg-msg');}
var dmIds=[];
function openDm(ids,label){dmIds=ids;$('dm-title').textContent='Send a DM to '+label;$('dm-msg').value='';$('dm-files').value='';$('dm-status').textContent='';closeAll();openDlg('dlg-dm');}
async function dmSend(ids,msgId,filesId,statusId,btnId){
 var msg=$(msgId).value.trim(),fl=Array.prototype.slice.call($(filesId).files),st=$(statusId),btn=$(btnId);
 if(!ids.length){st.textContent='Select at least one user.';return;}
 if(!msg&&!fl.length){st.textContent='Write a message or attach a file.';return;}
 if(fl.length>5){st.textContent='Attach at most 5 files.';return;}
 var total=0;fl.forEach(function(f){total+=f.size;});if(total>8*1024*1024){st.textContent='Attachments must total 8 MB or less.';return;}
 btn.disabled=true;st.textContent='Sending…';
 try{
  var files=await Promise.all(fl.map(function(f){return new Promise(function(ok,no){var r=new FileReader();r.onload=function(){ok({name:f.name,data:String(r.result).split(',')[1]});};r.onerror=no;r.readAsDataURL(f);});}));
  var res=await fetch('/dashboard/dm/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:ids,message:msg,files:files})});
  var j=await res.json().catch(function(){return {error:'Unexpected response (are you still signed in?)'};});
  if(!res.ok){st.textContent=j.error||'Failed';}
  else if(j.failed===0){st.textContent='';$(msgId).value='';$(filesId).value='';showMsg('Message sent','Sent to '+j.sent+(j.sent===1?' user.':' users.'));}
  else{st.textContent='';showMsg('Some messages failed',(j.sent?('Sent: '+j.sent+'\n'):'')+'Failed: '+j.failed+((j.errors&&j.errors.length)?'\n'+j.errors.join('\n'):''));}
 }catch(e){st.textContent='Request failed: '+e.message;}
 btn.disabled=false;
}
function dmTabSend(){var ids=[].slice.call(document.querySelectorAll('.dm-check:checked')).map(function(c){return c.value;});dmSend(ids,'dt-msg','dt-files','dt-status','dt-send');}
function dmToggleAll(el){[].slice.call(document.querySelectorAll('.dm-check')).forEach(function(c){c.checked=el.checked;});}
`;

  const offline = () => !client.isReady();
  // Greys a card out while the bot is disconnected; `ov()` adds the in-card "start the bot" overlay.
  const lk = () => (offline() ? " lk" : "");
  const ov = () => offline() ? `<div class="ov"><p>Use this feature by starting the bot first.</p><form method="post" action="/dashboard/discord/retry"><button class="green">Start the bot</button></form></div>` : "";
  function shell(tab, owner, content, flash) {
    const a = (k, href, label) => `<a class="${tab === k ? "on" : ""}" href="${href}">${label}</a>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoAuth Dashboard</title><style>${CSS}</style></head><body><div class="layout"><aside class="side"><div class="brand">◈ AutoAuth</div><nav class="nav">
 ${a("home", "/dashboard", "Bot Control")}${a("db", "/dashboard/users", "Users")}${a("servers", "/dashboard/servers", "Servers")}${a("dm", "/dashboard/dm", "DM Users")}${a("msg", "/channels/@me", "Messages")}${a("roles", "/dashboard/roles", "Linked Roles")}${a("logs", "/dashboard/logs", "Logs")}</nav><p class="muted" style="margin:28px 12px">Signed in as <a href="/users/profile" title="Open your profile" style="text-decoration:underline"><b>${esc(owner)}</b></a></p><form method="post" action="/dashboard/logout"><button class="secondary" style="width:100%">Log out</button></form><a class="muted addbot" style="display:block;margin-top:14px;padding:6px 12px;text-decoration:underline" href="https://discord.com/oauth2/authorize?client_id=${esc(process.env.CLIENT_ID)}&amp;permissions=8&amp;integration_type=0&amp;scope=bot" target="_blank" rel="noopener">Add bot to server</a></aside><main>${content}</main></div><dialog id="dlg-msg" class="flash-dlg"><div class="dlg-top"><h2 id="msg-title" style="margin:0"></h2><button type="button" class="secondary" onclick="closeAll()">Close</button></div><p id="msg-text"></p></dialog><script>${CLIENT_JS}${flash ? `document.addEventListener("DOMContentLoaded",function(){showMsg("Done",${JSON.stringify(String(flash)).replace(/</g, "\\u003c")});});` : ""}</script></body></html>`;
  }
  function render(req, res, tab, content) {
    const flash = req.session.flash; delete req.session.flash;
    res.send(shell(tab, req.session.owner, content, flash));
  }
  const flash = (req, msg) => { req.session.flash = msg; };
  function back(req, def) {
    try { const u = new URL(req.get("referer")); if (u.host === req.get("host") && u.pathname.startsWith("/dashboard")) return u.pathname + u.search; } catch {}
    return def;
  }

  // ---------- background jobs (add all / kick all), keyed by server ----------
  const jobs = new Map();
  const jobText = (id) => { const j = jobs.get(id); if (!j) return ""; if (j.running) return `${j.kind} running…`; if (j.error) return `Last ${j.kind} failed: ${j.error}`; return `Last ${j.kind} by ${j.by}: ${j.text}`; };
  const jobStatus = (id) => { const t = jobText(id); if (!t) return ""; const bad = jobs.get(id)?.error; return `<div class="${bad ? "" : "muted"}" style="font-size:12px;${bad ? "color:#ff938a" : ""}">${esc(t)}</div>`; };
  function runJob(guild, kind, owner, work, fmt, event, extra = {}) {
    jobs.set(guild.id, { running: true, kind, by: owner });
    log(`${event}_started`, { guild_id: guild.id, guild_name: guild.name, source: "dashboard" }, owner);
    (async () => {
      try {
        const result = await work();
        jobs.set(guild.id, { running: false, kind, by: owner, text: fmt(result) });
        await log(`${event}_finished`, { guild_id: guild.id, guild_name: guild.name, source: "dashboard", ...result, ...extra }, owner);
      } catch (e) {
        jobs.set(guild.id, { running: false, kind, by: owner, error: String(e.message).slice(0, 160) });
        await log(`${event}_failed`, { guild_id: guild.id, guild_name: guild.name, source: "dashboard", error: e.message }, owner);
      }
    })();
  }
  function getGuild(req, res) {
    const id = String(req.params.id || req.params.gid || "");
    if (!/^\d{17,20}$/.test(id)) { res.status(400).send("Invalid server ID."); return null; }
    if (!client.isReady()) { flash(req, "The bot is disconnected from Discord. Use Retry on Bot Control."); res.redirect(303, back(req, "/dashboard")); return null; }
    const g = client.guilds.cache.get(id);
    if (!g) { flash(req, "That server was not found in the bot's current server list."); res.redirect(303, back(req, "/dashboard")); return null; }
    return g;
  }
  const validUid = (s) => /^\d{17,20}$/.test(String(s || ""));
  const guildData = () => client.guilds.cache.map((g) => ({ id: g.id, name: g.name, members: g.memberCount, status: jobText(g.id) }));

  // Popups shared by Bot Control and Database. `users` feeds the pickers.
  function popups(users) {
    const data = JSON.stringify({ servers: guildData(), users, connected: client.isReady() }).replace(/</g, "\\u003c");
    const x = '<button type="button" class="secondary" onclick="closeAll()">Close</button>';
    return `<script type="application/json" id="aa-data">${data}</script>
  <dialog id="dlg-pickserver"><div class="dlg-top"><h2 id="ps-title" style="margin:0"></h2>${x}</div><p class="muted" id="ps-desc"></p><div class="dlg-list" id="ps-list"></div></dialog>
  <dialog id="dlg-pickuser"><div class="dlg-top"><h2 id="pu-title" style="margin:0"></h2>${x}</div><p class="muted" id="pu-desc"></p><input id="pu-search" placeholder="Search username or ID" oninput="filterUsers()"><div class="dlg-list" id="pu-list"></div></dialog>
  <dialog id="dlg-optout"><div class="dlg-top"><h2 id="oo-title" style="margin:0"></h2>${x}</div><p class="muted" id="oo-info"></p><p class="muted">Server or DM opt-outs only turn that permission off. Opting out of everything also revokes the authorization with Discord and deletes the saved record and related log entries. Nobody is removed from servers.</p>
   <form id="oo-form" method="post" onsubmit="return confirm('Are you sure?')"><div class="opt-actions"><button name="type" value="server" id="oo-server" class="danger">Opt out of server joins</button><button name="type" value="dm" id="oo-dm" class="danger">Opt out of DMs</button><button name="type" value="all" class="danger">Opt out of everything (delete data)</button></div></form></dialog>
  <dialog id="dlg-expiry"><div class="dlg-top"><h2 id="ex-title" style="margin:0"></h2>${x}</div><p class="muted" id="ex-current"></p><p class="muted">After the expiry time the authorization can no longer be used to add the member to servers. Discord tokens refresh automatically, so Never means it stays valid until the user opts out.</p>
   <form id="ex-form" method="post"><label>Expires after</label><select name="duration" id="ex-select">${EXPIRY.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select><button class="green">Save expiry</button></form></dialog>
  <dialog id="dlg-dm"><div class="dlg-top"><h2 id="dm-title" style="margin:0"></h2>${x}</div><label>Message</label><textarea id="dm-msg" maxlength="2000" placeholder="Write your message"></textarea><label>Attachments (optional, up to 5 files, 8 MB total)</label><input type="file" id="dm-files" multiple><button type="button" id="dm-send" onclick="dmSend(dmIds,'dm-msg','dm-files','dm-status','dm-send')">Send DM</button><div class="muted dm-status" id="dm-status"></div></dialog>`;
  }
  const userRow = (u) => ({ user_id: u.user_id, username: u.username, server_authorized: !!u.server_authorized, dm_authorized: !!u.dm_authorized, auth_expires_at: u.auth_expires_at ? new Date(u.auth_expires_at).toISOString() : null });

  // ---------- Bot Control ----------
  app.get("/dashboard", logged, async (req, res) => {
    try {
      const [uc, cs, lc, n24, n7, oo, fl, recent, ul] = await Promise.all([pool.query("SELECT COUNT(*)::int n FROM authorized_users"), pool.query("SELECT uses FROM command_stats WHERE command_name='addusers'"), pool.query("SELECT COUNT(*)::int n FROM audit_logs"),
        pool.query("SELECT COUNT(*)::int n FROM authorized_users WHERE authorized_at > NOW()-INTERVAL '24 hours'"), pool.query("SELECT COUNT(*)::int n FROM authorized_users WHERE authorized_at > NOW()-INTERVAL '7 days'"),
        pool.query("SELECT COUNT(*)::int n FROM audit_logs WHERE event_type='user_opted_out'"), pool.query("SELECT COUNT(*)::int n FROM audit_logs WHERE event_type='dashboard_login_failed' AND created_at > NOW()-INTERVAL '24 hours'"),
        pool.query("SELECT event_type,actor,created_at FROM audit_logs ORDER BY id DESC LIMIT 8"), pool.query("SELECT user_id,username,server_authorized,dm_authorized,auth_expires_at FROM authorized_users ORDER BY authorized_at DESC LIMIT 500")]);
      const up = process.uptime(), upText = `${Math.floor(up / 86400)}d ${Math.floor(up % 86400 / 3600)}h ${Math.floor(up % 3600 / 60)}m`, ping = client.ws.ping >= 0 ? Math.round(client.ws.ping) + " ms" : "—", mem = Math.round(process.memoryUsage().rss / 1048576) + " MB";
      const guilds = client.guilds.cache.map((g) => ({ id: g.id, name: g.name, members: g.memberCount, joined: g.joinedAt }));
      const presence = client.user?.presence?.status || "offline", activity = client.user?.presence?.activities?.[0], ready = client.isReady();
      const retry = ready ? "" : `<form method="post" action="/dashboard/discord/retry" style="display:inline-block;margin:0"><button class="btn">${discordState.paused ? "Start bot" : "Retry"}</button></form>`;
      const content = `<div class="top"><div><h1>Bot Control</h1><p class="muted">Actual Discord presence and bot statistics</p></div><div class="row" style="align-items:center;gap:10px;flex-wrap:wrap"><span class="pill ${ready ? "" : "off"}">${ready ? "Gateway connected" : discordState.paused ? "Shut down" : "Disconnected"}</span>${retry}<form method="post" action="/dashboard/shutdown" style="display:inline-block;margin:0" onsubmit="return confirm('Shut down the Discord bot? The website and dashboard stay up. Use Start bot to bring it back.')"><button class="danger"${ready ? "" : " disabled"}>Shut down bot</button></form><form method="post" action="/dashboard/restart" style="display:inline-block;margin:0" onsubmit="return confirm('Restart the whole service? The site, dashboard and bot will be unavailable for about a minute.')"><button class="secondary">Restart service</button></form></div></div>
  ${!ready && discordState.lastError ? `<p class="muted">Last connection error: ${esc(discordState.lastError)}</p>` : ""}
  <div class="grid"><div class="card"><div class="muted">Discord connection</div><div class="metric">${ready ? "Online" : "Offline"}</div></div><div class="card"><div class="muted">Discord presence</div><div class="metric">${esc(presence)}</div><p class="muted">${activity ? esc(activity.name) : "No activity"}</p></div><div class="card"><div class="muted">Authorized users</div><div class="metric">${uc.rows[0].n}</div></div><div class="card"><div class="muted">/addusers uses</div><div class="metric">${cs.rows[0]?.uses || 0}</div></div><div class="card"><div class="muted">Servers</div><div class="metric">${guilds.length}</div></div><div class="card"><div class="muted">Log entries</div><div class="metric">${lc.rows[0].n}</div></div><div class="card"><div class="muted">Uptime</div><div class="metric">${upText}</div></div><div class="card"><div class="muted">Gateway latency</div><div class="metric">${ping}</div></div><div class="card"><div class="muted">Memory</div><div class="metric">${mem}</div></div><div class="card"><div class="muted">New authorizations</div><div class="metric">${n24.rows[0].n}</div><p class="muted">last 24h · ${n7.rows[0].n} in 7 days</p></div><div class="card"><div class="muted">Opt-outs</div><div class="metric">${oo.rows[0].n}</div></div><div class="card"><div class="muted">Failed logins (24h)</div><div class="metric">${fl.rows[0].n}</div></div></div>
  <div class="card${lk()}">${ov()}<h2>Quick actions</h2><p class="muted">Add or remove authorized members on a server, or opt a user out. Removing members needs the bot to have Kick Members (the invite asks for Administrator).</p><div style="display:flex;gap:10px;flex-wrap:wrap"><button type="button" class="green" onclick="quickAdd()">Add users to a server</button><button type="button" class="danger" onclick="quickKick()">Remove a member</button><button type="button" class="danger" onclick="quickKickAll()">Remove all members from a server</button><button type="button" class="danger" onclick="quickOptOut()">Opt out a user</button></div></div>
  ${popups(ul.rows.map(userRow))}
  <div class="card${lk()}">${ov()}<h2>Change Discord presence</h2><p class="muted">These settings change the bot's visible Discord status, not Render's service status.</p><form method="post" action="/dashboard/presence"><div class="row"><div><label>Presence</label><select name="status"><option value="online">Online</option><option value="idle">Idle</option><option value="dnd">Do Not Disturb</option><option value="invisible">Invisible</option></select></div><div><label>Activity</label><select name="kind"><option value="Playing">Playing</option><option value="Listening">Listening</option><option value="Watching">Watching</option><option value="Competing">Competing</option><option value="none">None</option></select></div><div><label>Activity text</label><input name="text" maxlength="128" placeholder="e.g. AutoAuth"></div></div><button>Save presence</button></form></div>
  <div class="card"><div class="top"><h2>Recent activity</h2><a class="btn secondary" href="/dashboard/logs">All logs</a></div><div class="wrap"><table><tr><th>Time UTC</th><th>Event</th><th>Actor</th></tr>${recent.rows.map((x) => `<tr><td>${ts(x.created_at)}</td><td>${esc(x.event_type)}</td><td>${esc(displayActor(x.actor))}</td></tr>`).join("") || "<tr><td colspan=3>No activity yet.</td></tr>"}</table></div></div>`;
      render(req, res, "home", content);
    } catch (e) { console.error(e); res.status(500).send("Dashboard failed to load."); }
  });

  app.get("/dashboard/servers", logged, (req, res) => {
    const guilds = client.guilds ? client.guilds.cache.map((g) => ({ id: g.id, name: g.name, members: g.memberCount, joined: g.joinedAt })) : [];
    const content = `<div class="top"><div><h1>Servers</h1><p class="muted">Servers the bot is in. Leaving a server cannot be undone from the dashboard.</p></div></div>
  <div class="card${lk()}">${ov()}<div class="top"><h2>Servers</h2><a class="btn secondary" href="/dashboard/servers">Refresh</a></div><div class="wrap"><table><tr><th>Server</th><th>Server ID</th><th>Cached members</th><th>Joined (UTC)</th><th style="text-align:right">Action</th></tr>${guilds.map((g) => `<tr><td>${esc(g.name)}${jobStatus(g.id)}</td><td>${esc(g.id)}</td><td>${Number(g.members) || "—"}</td><td>${g.joined ? esc(new Date(g.joined).toISOString().slice(0, 10)) : "—"}</td><td style="text-align:right;white-space:nowrap"><form method="post" style="display:inline-block" action="/dashboard/servers/${encodeURIComponent(g.id)}/leave" onsubmit="return confirm('Make AutoAuth leave '+${esc(JSON.stringify(g.name))}+'? This cannot be undone from the dashboard.')"><button class="btn secondary" style="background:#7f1d1d;border-color:#991b1b;color:white">Leave server</button></form></td></tr>`).join("") || "<tr><td colspan=5>Bot is not in any servers.</td></tr>"}</table></div></div>`;
    render(req, res, "servers", content);
  });
  app.get("/dashboard/database", (req, res) => res.redirect(301, "/dashboard/users"));
  app.get("/dashboard/database/export.csv", (req, res) => res.redirect(301, "/dashboard/users/export.csv"));

  app.post("/dashboard/discord/retry", logged, verifyOrigin, async (req, res) => {
    if (client.isReady()) flash(req, "Already connected to Discord.");
    else {
      discordState.paused = false;
      await connectDiscord();
      await log("discord_retry", { connected: client.isReady(), error: client.isReady() ? "" : discordState.lastError }, req.session.owner);
      flash(req, client.isReady() ? "Reconnected to Discord." : `Still disconnected${discordState.lastError ? ": " + discordState.lastError : "."}`);
    }
    res.redirect(303, "/dashboard");
  });

  app.post("/dashboard/shutdown", logged, verifyOrigin, async (req, res) => {
    await log("bot_shutdown", {}, req.session.owner);
    await shutdownBot();
    flash(req, "The Discord bot is shut down. The website and dashboard are still running. Use Start bot to bring it back.");
    res.redirect(303, "/dashboard");
  });
  app.post("/dashboard/restart", logged, verifyOrigin, async (req, res) => {
    await log("service_restart", {}, req.session.owner);
    res.send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="20;url=/dashboard"><title>Restarting</title><body style="font:16px system-ui;background:#0d1117;color:#e6edf3;padding:40px"><h1>Restarting AutoAuth…</h1><p>The service will be back in about a minute. This page returns to the dashboard automatically.</p></body>`);
    setTimeout(() => process.exit(0), 500);
  });

  // ---------- server actions ----------
  app.post("/dashboard/servers/:id/addusers", logged, verifyOrigin, (req, res) => {
    const guild = getGuild(req, res); if (!guild) return;
    if (jobs.get(guild.id)?.running) { flash(req, `A job is already running for ${guild.name}.`); return res.redirect(303, back(req, "/dashboard")); }
    runJob(guild, "add", req.session.owner, () => addAllToGuild(guild), (r) => `${r.added} added, ${r.already} already in, ${r.skipped} expired, ${r.failed} failed (of ${r.total})`, "addusers");
    flash(req, `Adding authorized users to ${guild.name}. Refresh to see the result.`);
    res.redirect(303, back(req, "/dashboard"));
  });
  app.post("/dashboard/servers/:id/kickusers", logged, verifyOrigin, async (req, res) => {
    const guild = getGuild(req, res); if (!guild) return;
    if (jobs.get(guild.id)?.running) { flash(req, `A job is already running for ${guild.name}.`); return res.redirect(303, back(req, "/dashboard")); }
    try {
      const r = await pool.query("SELECT user_id FROM authorized_users");
      const ids = r.rows.map((x) => x.user_id).filter((id) => !OWNER_IDS.includes(id)); // never remove the owners
      runJob(guild, "remove", req.session.owner, () => kickFromGuild(guild, ids), (k) => `${k.kicked} removed, ${k.notIn} not in server, ${k.failed} failed`, "kickusers");
      flash(req, `Removing authorized members from ${guild.name}. Refresh to see the result.`);
    } catch (e) { console.error(e); flash(req, "Could not start the removal."); }
    res.redirect(303, back(req, "/dashboard"));
  });
  app.post("/dashboard/servers/:gid/users/:uid/add", logged, verifyOrigin, async (req, res) => {
    const guild = getGuild(req, res); if (!guild) return;
    const uid = String(req.params.uid || ""); if (!validUid(uid)) return res.status(400).send("Invalid user ID.");
    try {
      const q = await pool.query("SELECT * FROM authorized_users WHERE user_id=$1", [uid]);
      if (!q.rows[0]) flash(req, "That user has no saved authorization.");
      else {
        const out = await addUserToGuild(guild, q.rows[0]);
        const msg = { added: `Added ${q.rows[0].username} to ${guild.name}.`, already: `${q.rows[0].username} is already in ${guild.name}.`, skipped_expired: `${q.rows[0].username}'s authorization has expired. Edit the expiry first.`, skipped_no_server: `${q.rows[0].username} did not allow server joins.` }[out];
        flash(req, msg);
        await log(out === "added" ? "adduser_finished" : "adduser_skipped", { guild_id: guild.id, guild_name: guild.name, target_user_id: uid, result: out, source: "dashboard" }, req.session.owner);
      }
    } catch (e) {
      await log("adduser_failed", { guild_id: guild.id, guild_name: guild.name, target_user_id: uid, error: e.message, source: "dashboard" }, req.session.owner);
      flash(req, `Could not add that user: ${String(e.message).slice(0, 120)}`);
    }
    res.redirect(303, back(req, "/dashboard/users"));
  });
  app.post("/dashboard/servers/:gid/users/:uid/kick", logged, verifyOrigin, async (req, res) => {
    const guild = getGuild(req, res); if (!guild) return;
    const uid = String(req.params.uid || ""); if (!validUid(uid)) return res.status(400).send("Invalid user ID.");
    if (OWNER_IDS.includes(uid)) { flash(req, "Owners cannot be removed from the dashboard."); return res.redirect(303, back(req, "/dashboard")); }
    try {
      const r = await kickFromGuild(guild, [uid]);
      flash(req, r.kicked ? `Removed the member from ${guild.name}.` : r.notIn ? `That member is not in ${guild.name}.` : `Could not remove them: ${r.examples[0] || "unknown error"}`);
      await log(r.kicked ? "member_kicked" : "member_kick_failed", { guild_id: guild.id, guild_name: guild.name, target_user_id: uid, source: "dashboard" }, req.session.owner);
    } catch (e) { flash(req, "Could not remove that member."); }
    res.redirect(303, back(req, "/dashboard"));
  });
  app.post("/dashboard/servers/:id/leave", logged, verifyOrigin, async (req, res) => {
    const guild = getGuild(req, res); if (!guild) return;
    const guildName = guild.name;
    try {
      await guild.leave();
      await log("bot_left_server", { guild_id: guild.id, guild_name: guildName }, req.session.owner);
      return res.redirect(303, "/dashboard");
    } catch (e) {
      await log("bot_leave_server_failed", { guild_id: guild.id, guild_name: guildName, error: e.message }, req.session.owner);
      console.error("Failed to leave server", e);
      return res.status(500).send("Could not leave that server. Check Render logs.");
    }
  });
  app.post("/dashboard/presence", logged, verifyOrigin, async (req, res) => {
    const status = String(req.body.status || "online"), kind = String(req.body.kind || "none"), text = String(req.body.text || "").trim().slice(0, 128);
    if (!["online", "idle", "dnd", "invisible"].includes(status)) return res.status(400).send("Invalid status.");
    const types = { Playing: ActivityType.Playing, Listening: ActivityType.Listening, Watching: ActivityType.Watching, Competing: ActivityType.Competing };
    if (kind !== "none" && !Object.hasOwn(types, kind)) return res.status(400).send("Invalid activity.");
    if (!client.isReady()) return res.status(503).send("Discord bot is disconnected.");
    client.user.setPresence({ status, activities: kind !== "none" && text ? [{ name: text, type: types[kind] }] : [] });
    await log("presence_updated", { status, kind, text }, req.session.owner); res.redirect(303, "/dashboard");
  });

  // ---------- user actions ----------
  app.post("/dashboard/users/:id/optout", logged, verifyOrigin, async (req, res) => {
    const uid = String(req.params.id || ""); if (!validUid(uid)) return res.status(400).send("Invalid user ID.");
    const type = ["server", "dm", "all"].includes(req.body.type) ? req.body.type : "all";
    try {
      const r = await optOutUser(uid, type);
      await log("user_opted_out", { note: r.had ? `Owner opted a user out (${type}) from the dashboard${r.deleted ? "; record and related log entries deleted" : ""}.` : "Owner opt-out: no record found.", type }, req.session.owner);
      flash(req, !r.had ? "No record found for that user." : r.deleted ? "User opted out of everything and their data was deleted." : r.changed ? `User opted out of ${type === "server" ? "server joins" : "direct messages"}.` : "Nothing changed; that permission was already off.");
    } catch (e) { console.error("Dashboard opt-out failed", e); flash(req, "Opt-out failed. Check Render logs."); }
    res.redirect(303, back(req, "/dashboard"));
  });
  app.post("/dashboard/users/:id/expiry", logged, verifyOrigin, async (req, res) => {
    const uid = String(req.params.id || ""); if (!validUid(uid)) return res.status(400).send("Invalid user ID.");
    const d = String(req.body.duration || "never");
    if (d !== "never" && !Object.hasOwn(INTERVALS, d)) return res.status(400).send("Invalid duration.");
    try {
      const r = d === "never"
        ? await pool.query("UPDATE authorized_users SET auth_expires_at=NULL WHERE user_id=$1 RETURNING username", [uid])
        : await pool.query("UPDATE authorized_users SET auth_expires_at=NOW()+$2::interval WHERE user_id=$1 RETURNING username", [uid, INTERVALS[d]]);
      await log("expiry_changed", { target_user_id: uid, duration: d }, req.session.owner);
      flash(req, r.rows[0] ? `Expiry for ${r.rows[0].username} set to ${d === "never" ? "never" : INTERVALS[d] + " from now"}.` : "No record found for that user.");
    } catch (e) { console.error(e); flash(req, "Could not change the expiry."); }
    res.redirect(303, back(req, "/dashboard/users"));
  });

  // ---------- Database ----------
  app.get("/dashboard/users", logged, async (req, res) => {
    try {
      const q = String(req.query.q || "").slice(0, 100);
      const [r, tot] = await Promise.all([pool.query("SELECT user_id,username,authorized_at,server_authorized,dm_authorized,auth_expires_at FROM authorized_users WHERE user_id ILIKE $1 OR username ILIKE $1 ORDER BY authorized_at DESC LIMIT 300", [`%${q}%`]), pool.query("SELECT COUNT(*)::int n FROM authorized_users")]);
      const access = (u) => (u.server_authorized ? '<span class="badge">Servers</span>' : "") + (u.dm_authorized ? '<span class="badge dm">DMs</span>' : "") || '<span class="badge none">None</span>';
      const expires = (u) => !u.auth_expires_at ? "Never" : isExpired(u) ? `<span style="color:#ff938a">Expired ${ts(u.auth_expires_at)}</span>` : ts(u.auth_expires_at);
      const content = `<div class="top"><div><h1>Users</h1><p class="muted">Stored linked accounts; tokens are never displayed. Showing ${r.rows.length} of ${tot.rows[0].n}.</p></div><a class="btn secondary" href="/dashboard/users/export.csv">Export CSV</a></div><div class="card"><form class="row" method="get"><div><label>Search username or Discord ID</label><input name="q" value="${esc(q)}"></div><div><button>Search</button></div></form><div class="wrap"><table><tr><th>Username</th><th>Discord ID</th><th>Access</th><th>Authorized at (UTC)</th><th>Expires (UTC)</th><th style="text-align:right">Actions</th></tr>${r.rows.map((u) => `<tr><td>${esc(u.username)}</td><td>${esc(u.user_id)}</td><td>${access(u)}</td><td>${ts(u.authorized_at)}</td><td>${expires(u)}</td><td class="actcell"><div class="acts"><button type="button" class="secondary" onclick="openExpiry('${esc(u.user_id)}')">Edit expiry</button><button type="button" class="green" onclick="addToServer('${esc(u.user_id)}')"${u.server_authorized && !offline() ? "" : " disabled"}${offline() ? " title=\"Start the bot first\"" : ""}>Add to server</button>${u.dm_authorized ? `<button type="button" onclick="openDm(['${esc(u.user_id)}'],'${esc(u.username).replace(/'/g, "&#39;")}')">DM</button>` : ""}<button type="button" class="danger" onclick="openOptOut('${esc(u.user_id)}')">Opt out</button></div></td></tr>`).join("") || "<tr><td colspan=6>No records.</td></tr>"}</table></div></div>${popups(r.rows.map(userRow))}<p class="notice">Opt out lets you turn off server joins, DMs, or everything. Opting out of everything revokes the grant with Discord and deletes the record; nobody is removed from servers. Expiry defaults to Never: tokens refresh automatically and stay valid until the user opts out. The CSV contains usernames, IDs, access and dates only, never tokens.</p>`;
      render(req, res, "db", content);
    } catch (e) { console.error(e); res.status(500).send("Database view failed."); }
  });
  app.get("/dashboard/users/export.csv", logged, async (req, res) => {
    try {
      const r = await pool.query("SELECT user_id,username,authorized_at,server_authorized,dm_authorized,auth_expires_at FROM authorized_users ORDER BY authorized_at DESC");
      const cell = (v) => { let t = String(v ?? ""); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
      const csv = ["user_id,username,authorized_at_utc,server_joins,dms,expires_at_utc", ...r.rows.map((u) => [u.user_id, u.username, new Date(u.authorized_at).toISOString(), u.server_authorized ? "yes" : "no", u.dm_authorized ? "yes" : "no", u.auth_expires_at ? new Date(u.auth_expires_at).toISOString() : "never"].map(cell).join(","))].join("\r\n");
      await log("database_exported", { rows: r.rows.length }, req.session.owner);
      res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="autoauth-users.csv"', "Cache-Control": "no-store" }).send(csv);
    } catch (e) { console.error(e); res.status(500).send("Export failed."); }
  });

  // ---------- DM Users ----------
  app.post("/dashboard/dm/send", logged, verifyOrigin, express.json({ limit: "14mb" }), async (req, res) => {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(String))].filter(validUid).slice(0, 200) : [];
    const message = String(b.message || "").trim();
    if (message.length > 2000) return res.status(400).json({ error: "Message is longer than 2000 characters." });
    const files = [];
    let total = 0;
    for (const f of (Array.isArray(b.files) ? b.files.slice(0, 5) : [])) {
      const buf = Buffer.from(String(f?.data || ""), "base64");
      total += buf.length;
      if (!buf.length) continue;
      files.push({ attachment: buf, name: String(f.name || "file").replace(/[^\w.\- ]/g, "_").slice(0, 80) || "file" });
    }
    if (total > 8 * 1024 * 1024) return res.status(400).json({ error: "Attachments must total 8 MB or less." });
    if (!ids.length) return res.status(400).json({ error: "Select at least one user." });
    if (!message && !files.length) return res.status(400).json({ error: "Write a message or attach a file." });
    if (!client.isReady()) return res.status(503).json({ error: "Discord bot is disconnected." });
    try {
      const ok = await pool.query("SELECT user_id,username FROM authorized_users WHERE user_id = ANY($1) AND dm_authorized UNION SELECT DISTINCT ON (user_id) user_id,username FROM bot_dms WHERE user_id = ANY($1) AND direction='in' ORDER BY 1", [ids]);
      const allowed = new Set(ok.rows.map((x) => x.user_id)), names = new Map(ok.rows.map((x) => [x.user_id, x.username]));
      let sent = 0, failed = 0; const errors = [];
      for (const id of ids) {
        if (!allowed.has(id)) { failed++; if (errors.length < 5) errors.push(`${names.get(id) || id}: has not allowed DMs or messaged the bot`); continue; }
        try {
          await sendDmTo(id, { content: message || undefined, files });
          sent++;
          dmsApi.recordOutbound && await dmsApi.recordOutbound(id, names.get(id), req.session.owner, message, files).catch(() => {});
          await log("dm_sent", { target_user_id: id, chars: message.length, files: files.length }, req.session.owner);
        } catch (e) { failed++; if (errors.length < 5) errors.push(`${names.get(id) || id}: ${e.code === 50007 ? "Discord would not deliver the message (the user blocks DMs from this bot)" : String(e.message).slice(0, 100)}`); }
      }
      res.json({ sent, failed, errors });
    } catch (e) { console.error("DM send failed", e); res.status(500).json({ error: "Could not send. Check Render logs." }); }
  });

  // ---------- Logs ----------
  app.get("/dashboard/logs", logged, async (req, res) => {
    try {
      const type = String(req.query.type || "").slice(0, 60), q = String(req.query.q || "").slice(0, 100), per = 100, page = Math.max(1, Math.min(100000, parseInt(req.query.page, 10) || 1));
      const where = "WHERE ($1='' OR event_type=$1) AND ($2='' OR actor ILIKE $3 OR detail::text ILIKE $3)", args = [type, q, `%${q}%`];
      const [r, cnt, types] = await Promise.all([pool.query(`SELECT id,event_type,actor,detail,created_at FROM audit_logs ${where} ORDER BY id DESC LIMIT ${per} OFFSET ${(page - 1) * per}`, args), pool.query(`SELECT COUNT(*)::int n FROM audit_logs ${where}`, args), pool.query("SELECT DISTINCT event_type FROM audit_logs ORDER BY event_type")]);
      const pages = Math.max(1, Math.ceil(cnt.rows[0].n / per)), link = (p) => `/dashboard/logs?${new URLSearchParams({ type, q, page: String(p) })}`;
      const content = `<div class="top"><div><h1>Logs</h1><p class="muted">${cnt.rows[0].n} matching events · page ${page} of ${pages}</p></div></div><div class="card"><form class="row" method="get"><div><label>Event type</label><select name="type"><option value="">All events</option>${types.rows.map((t) => `<option value="${esc(t.event_type)}"${t.event_type === type ? " selected" : ""}>${esc(t.event_type)}</option>`).join("")}</select></div><div><label>Search actor or details</label><input name="q" value="${esc(q)}"></div><div><button>Filter</button></div></form><div class="wrap"><table><tr><th>Time UTC</th><th>Event</th><th>Actor</th><th>Details</th></tr>${r.rows.map((x) => `<tr><td>${ts(x.created_at)}</td><td>${esc(x.event_type)}</td><td>${esc(displayActor(x.actor))}</td><td><pre>${esc(displayDetail(x.detail))}</pre></td></tr>`).join("") || "<tr><td colspan=4>No log entries match.</td></tr>"}</table></div><div class="row" style="margin-top:14px">${page > 1 ? `<a class="btn secondary" href="${link(page - 1)}">← Newer</a>` : ""}${page < pages ? `<a class="btn secondary" href="${link(page + 1)}">Older →</a>` : ""}</div></div>`;
      render(req, res, "logs", content);
    } catch (e) { console.error(e); res.status(500).send("Logs failed to load."); }
  });

  require("./messages")({ app, pool, express, logged, verifyOrigin, esc, render });
  Object.assign(dmsApi, require("./dms")({ app, pool, client, esc, logged, verifyOrigin, render, lk, ov }));
  roles.mountUi({ app, logged, verifyOrigin, render, lk, ov, esc, client });
  return dmsApi;
};
