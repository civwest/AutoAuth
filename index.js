require("dotenv").config();
const crypto = require("node:crypto");
const express = require("express");
const session = require("express-session");
const { Pool } = require("pg");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ActivityType, MessageFlags } = require("discord.js");

const required = ["BOT_TOKEN","CLIENT_ID","CLIENT_SECRET","REDIRECT_URI","DATABASE_URL","TOKEN_ENCRYPTION_KEY","SESSION_SECRET","DASHBOARD_OWNER1_USER","DASHBOARD_OWNER1_PASSWORD_HASH","DASHBOARD_OWNER2_USER","DASHBOARD_OWNER2_PASSWORD_HASH"];
for (const k of required) if (!process.env[k]) { console.error("Missing Render environment variable:", k); process.exit(1); }
const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "hex");
if (key.length !== 32) { console.error("TOKEN_ENCRYPTION_KEY must be 64 hex characters."); process.exit(1); }

const app = express(), port = Number(process.env.PORT) || 10000;
const pool = new Pool({ connectionString:process.env.DATABASE_URL, ssl:process.env.DATABASE_SSL==="disable" ? false : {rejectUnauthorized:false} });
const PgSession = require("connect-pg-simple")(session);
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
app.use(session({ name:"autoauth.sid", secret:process.env.SESSION_SECRET, resave:false, saveUninitialized:false, rolling:false,
  store:new PgSession({ pool, tableName:"dashboard_sessions", createTableIfMissing:true, ttl:2*60*60 }),
  cookie:{ httpOnly:true, secure:"auto", sameSite:"lax", maxAge:2*60*60*1000 } }));
const client = new Client({ intents:[GatewayIntentBits.Guilds] });
const owners = [
 {user:process.env.DASHBOARD_OWNER1_USER, hash:process.env.DASHBOARD_OWNER1_PASSWORD_HASH},
 {user:process.env.DASHBOARD_OWNER2_USER, hash:process.env.DASHBOARD_OWNER2_PASSWORD_HASH}
];
const states = new Map(), attempts = new Map();

