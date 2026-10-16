require("dotenv").config();
const crypto = require("node:crypto");
const express = require("express");
const session = require("express-session");
const { Pool } = require("pg");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ActivityType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials, ChannelType } = require("discord.js");

const required = ["BOT_TOKEN","CLIENT_ID","CLIENT_SECRET","REDIRECT_URI","DATABASE_URL","TOKEN_ENCRYPTION_KEY","SESSION_SECRET"];
for (const k of required) if (!process.env[k]) { console.error("Missing Render environment variable:", k); process.exit(1); }
// Dashboard logins: DASHBOARD_ADMIN1_USER / DASHBOARD_ADMIN1_PASSWORD_HASH ... up to ADMIN9. The older DASHBOARD_OWNERn_* names still work.
const adminEnv = (n, k) => process.env[`DASHBOARD_ADMIN${n}_${k}`] || process.env[`DASHBOARD_OWNER${n}_${k}`] || "";
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
// The Discord client is re-created on every (re)connect, because a destroyed discord.js client cannot reliably log in again.
// `client` is a stable proxy that always points at the current instance, so other modules never hold a dead client.
let realClient = null, dash = null;
const client = new Proxy({}, { get(_, k) { const v = realClient ? realClient[k] : undefined; return typeof v === "function" ? v.bind(realClient) : v; } });
function freshClient() {
 const c = new Client({ intents:[GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages], partials:[Partials.Channel, Partials.Message],
  // Default status: no activity, just the status message "autoauth.cfd" (the site address from REDIRECT_URI).
  presence:{ status:"online", activities:[{ name:"Custom Status", type:ActivityType.Custom, state:(()=>{ try{ return new URL(process.env.REDIRECT_URI).host; }catch{ return "autoauth.cfd"; } })() }] } });
 c.once("ready",()=>console.log(`Discord bot logged in as ${c.user.tag}`));
 c.on("error",e=>console.error("Discord error",e));
 c.on("interactionCreate",i=>onInteraction(i));
 c.on("messageCreate",m=>{ if(m.author.bot||m.channel.type!==ChannelType.DM) return; if(dash&&dash.recordInbound) dash.recordInbound(m).catch(e=>console.warn("Could not store DM:",e.message)); });
 return c;
}
const ADMIN_PERMS = ["bot","users","servers","dm","logs","projects"];
const owners = [];
for (let n=1;n<=9;n++) {
 const user=adminEnv(n,"USER"), hash=adminEnv(n,"PASSWORD_HASH"); if(!user||!hash) continue;
 // Logins defined with the DASHBOARD_OWNERn_* variables are owners and have full permission (unless PERMISSIONS says otherwise).
 // Logins defined with DASHBOARD_ADMINn_* only get what DASHBOARD_ADMINn_PERMISSIONS lists ("all", "none" or a comma list of bot,users,servers,dm,logs); if it is not set they can only use Messages.
 const isOwner=!process.env[`DASHBOARD_ADMIN${n}_USER`]&&!!process.env[`DASHBOARD_OWNER${n}_USER`];
 const raw=adminEnv(n,"PERMISSIONS").trim().toLowerCase();
 const perms=new Set(raw==="all"||(!raw&&isOwner)?ADMIN_PERMS:raw.split(/[ ,]+/).filter(p=>ADMIN_PERMS.includes(p)));
 owners.push({key:String(n),user,hash,perms});
}
if(!owners.length) console.warn("No dashboard logins are set (DASHBOARD_ADMINn_USER / _PASSWORD_HASH), so nobody can sign in to the dashboard.");
const attempts = new Map();