function enc(s) { const iv=crypto.randomBytes(12), c=crypto.createCipheriv("aes-256-gcm",key,iv), b=Buffer.concat([c.update(s,"utf8"),c.final()]); return [iv,c.getAuthTag(),b].map(x=>x.toString("base64")).join("."); }
function dec(s) { const [i,t,b]=s.split("."), d=crypto.createDecipheriv("aes-256-gcm",key,Buffer.from(i,"base64")); d.setAuthTag(Buffer.from(t,"base64")); return Buffer.concat([d.update(Buffer.from(b,"base64")),d.final()]).toString(); }
function equal(a,b) { const x=Buffer.from(String(a)), y=Buffer.from(String(b)); return x.length===y.length && crypto.timingSafeEqual(x,y); }
function verify(pw, h) { try { const [alg,salt,expected]=h.split("$"); if(alg!=="scrypt") return false; const got=crypto.scryptSync(pw,Buffer.from(salt,"hex"),32,{N:16384,r:8,p:1}).toString("hex"); return equal(got,expected); } catch { return false; } }
function esc(s) { return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
const DISCORD_OWNER_LABELS = {
 "1426813617394946068": "Civwest",
 "1481562091520262236": "Jacob"
};
function displayActor(actor) {
 const value = String(actor ?? "system");
 return DISCORD_OWNER_LABELS[value] || value;
}
function displayDetail(detail) {
 let json = JSON.stringify(detail ?? {});
 for (const [id, label] of Object.entries(DISCORD_OWNER_LABELS)) {
   json = json.split(id).join(label);
 }
 return json;
}
async function log(type, detail={}, actor="system") { try { await pool.query("INSERT INTO audit_logs(event_type,actor,detail) VALUES($1,$2,$3)",[type,actor,JSON.stringify(detail)]); } catch(e) { console.error("Log insert failed",e.message); } }
async function schema() {
 await pool.query(`CREATE TABLE IF NOT EXISTS authorized_users(user_id TEXT PRIMARY KEY, username TEXT NOT NULL, access_token_enc TEXT NOT NULL, refresh_token_enc TEXT NOT NULL, expires_at BIGINT NOT NULL, authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS audit_logs(id BIGSERIAL PRIMARY KEY,event_type TEXT NOT NULL,actor TEXT NOT NULL DEFAULT 'system',detail JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS command_stats(command_name TEXT PRIMARY KEY,uses BIGINT NOT NULL DEFAULT 0);
 INSERT INTO command_stats(command_name,uses) VALUES('addusers',0) ON CONFLICT(command_name) DO NOTHING;`);
}
function authUrl() {
 const state=crypto.randomBytes(32).toString("hex"); states.set(state,Date.now()+600000);
 const u=new URL("https://discord.com/oauth2/authorize"); u.searchParams.set("client_id",process.env.CLIENT_ID); u.searchParams.set("response_type","code"); u.searchParams.set("redirect_uri",process.env.REDIRECT_URI); u.searchParams.set("scope","identify guilds.join"); u.searchParams.set("state",state); return u.toString();
}
function deviceFingerprint(req) {
 return crypto.createHash("sha256").update(String(req.get("user-agent")||"unknown")).digest("hex");
}
function logged(req,res,next) {
 if(!req.session.owner) return res.redirect("/login");
 if(!req.session.deviceFingerprint || !equal(req.session.deviceFingerprint,deviceFingerprint(req))) {
   return req.session.destroy(()=>res.redirect("/login?expired=1"));
 }
 next();
}
function verifyOrigin(req,res,next) { const origin=req.get("origin"); if(origin && origin!==`${req.protocol}://${req.get("host")}`) return res.status(403).send("Invalid origin."); next(); }
async function refresh(refreshToken) {
 const r=await fetch("https://discord.com/api/v10/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:process.env.CLIENT_ID,client_secret:process.env.CLIENT_SECRET,grant_type:"refresh_token",refresh_token:refreshToken})});
 const b=await r.json(); if(!r.ok) throw Error(b.error_description||b.error||"Token refresh failed"); return b;
}
async function register() {
 const cmds=[new SlashCommandBuilder().setName("auth").setDescription("Get your AutoAuth account-linking URL"),
 new SlashCommandBuilder().setName("addusers").setDescription("Add all authorized users to this server").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
 new SlashCommandBuilder().setName("adduser").setDescription("Add one previously authorized user to this server")
   .addStringOption(o=>o.setName("user_id").setDescription("Discord user ID to add").setRequired(true).setMinLength(17).setMaxLength(20))
   .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)].map(x=>x.toJSON());
 await new REST({version:"10"}).setToken(process.env.BOT_TOKEN).put(Routes.applicationCommands(process.env.CLIENT_ID),{body:cmds});
}
function shell(tab,owner,content) {
 return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoAuth Dashboard</title><style>
 :root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--muted:#9da7b3;--text:#e6edf3;--accent:#7289da}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px system-ui}a{color:inherit;text-decoration:none}.layout{display:flex;min-height:100vh}.side{width:225px;padding:24px 14px;background:#11161d;border-right:1px solid var(--line);flex-shrink:0}.brand{font-size:20px;font-weight:800;padding:0 12px 24px}.nav a{display:block;padding:12px;border-radius:8px;margin:4px 0;color:var(--muted)}.nav .on,.nav a:hover{background:#222a35;color:white}main{padding:28px;width:100%;max-width:1400px;margin:auto}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin:20px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:18px;margin:14px 0}.metric{font-size:30px;font-weight:800;margin-top:8px}.pill{background:#263c2c;color:#7ee787;border-radius:20px;padding:5px 9px}.off{background:#3c2528;color:#ff938a}button,.btn{background:var(--accent);border:0;border-radius:8px;color:white;padding:10px 14px;font-weight:650;cursor:pointer}button.secondary,.btn.secondary{background:#303843}button.danger{background:#8b3038}input,select{width:100%;padding:10px;margin:6px 0 12px;background:#0d1117;color:white;border:1px solid var(--line);border-radius:8px}label{font-size:13px;color:var(--muted)}.row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.row>div{flex:1;min-width:160px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted)}.wrap{overflow:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}.notice{padding:12px;border:1px solid var(--line);border-radius:8px;color:var(--muted)}@media(max-width:700px){.layout{display:block}.side{width:auto;border-right:0;border-bottom:1px solid var(--line)}.nav{display:flex;flex-wrap:wrap}.nav a{padding:9px}.brand{padding-bottom:10px}main{padding:15px}}
 </style></head><body><div class="layout"><aside class="side"><div class="brand">◈ AutoAuth</div><nav class="nav">
 <a class="${tab==="home"?"on":""}" href="/dashboard">Bot Control</a><a class="${tab==="db"?"on":""}" href="/dashboard/database">Database</a><a class="${tab==="logs"?"on":""}" href="/dashboard/logs">Logs</a></nav><p class="muted" style="margin:28px 12px">Signed in as <b>${esc(owner)}</b></p><form method="post" action="/dashboard/logout"><button class="secondary" style="width:100%">Log out</button></form></aside><main>${content}</main></div></body></html>`;
}
require("./site")(app,client); // public site: /, /info, /tos, /privacy-policy
app.get("/health",(_,res)=>res.send("ok"));
app.get("/auth",(_,res)=>res.redirect(302,authUrl()));
app.get("/oauth/callback",async(req,res)=>{
 const {code,state,error}=req.query;
 if(error){await log("oauth_denied",{error:String(error)});return res.status(400).send("Authorization cancelled or denied.");}
 if(typeof code!=="string"||typeof state!=="string"||!(states.get(state)>Date.now())){await log("oauth_invalid_state");return res.status(400).send("Authorization link expired or invalid. Open /auth and try again.");}
 states.delete(state);
 try{
  const r=await fetch("https://discord.com/api/v10/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:process.env.CLIENT_ID,client_secret:process.env.CLIENT_SECRET,grant_type:"authorization_code",code,redirect_uri:process.env.REDIRECT_URI})});
  const t=await r.json(); if(!r.ok){await log("oauth_exchange_failed",{status:r.status,error:t.error});return res.status(502).send("Discord token exchange failed.");}
  const ur=await fetch("https://discord.com/api/v10/users/@me",{headers:{Authorization:`Bearer ${t.access_token}`}}), u=await ur.json();
  if(!ur.ok||!u.id){await log("oauth_user_fetch_failed",{status:ur.status});return res.status(502).send("Could not retrieve your Discord account.");}
  await pool.query(`INSERT INTO authorized_users(user_id,username,access_token_enc,refresh_token_enc,expires_at,authorized_at) VALUES($1,$2,$3,$4,$5,NOW()) ON CONFLICT(user_id) DO UPDATE SET username=EXCLUDED.username,access_token_enc=EXCLUDED.access_token_enc,refresh_token_enc=EXCLUDED.refresh_token_enc,expires_at=EXCLUDED.expires_at,authorized_at=NOW()`,[u.id,u.global_name||u.username||u.id,enc(t.access_token),enc(t.refresh_token),Date.now()+Number(t.expires_in||604800)*1000]);
  await log("oauth_success",{user_id:u.id,username:u.global_name||u.username});
  res.send("<h1>Discord connected</h1><p>Your account is saved. An admin can run /addusers in a server.</p>");
 }catch(e){await log("oauth_callback_error",{error:e.message});console.error(e);res.status(500).send("OAuth callback failed. Check Render logs.");}
});

app.get("/dashboard/login",(req,res)=>res.redirect(302,"/login"));
app.get("/login",(req,res)=>{
 if(req.session.owner)return res.redirect("/dashboard");
 res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoAuth Login</title><style>body{font:16px system-ui;background:#0d1117;color:#e6edf3}.box{max-width:420px;margin:12vh auto;padding:28px;background:#161b22;border:1px solid #30363d;border-radius:14px}input,button{width:100%;padding:12px;margin:8px 0 14px;box-sizing:border-box;border-radius:8px;border:1px solid #30363d}input{background:#0d1117;color:white}button{background:#7289da;color:white;border:0;cursor:pointer}</style><div class="box"><h1>AutoAuth</h1><p>Owner dashboard login</p>${req.query.error?"<p>Login failed. Check username and password.</p>":""}<form method="post"><label>Username</label><input name="username" autocomplete="username" required><label>Password</label><input type="password" name="password" autocomplete="current-password" required><button>Sign in</button></form></div>`);
});
app.post("/login",async(req,res)=>{
 const ip=req.ip||"unknown", a=attempts.get(ip)||{n:0,until:0};
 if(a.until>Date.now())return res.status(429).send("Too many login attempts. Try again later.");
 const user=String(req.body.username||""),pw=String(req.body.password||"");
 const owner=owners.find(o=>equal(o.user,user)&&verify(pw,o.hash));
 if(!owner){a.n++;if(a.n>=8){a.n=0;a.until=Date.now()+15*60*1000;}attempts.set(ip,a);await log("dashboard_login_failed",{username:user.slice(0,80),ip});return res.redirect(303,"/login?error=1");}
 attempts.delete(ip);req.session.regenerate(async err=>{if(err)return res.status(500).send("Session error");req.session.owner=owner.user;req.session.deviceFingerprint=deviceFingerprint(req);req.session.createdAt=Date.now();await log("dashboard_login_success",{ip,session_ttl_minutes:120,device_bound:true},owner.user);res.redirect(303,"/dashboard");});
});
app.post("/dashboard/logout",logged,async(req,res)=>{const owner=req.session.owner;await log("dashboard_logout",{},owner);req.session.destroy(()=>res.redirect("/"));});

app.get("/dashboard",logged,async(req,res)=>{
 try{
  const [uc,cs,lc]=await Promise.all([pool.query("SELECT COUNT(*)::int n FROM authorized_users"),pool.query("SELECT uses FROM command_stats WHERE command_name='addusers'"),pool.query("SELECT COUNT(*)::int n FROM audit_logs")]);
  const guilds=client.guilds.cache.map(g=>({id:g.id,name:g.name,members:g.memberCount}));
  const presence=client.user?.presence?.status||"offline", activity=client.user?.presence?.activities?.[0];
  const content=`<div class="top"><div><h1>Bot Control</h1><p class="muted">Actual Discord presence and bot statistics</p></div><span class="pill ${client.isReady()?"":"off"}">${client.isReady()?"Gateway connected":"Disconnected"}</span></div>
  <div class="grid"><div class="card"><div class="muted">Discord connection</div><div class="metric">${client.isReady()?"Online":"Offline"}</div></div><div class="card"><div class="muted">Discord presence</div><div class="metric">${esc(presence)}</div><p class="muted">${activity?esc(activity.name):"No activity"}</p></div><div class="card"><div class="muted">Authorized users</div><div class="metric">${uc.rows[0].n}</div></div><div class="card"><div class="muted">/addusers uses</div><div class="metric">${cs.rows[0]?.uses||0}</div></div><div class="card"><div class="muted">Servers</div><div class="metric">${guilds.length}</div></div><div class="card"><div class="muted">Log entries</div><div class="metric">${lc.rows[0].n}</div></div></div>
  <div class="card"><h2>Change Discord presence</h2><p class="muted">These settings change the bot's visible Discord status, not Render's service status.</p><form method="post" action="/dashboard/presence"><div class="row"><div><label>Presence</label><select name="status"><option value="online">Online</option><option value="idle">Idle</option><option value="dnd">Do Not Disturb</option><option value="invisible">Invisible</option></select></div><div><label>Activity</label><select name="kind"><option value="Playing">Playing</option><option value="Listening">Listening</option><option value="Watching">Watching</option><option value="Competing">Competing</option><option value="none">None</option></select></div><div><label>Activity text</label><input name="text" maxlength="128" placeholder="e.g. AutoAuth"></div></div><button>Save presence</button></form></div>
  <div class="card"><div class="top"><h2>Servers</h2><a class="btn secondary" href="/dashboard">Refresh</a></div><div class="wrap"><table><tr><th>Server</th><th>Server ID</th><th>Cached members</th><th style="text-align:right">Action</th></tr>${guilds.map(g=>`<tr><td>${esc(g.name)}</td><td>${esc(g.id)}</td><td>${Number(g.members)||"—"}</td><td style="text-align:right"><form method="post" action="/dashboard/servers/${encodeURIComponent(g.id)}/leave" onsubmit="return confirm('Make AutoAuth leave '+${JSON.stringify(g.name)}+'? This cannot be undone from the dashboard.')"><button class="btn secondary" style="background:#7f1d1d;border-color:#991b1b;color:white">Leave server</button></form></td></tr>`).join("")||"<tr><td colspan=4>Bot is not in any servers.</td></tr>"}</table></div></div>`;
  res.send(shell("home",req.session.owner,content));
 }catch(e){console.error(e);res.status(500).send("Dashboard failed to load.");}
});
app.post("/dashboard/servers/:id/leave",logged,verifyOrigin,async(req,res)=>{
 const guildId=String(req.params.id||"");
 if(!/^\d{17,20}$/.test(guildId)) return res.status(400).send("Invalid server ID.");
 if(!client.isReady()) return res.status(503).send("Discord bot is disconnected.");
 const guild=client.guilds.cache.get(guildId);
 if(!guild) return res.status(404).send("That server was not found in the bot's current server list.");
 const guildName=guild.name;
 try {
   await guild.leave();
   await log("bot_left_server",{guild_id:guildId,guild_name:guildName},req.session.owner);
   return res.redirect(303,"/dashboard");
 } catch(e) {
   await log("bot_leave_server_failed",{guild_id:guildId,guild_name:guildName,error:e.message},req.session.owner);
   console.error("Failed to leave server",e);
   return res.status(500).send("Could not leave that server. Check Render logs.");
 }
});
app.post("/dashboard/presence",logged,verifyOrigin,async(req,res)=>{
 const status=String(req.body.status||"online"),kind=String(req.body.kind||"none"),text=String(req.body.text||"").trim().slice(0,128);
 if(!["online","idle","dnd","invisible"].includes(status))return res.status(400).send("Invalid status.");
 const types={Playing:ActivityType.Playing,Listening:ActivityType.Listening,Watching:ActivityType.Watching,Competing:ActivityType.Competing};
 if(kind!=="none"&&!Object.hasOwn(types,kind))return res.status(400).send("Invalid activity.");
 if(!client.isReady())return res.status(503).send("Discord bot is disconnected.");
 client.user.setPresence({status,activities:kind!=="none"&&text?[{name:text,type:types[kind]}]:[]});
 await log("presence_updated",{status,kind,text},req.session.owner);res.redirect(303,"/dashboard");
});