function enc(s) { const iv=crypto.randomBytes(12), c=crypto.createCipheriv("aes-256-gcm",key,iv), b=Buffer.concat([c.update(s,"utf8"),c.final()]); return [iv,c.getAuthTag(),b].map(x=>x.toString("base64")).join("."); }
function dec(s) { const [i,t,b]=s.split("."), d=crypto.createDecipheriv("aes-256-gcm",key,Buffer.from(i,"base64")); d.setAuthTag(Buffer.from(t,"base64")); return Buffer.concat([d.update(Buffer.from(b,"base64")),d.final()]).toString(); }
function equal(a,b) { const x=Buffer.from(String(a)), y=Buffer.from(String(b)); return x.length===y.length && crypto.timingSafeEqual(x,y); }
function verify(pw, h) { try { const [alg,salt,expected]=h.split("$"); if(alg!=="scrypt") return false; const got=crypto.scryptSync(pw,Buffer.from(salt,"hex"),32,{N:16384,r:8,p:1}).toString("hex"); return equal(got,expected); } catch { return false; } }
function esc(s) { return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
// Owner Discord IDs come from Render variables (OWNER1_DISCORD_ID / OWNER1_NAME, OWNER2_DISCORD_ID / OWNER2_NAME).
const DISCORD_OWNER_LABELS = {};
for (const n of ["1","2","3","4","5","6","7","8","9"]) { const id=(process.env[`OWNER${n}_DISCORD_ID`]||"").trim(); if(/^\d{17,20}$/.test(id)) DISCORD_OWNER_LABELS[id]=process.env[`OWNER${n}_NAME`]||`Owner ${n}`; }
const OWNER_IDS = Object.keys(DISCORD_OWNER_LABELS);
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
 ALTER TABLE authorized_users ADD COLUMN IF NOT EXISTS server_authorized BOOLEAN NOT NULL DEFAULT TRUE;
 ALTER TABLE authorized_users ADD COLUMN IF NOT EXISTS dm_authorized BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE authorized_users ADD COLUMN IF NOT EXISTS auth_expires_at TIMESTAMPTZ;
 CREATE TABLE IF NOT EXISTS audit_logs(id BIGSERIAL PRIMARY KEY,event_type TEXT NOT NULL,actor TEXT NOT NULL DEFAULT 'system',detail JSONB NOT NULL DEFAULT '{}'::jsonb,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS command_stats(command_name TEXT PRIMARY KEY,uses BIGINT NOT NULL DEFAULT 0);
 INSERT INTO command_stats(command_name,uses) VALUES('addusers',0) ON CONFLICT(command_name) DO NOTHING;
 CREATE TABLE IF NOT EXISTS bot_dms(id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, username TEXT, avatar_url TEXT, direction TEXT NOT NULL, sender TEXT, content TEXT NOT NULL DEFAULT '', attachments JSONB NOT NULL DEFAULT '[]'::jsonb, mutual BOOLEAN NOT NULL DEFAULT FALSE, authorized BOOLEAN NOT NULL DEFAULT FALSE, is_read BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 ALTER TABLE bot_dms ADD COLUMN IF NOT EXISTS mutual_guild TEXT;
 DROP TABLE IF EXISTS role_links, role_defs, role_assign, twitch_links;
 CREATE TABLE IF NOT EXISTS side_projects(slug TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config JSONB NOT NULL DEFAULT '{}', created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS side_project_users(slug TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, access_token_enc TEXT, refresh_token_enc TEXT, expires_at BIGINT, scope TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(slug,user_id));
 CREATE TABLE IF NOT EXISTS accounts(id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT, discord_id TEXT UNIQUE, discord_name TEXT, avatar TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_login TIMESTAMPTZ);
 CREATE TABLE IF NOT EXISTS support_messages(id BIGSERIAL PRIMARY KEY, account_id BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, from_admin BOOLEAN NOT NULL, sender TEXT, body TEXT NOT NULL, read_admin BOOLEAN NOT NULL DEFAULT FALSE, read_user BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE INDEX IF NOT EXISTS support_messages_acct ON support_messages(account_id,id);
 CREATE TABLE IF NOT EXISTS project_logs(id BIGSERIAL PRIMARY KEY, slug TEXT NOT NULL, event_type TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE INDEX IF NOT EXISTS project_logs_slug ON project_logs(slug,id);
 CREATE TABLE IF NOT EXISTS dashboard_discord(owner_key TEXT PRIMARY KEY, discord_id TEXT UNIQUE NOT NULL, username TEXT, linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 ALTER TABLE side_projects ADD COLUMN IF NOT EXISTS owner_account BIGINT REFERENCES accounts(id) ON DELETE CASCADE;
 ALTER TABLE side_projects ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE dashboard_discord ADD COLUMN IF NOT EXISTS access_token_enc TEXT;
 ALTER TABLE dashboard_discord ADD COLUMN IF NOT EXISTS refresh_token_enc TEXT;
 ALTER TABLE dashboard_discord ADD COLUMN IF NOT EXISTS expires_at BIGINT;
 CREATE INDEX IF NOT EXISTS bot_dms_user_idx ON bot_dms(user_id, id);
 CREATE TABLE IF NOT EXISTS owner_profiles(owner_key TEXT PRIMARY KEY, display_name TEXT, pronouns TEXT, bio TEXT, status_emoji TEXT, status_text TEXT, accent TEXT, timezone TEXT, links TEXT, avatar BYTEA, avatar_type TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 ALTER TABLE owner_profiles ADD COLUMN IF NOT EXISTS discord TEXT;
 ALTER TABLE owner_profiles ADD COLUMN IF NOT EXISTS banner BYTEA;
 ALTER TABLE owner_profiles ADD COLUMN IF NOT EXISTS banner_type TEXT;
 CREATE TABLE IF NOT EXISTS owner_dms(id TEXT PRIMARY KEY, owner_a TEXT NOT NULL, owner_b TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(owner_a, owner_b));`);
}
function deviceFingerprint(req) {
 return crypto.createHash("sha256").update(String(req.get("user-agent")||"unknown")).digest("hex");
}
// Only same-site paths inside the owner areas may be used as a post-login destination.
function safeNext(v){ v=String(v||""); return /^\/(dashboard|channels\/(?:@me|@dm|\d{17,20})|users\/profile)(?:[\/?#][^\\\s]*)?$/.test(v)&&!v.startsWith("//") ? v : ""; }
function nextParam(req,sep="?"){ const n=req.method==="GET"?safeNext(req.originalUrl):""; return n?`${sep}next=${encodeURIComponent(n)}`:""; }
function logged(req,res,next) {
 if(!req.session.owner) return res.redirect("/login"+nextParam(req));
 if(!req.session.deviceFingerprint || !equal(req.session.deviceFingerprint,deviceFingerprint(req))) {
   return req.session.destroy(()=>res.redirect("/login?expired=1"+nextParam(req,"&")));
 }
 next();
}
function verifyOrigin(req,res,next) { const origin=req.get("origin"); if(origin && origin!==`${req.protocol}://${req.get("host")}`) return res.status(403).send("Invalid origin."); next(); }
async function refresh(refreshToken) {
 const r=await fetch("https://discord.com/api/v10/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:process.env.CLIENT_ID,client_secret:process.env.CLIENT_SECRET,grant_type:"refresh_token",refresh_token:refreshToken})});
 const b=await r.json(); if(!r.ok) throw Error(b.error_description||b.error||"Token refresh failed"); return b;
}

// ---------- shared core logic (used by slash commands and the dashboard) ----------
// An authorization can be given an expiry by the owners; NULL means it never expires (default).
function isExpired(row) { return !!row.auth_expires_at && new Date(row.auth_expires_at).getTime() <= Date.now(); }

async function freshAccessToken(row) {
 let at=dec(row.access_token_enc), rt=dec(row.refresh_token_enc);
 if(Number(row.expires_at)<=Date.now()+60000){
  const t=await refresh(rt); at=t.access_token; rt=t.refresh_token||rt;
  await pool.query("UPDATE authorized_users SET access_token_enc=$1,refresh_token_enc=$2,expires_at=$3 WHERE user_id=$4",[enc(at),enc(rt),Date.now()+Number(t.expires_in||604800)*1000,row.user_id]);
 }
 return at;
}
// Returns "added" | "already" | "skipped_expired" | "skipped_no_server". Throws on API errors.
async function addUserToGuild(guild, row) {
 if(!row.server_authorized) return "skipped_no_server";
 if(isExpired(row)) return "skipped_expired";
 const at=await freshAccessToken(row);
 try{ await guild.members.fetch(row.user_id); return "already"; }catch{}
 await guild.members.add(row.user_id,{accessToken:at});
 return "added";
}
// Adds every saved user who allowed server joins to a guild.
async function addAllToGuild(guild) {
 const r=await pool.query("SELECT * FROM authorized_users WHERE server_authorized ORDER BY authorized_at ASC");
 let added=0,already=0,failed=0,skipped=0,examples=[];
 for(const u of r.rows)try{
  const out=await addUserToGuild(guild,u);
  if(out==="added")added++; else if(out==="already")already++; else skipped++;
 }catch(e){failed++;if(examples.length<5)examples.push(`${u.username} (${u.user_id}): ${String(e.message).slice(0,120)}`);console.warn("Add user failed",u.user_id,e.message);}
 return {total:r.rows.length,added,already,failed,skipped,examples};
}
// Kicks the given user IDs from a guild (requires the bot's Kick Members / Administrator permission).
async function kickFromGuild(guild, ids) {
 let kicked=0,notIn=0,failed=0,examples=[];
 for(const id of ids){
  try{
   const m=await guild.members.fetch(id).catch(()=>null);
   if(!m){notIn++;continue;}
   if(!m.kickable){failed++;if(examples.length<5)examples.push(`${id}: cannot be kicked (server owner or higher role)`);continue;}
   await m.kick("AutoAuth: removed by an owner via the dashboard");
   kicked++;
  }catch(e){failed++;if(examples.length<5)examples.push(`${id}: ${String(e.message).slice(0,100)}`);console.warn("Kick failed",id,e.message);}
 }
 return {total:ids.length,kicked,notIn,failed,examples};
}
// type: "server" | "dm" | "all". Returns {had, changed, deleted}.
function siteOrigin(){try{return new URL(process.env.REDIRECT_URI).origin;}catch{return "https://autoauth.cfd";}}
async function optOutUser(uid, type="all") {
 const q=await pool.query("SELECT refresh_token_enc,server_authorized,dm_authorized FROM authorized_users WHERE user_id=$1",[uid]);
 const row=q.rows[0];
 if(!row) return {had:false,changed:false,deleted:false};
 const full = type==="all" || (type==="server" && !row.dm_authorized) || (type==="dm" && !row.server_authorized);
 if(!full){
  if(type==="server"){await pool.query("UPDATE authorized_users SET server_authorized=FALSE WHERE user_id=$1",[uid]);return {had:true,changed:!!row.server_authorized,deleted:false};}
  await pool.query("UPDATE authorized_users SET dm_authorized=FALSE WHERE user_id=$1",[uid]);return {had:true,changed:!!row.dm_authorized,deleted:false};
 }
 // Full opt-out: revoke the grant at Discord (best effort), delete the record and related log entries.
 try{
  const rt=dec(row.refresh_token_enc);
  await fetch("https://discord.com/api/v10/oauth2/token/revoke",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:process.env.CLIENT_ID,client_secret:process.env.CLIENT_SECRET,token:rt,token_type_hint:"refresh_token"})});
 }catch(e){console.warn("Token revoke failed",e.message);}
 await pool.query("DELETE FROM authorized_users WHERE user_id=$1",[uid]);
 await pool.query("DELETE FROM bot_dms WHERE user_id=$1",[uid]);
 await pool.query("DELETE FROM audit_logs WHERE actor=$1 OR detail->>'user_id'=$1 OR detail->>'target_user_id'=$1",[uid]);
 return {had:true,changed:true,deleted:true};
}
async function sendDmTo(uid, payload) {
 const user=await client.users.fetch(uid);
 await user.send({...payload,allowedMentions:{parse:[]}});
}
async function getStats() {
 const r=await pool.query("SELECT COUNT(*)::int n FROM authorized_users");
 return {servers:client.guilds.cache.size,members:r.rows[0].n};
}

// ---------- Discord connection (a failed login no longer crashes the service; use Retry in the dashboard) ----------
// On startup, check every stored authorization is still valid and fix the access flags.
async function syncAuthorizations() {
 const r=await pool.query("SELECT * FROM authorized_users");
 let ok=0,revoked=0,errors=0;
 for(const u of r.rows){
  try{
   if(u.server_authorized||u.dm_authorized){ await freshAccessToken(u); ok++; }
  }catch(e){
   const m=String(e.message||e);
   if(/invalid_grant|invalid refresh|invalid_request/i.test(m)){ revoked++; await pool.query("UPDATE authorized_users SET server_authorized=false WHERE user_id=$1",[u.user_id]); await log("authorization_revoked_detected",{user_id:u.user_id,dm_kept:!!u.dm_authorized}); }
   else errors++;
  }
 }
 console.log(`Authorization check: ${ok} valid, ${revoked} revoked, ${errors} could not be checked.`);
}
const discordState = { connecting:false, lastError:"", attempted:false, paused:false };
const withTimeout=(p,ms,label)=>Promise.race([p,new Promise((_,r)=>setTimeout(()=>r(new Error(label+" timed out after "+ms/1000+"s")),ms))]);
async function connectDiscord() {
 if(discordState.connecting||client.isReady()||discordState.paused) return;
 discordState.connecting=true;
 try{
  console.log("Connecting to Discord...");
  if(discordState.attempted&&realClient){ const old=realClient; try{ await withTimeout(Promise.resolve(old.destroy()),10000,"destroy"); }catch{} realClient=freshClient(); }
  discordState.attempted=true;
  register().then(()=>console.log("Slash commands registered."),e=>console.warn("Command registration failed:",e.message));
  await withTimeout(client.login(process.env.BOT_TOKEN),45000,"Discord login");
  discordState.lastError="";
 }catch(e){
  discordState.lastError=String(e.message||e).slice(0,200);
  console.error("Discord login failed:",e.message);
 }finally{ discordState.connecting=false; }
}
async function shutdownBot(){ discordState.paused=true; try{ await realClient.destroy(); }catch(e){ console.warn("Shutdown error:",e.message); } }
setInterval(()=>{ if(!client.isReady()&&!discordState.paused) connectDiscord(); },60000).unref(); // automatic retry while disconnected

async function register() {
 const cmds=[new SlashCommandBuilder().setName("auth").setDescription("Open the AutoAuth authorization page"),
 new SlashCommandBuilder().setName("optout").setDescription("Opt out of AutoAuth and delete your stored data")
   .addStringOption(o=>o.setName("type").setDescription("What to opt out of (default: everything)").addChoices({name:"Server joins",value:"server"},{name:"Direct messages",value:"dm"},{name:"Everything (delete my data)",value:"all"})),
 new SlashCommandBuilder().setName("addusers").setDescription("Add all authorized users to this server").setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
 new SlashCommandBuilder().setName("adduser").setDescription("Add one previously authorized user to this server")
   .addStringOption(o=>o.setName("user_id").setDescription("Discord user ID to add").setRequired(true).setMinLength(17).setMaxLength(20))
   .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)].map(x=>x.toJSON());
 await new REST({version:"10"}).setToken(process.env.BOT_TOKEN).put(Routes.applicationCommands(process.env.CLIENT_ID),{body:cmds});
}

// ---------- website + authorization + dashboard ----------
const site=require("./site")(app,client,getStats,()=>discordState); // public site: /, /info, /terms-of-service, /privacy-policy
app.get("/health",(_,res)=>res.send("ok"));
// Discord domain verification (Discord > Settings > Domains asks you to serve this value at /.well-known/discord)
app.get("/.well-known/discord",(req,res)=>{ const v=(process.env.DISCORD_DOMAIN_VERIFICATION||"").trim(); if(!/^dh=[0-9a-f]{20,64}$/i.test(v)) return res.status(404).type("text/plain").send("Not found"); res.type("text/plain").send(v); });
const LOGIN_REDIRECT=(()=>{ try{ return new URL(process.env.LOGIN_REDIRECT_URI||"/login/callback",process.env.REDIRECT_URI).href; }catch{ return ""; } })();
// Dashboard sign-in with Discord: a Discord account can be linked to a dashboard login from the profile edit page.
// Servers the signed-in dashboard user's linked Discord account can add bots to (Manage Server / Administrator / owner), cached for a minute.
const guildCache=new Map();
async function linkedGuilds(ownerUser,force){
 const owner=owners.find(o=>o.user===ownerUser); if(!owner) return {linked:false};
 const hit=guildCache.get(owner.key); if(hit&&!force&&hit.until>Date.now()) return hit.v;
 const row=(await pool.query("SELECT discord_id,username,access_token_enc,refresh_token_enc,expires_at FROM dashboard_discord WHERE owner_key=$1",[owner.key])).rows[0];
 if(!row) return {linked:false};
 let v;
 try{
  if(!row.access_token_enc||!row.refresh_token_enc) throw Object.assign(new Error("relink"),{relink:true});
  let access=dec(row.access_token_enc);
  if(Number(row.expires_at)<Date.now()+60000){
   const b=await refresh(dec(row.refresh_token_enc)); access=b.access_token;
   await pool.query("UPDATE dashboard_discord SET access_token_enc=$2,refresh_token_enc=$3,expires_at=$4 WHERE owner_key=$1",[owner.key,...tokenCols(b)]);
  }
  const r=await fetch("https://discord.com/api/v10/users/@me/guilds",{headers:{Authorization:`Bearer ${access}`}});
  if(r.status===401) throw Object.assign(new Error("relink"),{relink:true});
  if(!r.ok) throw new Error("Discord returned "+r.status);
  const list=await r.json();
  const can=g=>g.owner||((BigInt(g.permissions||0)&0x20n)!==0n)||((BigInt(g.permissions||0)&0x8n)!==0n);
  v={linked:true,username:row.username,guilds:list.filter(can).map(g=>({id:g.id,name:g.name,icon:g.icon}))};
 }catch(e){ v={linked:true,username:row.username,error:e.relink?"Your Discord link expired. Link your account again.":"Could not load your servers from Discord ("+String(e.message).slice(0,60)+").",relink:!!e.relink}; }
 guildCache.set(owner.key,{v,until:Date.now()+60000}); return v;
}
async function unlinkDiscord(ownerKey){
 const row=(await pool.query("DELETE FROM dashboard_discord WHERE owner_key=$1 RETURNING access_token_enc",[ownerKey])).rows[0];
 guildCache.delete(ownerKey);
 if(row&&row.access_token_enc){ try{ await fetch("https://discord.com/api/v10/oauth2/token/revoke",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:process.env.CLIENT_ID,client_secret:process.env.CLIENT_SECRET,token:dec(row.access_token_enc),token_type_hint:"access_token"})}); }catch{} }
}
const tokenCols=t=>[enc(t.access_token),enc(t.refresh_token),Date.now()+Number(t.expires_in||604800)*1000];
async function dashDiscord(req,u,intent,t){
 const name=u.global_name||u.username||u.id;
 if(intent==="link"){
  const owner=owners.find(o=>o.user===(req.session&&req.session.owner));
  if(!owner||!req.session.linkPending||req.session.linkPending<Date.now()) return {status:400,title:"Link expired",error:"Start linking again from your profile while signed in to the dashboard."};
  delete req.session.linkPending;
  try{
   await pool.query("INSERT INTO dashboard_discord(owner_key,discord_id,username,access_token_enc,refresh_token_enc,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_key) DO UPDATE SET discord_id=$2,username=$3,access_token_enc=$4,refresh_token_enc=$5,expires_at=$6,linked_at=NOW()",[owner.key,u.id,name,...tokenCols(t)]);
   guildCache.delete(owner.key);
  }catch(e){ if(e.code==="23505") return {status:409,title:"Already linked",error:"That Discord account is already linked to another dashboard login."}; throw e; }
  await log("dashboard_discord_linked",{discord_id:u.id},owner.user);
  req.session.flash=`Discord account ${name} is now linked. You can sign in with Discord.`;
  const ret=["/dashboard/servers","/users/profile/edit"].includes(req.session.linkReturn)?req.session.linkReturn:"/users/profile/edit"; delete req.session.linkReturn;
  return {redirect:ret};
 }
 const row=(await pool.query("SELECT owner_key FROM dashboard_discord WHERE discord_id=$1",[u.id])).rows[0];
 const owner=row&&owners.find(o=>o.key===row.owner_key);
 if(!owner){ await log("dashboard_discord_login_failed",{discord_id:u.id}); return {status:403,title:"This Discord account is not linked",error:"No dashboard login is linked to this Discord account. Sign in with your username and password, then link Discord on your profile (Edit profile)."}; }
 await pool.query("UPDATE dashboard_discord SET access_token_enc=$2,refresh_token_enc=$3,expires_at=$4,username=$5 WHERE owner_key=$1",[owner.key,...tokenCols(t),name]).catch(()=>{});
 guildCache.delete(owner.key);
 await new Promise((ok,no)=>req.session.regenerate(e=>e?no(e):ok()));
 req.session.owner=owner.user;req.session.deviceFingerprint=deviceFingerprint(req);req.session.createdAt=Date.now();
 await new Promise(ok=>req.session.save(ok));
 await log("dashboard_login_success",{method:"discord",session_ttl_minutes:120,device_bound:true},owner.user);
 return {redirect:"/dashboard"};
}
const projects=require("./projects")({pool,enc,dec,log,express}); projects.mountPublic({app,site}); // /projects/<name>/... and /projects/<user>/<name>/...
const accounts=require("./accounts")({pool,enc,dec,log,express,projects,site,esc}); accounts.mountPublic(app);
require("./auth")(app,{site,pool,enc,log,equal,verifyOrigin,optOutUser,dashDiscord,accountDiscord:accounts.accountDiscord,loginRedirect:LOGIN_REDIRECT}); // /auth, /auth/start, /oauth/callback

const DISCORD_PATH=require("./icons").discord;
function discordLoginUrl(){ const u=new URL("https://discord.com/oauth2/authorize"); u.searchParams.set("client_id",process.env.CLIENT_ID); u.searchParams.set("response_type","code"); u.searchParams.set("redirect_uri",LOGIN_REDIRECT); u.searchParams.set("scope","identify guilds guilds.members.read"); return u.toString(); }
app.get("/dashboard/login",(req,res)=>res.redirect(302,"/login"));
app.get("/login",(req,res)=>{
 if(req.session.owner)return res.redirect(safeNext(req.query.next)||"/dashboard");
 res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoAuth Login</title><style>body{font:16px system-ui;background:#0d1117;color:#e6edf3}.box{max-width:420px;margin:12vh auto;padding:28px;background:#161b22;border:1px solid #30363d;border-radius:14px}input,button{width:100%;padding:12px;margin:8px 0 14px;box-sizing:border-box;border-radius:8px;border:1px solid #30363d}input{background:#0d1117;color:white}button{background:#7289da;color:white;border:0;cursor:pointer}</style><div class="box"><h1>AutoAuth</h1><p>Owner dashboard login</p>${req.query.error?"<p>Login failed. Check username and password.</p>":""}<form method="post"><input type="hidden" name="next" value="${esc(safeNext(req.query.next))}"><label>Username</label><input name="username" autocomplete="username" required><label>Password</label><input type="password" name="password" autocomplete="current-password" required><button>Sign in</button></form><div style="display:flex;align-items:center;gap:10px;color:#9da7b3;font-size:13px;margin:6px 0"><span style="flex:1;height:1px;background:#30363d"></span>or<span style="flex:1;height:1px;background:#30363d"></span></div><a href="${esc(discordLoginUrl())}" style="display:flex;align-items:center;justify-content:center;gap:10px;padding:12px;border-radius:6px;background:#5865F2;color:#fff;text-decoration:none;font-weight:600"><svg viewBox="0 0 24 24" width="22" height="22" fill="#fff" aria-hidden="true"><path d="${DISCORD_PATH}"/></svg>Log in with Discord</a><p style="font-size:13px;color:#9da7b3">Works once your Discord account is linked to your login (Edit profile > Link Discord account).</p></div>`);
});
app.post("/login",async(req,res)=>{
 const ip=req.ip||"unknown", a=attempts.get(ip)||{n:0,until:0};
 if(a.until>Date.now())return res.status(429).send("Too many login attempts. Try again later.");
 const user=String(req.body.username||""),pw=String(req.body.password||"");
 const owner=owners.find(o=>equal(o.user.toLowerCase(),user.trim().toLowerCase())&&verify(pw,o.hash)); // usernames are not case sensitive
 if(!owner){a.n++;if(a.n>=8){a.n=0;a.until=Date.now()+15*60*1000;}attempts.set(ip,a);await log("dashboard_login_failed",{username:user.slice(0,80),ip});return res.redirect(303,"/login?error=1"+(safeNext(req.body.next)?"&next="+encodeURIComponent(safeNext(req.body.next)):""));}
 attempts.delete(ip);req.session.regenerate(async err=>{if(err)return res.status(500).send("Session error");req.session.owner=owner.user;req.session.deviceFingerprint=deviceFingerprint(req);req.session.createdAt=Date.now();await log("dashboard_login_success",{ip,session_ttl_minutes:120,device_bound:true},owner.user);res.redirect(303,safeNext(req.body.next)||"/dashboard");});
});
app.post("/dashboard/logout",logged,async(req,res)=>{const owner=req.session.owner;await log("dashboard_logout",{},owner);req.session.destroy(()=>res.redirect("/"));});

dash=require("./dashboard")({app,express,pool,client,esc,log,logged,verifyOrigin,displayActor,displayDetail,ActivityType,
  core:{projects,accounts,linkedGuilds,unlinkDiscord,admins:owners,ADMIN_PERMS,OWNER_IDS,isExpired,addUserToGuild,addAllToGuild,kickFromGuild,optOutUser,sendDmTo,connectDiscord,discordState,shutdownBot}});

// ---------- Discord events ----------
const onInteraction=async i=>{
 if(!i.isChatInputCommand())return;
 if(i.commandName==="auth"){
  await log("auth_command_used",{user_id:i.user.id,guild_id:i.guildId},i.user.id);
  const url=new URL("/auth",process.env.REDIRECT_URI).href;
  const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open authorization page").setURL(url));
  return i.reply({content:`Authorize AutoAuth on the website: ${url}`,components:[row],flags:MessageFlags.Ephemeral});
 }
 if(i.commandName==="optout"){
   await i.deferReply({flags:MessageFlags.Ephemeral});
   const type=["server","dm","all"].includes(i.options.getString("type"))?i.options.getString("type"):"all";
   try{
     const r=await optOutUser(i.user.id,type);
     if(!r.had)return i.editReply("You have no authorization saved with AutoAuth, so there is nothing to delete. Opt-out page: "+siteOrigin()+"/optout");
     await log("user_opted_out",{note:`A user opted out (${type}).`,type});
     if(!r.deleted) return i.editReply(r.changed
       ?`You have opted out of ${type==="server"?"server joins":"direct messages"}. Your other permission is still active; use /optout with "Everything" to delete your data, or opt out on the website: ${siteOrigin()}/optout`
       :`You had not allowed ${type==="server"?"server joins":"direct messages"}, so nothing changed.`);
     return i.editReply("You have been opted out of everything. Your saved authorization and related log entries were deleted. This does not remove you from servers you already joined. Run /auth any time to link again. You can also opt out on the website: "+siteOrigin()+"/optout");
   }catch(e){console.error("Opt-out failed",e);return i.editReply("Something went wrong while deleting your data. Please try again or ask in the Discord server.");}
 }
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
     const out=await addUserToGuild(i.guild,row);
     if(out==="skipped_no_server") return i.editReply("That user did not allow server joins.");
     if(out==="skipped_expired") return i.editReply("That user's authorization has expired.");
     if(out==="already"){ await log("adduser_already_present",{guild_id:i.guildId,guild_name:i.guild.name,target_user_id:uid},i.user.id); return i.editReply(`<@${uid}> is already in **${i.guild.name}**.`); }
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
 let res;try{res=await addAllToGuild(i.guild);}catch(e){console.error(e);return i.editReply("Database error. Check Render logs.");}
 const {added,already,failed,skipped,examples}=res;
 await log("addusers_finished",{guild_id:i.guildId,guild_name:i.guild.name,admin_id:i.user.id,total:res.total,added,already,failed,skipped},i.user.id);
 return i.editReply(`Finished for **${i.guild.name}**.\nAdded: **${added}**\nAlready in server: **${already}**\nFailed: **${failed}**${skipped?`\nSkipped (expired): **${skipped}**`:""}${examples.length?"\n\n"+examples.join("\n"):""}`);
};
realClient=freshClient();
app.listen(port,"0.0.0.0",()=>console.log(`HTTP server listening on port ${port}`));
(async()=>{
 try{ await schema(); }catch(e){ console.error("Database setup failed",e); process.exit(1); }
 syncAuthorizations().catch(e=>console.warn('Authorization check failed:',e.message));
 await connectDiscord(); // non-fatal: the dashboard shows a Retry button if this fails
})();