app.get("/dashboard/database",logged,async(req,res)=>{
 try{
  const q=String(req.query.q||"").slice(0,100),r=await pool.query("SELECT user_id,username,authorized_at FROM authorized_users WHERE user_id ILIKE $1 OR username ILIKE $1 ORDER BY authorized_at DESC LIMIT 300",[`%${q}%`]);
  const content=`<div class="top"><div><h1>Database</h1><p class="muted">Stored linked accounts; tokens are never displayed.</p></div></div><div class="card"><form class="row" method="get"><div><label>Search username or Discord ID</label><input name="q" value="${esc(q)}"></div><div><button>Search</button></div></form><div class="wrap"><table><tr><th>Username</th><th>Discord ID</th><th>Authorized at (UTC)</th><th>Action</th></tr>${r.rows.map(u=>`<tr><td>${esc(u.username)}</td><td>${esc(u.user_id)}</td><td>${esc(new Date(u.authorized_at).toISOString().replace("T"," ").slice(0,19))}</td><td><form method="post" action="/dashboard/database/${encodeURIComponent(u.user_id)}/revoke" onsubmit="return confirm('Revoke saved authorization?')"><button class="danger">Revoke</button></form></td></tr>`).join("")||"<tr><td colspan=4>No records.</td></tr>"}</table></div></div><p class="notice">Revoke deletes the saved OAuth tokens. It does not remove the user from Discord servers they already joined.</p>`;
  res.send(shell("db",req.session.owner,content));
 }catch(e){console.error(e);res.status(500).send("Database view failed.");}
});
app.post("/dashboard/database/:id/revoke",logged,verifyOrigin,async(req,res)=>{
 const id=String(req.params.id),r=await pool.query("DELETE FROM authorized_users WHERE user_id=$1 RETURNING username",[id]);
 await log("authorization_revoked",{user_id:id,username:r.rows[0]?.username||null},req.session.owner);res.redirect(303,"/dashboard/database");
});
app.get("/dashboard/logs",logged,async(req,res)=>{
 try{
  const r=await pool.query("SELECT id,event_type,actor,detail,created_at FROM audit_logs ORDER BY id DESC LIMIT 300");
  const content=`<div class="top"><div><h1>Logs</h1><p class="muted">Latest 300 audit events</p></div></div><div class="card"><div class="wrap"><table><tr><th>Time UTC</th><th>Event</th><th>Actor</th><th>Details</th></tr>${r.rows.map(x=>`<tr><td>${esc(new Date(x.created_at).toISOString().replace("T"," ").slice(0,19))}</td><td>${esc(x.event_type)}</td><td>${esc(displayActor(x.actor))}</td><td><pre>${esc(displayDetail(x.detail))}</pre></td></tr>`).join("")||"<tr><td colspan=4>No log entries yet.</td></tr>"}</table></div></div>`;
  res.send(shell("logs",req.session.owner,content));
 }catch(e){console.error(e);res.status(500).send("Logs failed to load.");}
});

client.once("ready",()=>console.log(`Discord bot logged in as ${client.user.tag}`));
client.on("error",e=>console.error("Discord error",e));
const PRIMARY_OWNER_DISCORD_ID = "1426813617394946068";
client.on("interactionCreate",async i=>{
 if(!i.isChatInputCommand())return;
 if(i.commandName==="auth"){await log("auth_command_used",{user_id:i.user.id,guild_id:i.guildId},i.user.id);return i.reply({content:`Connect your account: ${authUrl()}`,flags:MessageFlags.Ephemeral});}
 if(!["addusers","adduser"].includes(i.commandName))return;
 // Discord application-command default permissions require Administrator.
 // Re-check at runtime as a defense-in-depth permission gate.
 if(!i.inGuild()||!i.guild)return i.reply({content:"Run this in the target server.",flags:MessageFlags.Ephemeral});
 if(!i.memberPermissions?.has("Administrator")) {
   await log("unauthorized_add_command_attempt",{command:i.commandName,user_id:i.user.id,guild_id:i.guildId},i.user.id);
   return i.reply({content:"You need the Administrator permission to use this command.",flags:MessageFlags.Ephemeral});
 }
 await i.deferReply({flags:MessageFlags.Ephemeral});
 if(i.commandName==="adduser") {
   const uid=String(i.options.getString("user_id",true)).trim();
   if(!/^\d{17,20}$/.test(uid))return i.editReply("Invalid Discord user ID.");
   let row;
   try { const q=await pool.query("SELECT * FROM authorized_users WHERE user_id=$1",[uid]); row=q.rows[0]; }
   catch(e) { console.error("Database lookup failed",e); return i.editReply("Database error. Check Render logs."); }
   if(!row)return i.editReply("That user has not authorized AutoAuth yet. They must use /auth and complete authorization first.");
   try {
     let at=dec(row.access_token_enc),rt=dec(row.refresh_token_enc);
     if(Number(row.expires_at)<=Date.now()+60000){const t=await refresh(rt);at=t.access_token;rt=t.refresh_token||rt;await pool.query("UPDATE authorized_users SET access_token_enc=$1,refresh_token_enc=$2,expires_at=$3 WHERE user_id=$4",[enc(at),enc(rt),Date.now()+Number(t.expires_in||604800)*1000,uid]);}
     try { await i.guild.members.fetch(uid); await log("adduser_already_present",{guild_id:i.guildId,guild_name:i.guild.name,target_user_id:uid},i.user.id); return i.editReply(`<@${uid}> is already in **${i.guild.name}**.`); } catch {}
     await i.guild.members.add(uid,{accessToken:at});
     await log("adduser_finished",{guild_id:i.guildId,guild_name:i.guild.name,target_user_id:uid,result:"added"},i.user.id);
     return i.editReply(`Added <@${uid}> to **${i.guild.name}**.`);
   } catch(e) {
     await log("adduser_failed",{guild_id:i.guildId,guild_name:i.guild.name,target_user_id:uid,error:e.message},i.user.id);
     console.warn("Add single user failed",uid,e.message);
     return i.editReply(`Could not add that user. Check that their authorization is valid and the bot has permission to join members.`);
   }
 }
 await pool.query("UPDATE command_stats SET uses=uses+1 WHERE command_name='addusers'");
 await log("addusers_started",{guild_id:i.guildId,guild_name:i.guild.name,admin_id:i.user.id},i.user.id);
 let r;try{r=await pool.query("SELECT * FROM authorized_users ORDER BY authorized_at ASC");}catch(e){return i.editReply("Database error. Check Render logs.");}
 let added=0,already=0,failed=0,examples=[];
 for(const u of r.rows)try{
  let at=dec(u.access_token_enc),rt=dec(u.refresh_token_enc);
  if(Number(u.expires_at)<=Date.now()+60000){const t=await refresh(rt);at=t.access_token;rt=t.refresh_token||rt;await pool.query("UPDATE authorized_users SET access_token_enc=$1,refresh_token_enc=$2,expires_at=$3 WHERE user_id=$4",[enc(at),enc(rt),Date.now()+Number(t.expires_in||604800)*1000,u.user_id]);}
  try{await i.guild.members.fetch(u.user_id);already++;continue;}catch{}
  await i.guild.members.add(u.user_id,{accessToken:at});added++;
 }catch(e){failed++;if(examples.length<5)examples.push(`${u.username} (${u.user_id}): ${String(e.message).slice(0,120)}`);console.warn("Add user failed",u.user_id,e.message);}
 await log("addusers_finished",{guild_id:i.guildId,guild_name:i.guild.name,admin_id:i.user.id,total:r.rows.length,added,already,failed},i.user.id);
 return i.editReply(`Finished for **${i.guild.name}**.\nAdded: **${added}**\nAlready in server: **${already}**\nFailed: **${failed}**${examples.length?"\n\n"+examples.join("\n"):""}`);
});
app.listen(port,"0.0.0.0",()=>console.log(`HTTP server listening on port ${port}`));
(async()=>{try{await schema();await register();await client.login(process.env.BOT_TOKEN);}catch(e){console.error("Startup failed",e);process.exit(1);}})();
setInterval(()=>{for(const [s,t] of states)if(t<Date.now())states.delete(s);},60000).unref();
