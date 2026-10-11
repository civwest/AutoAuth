require('dotenv').config();
const crypto = require('node:crypto');
const express = require('express');
const { Pool } = require('pg');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const required = ['BOT_TOKEN','CLIENT_ID','CLIENT_SECRET','REDIRECT_URI','DATABASE_URL','TOKEN_ENCRYPTION_KEY'];
for (const key of required) if (!process.env[key]) { console.error(`Missing Render environment variable: ${key}`); process.exit(1); }
const key = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, 'hex');
if (key.length !== 32) { console.error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes).'); process.exit(1); }
const port = Number(process.env.PORT) || 10000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false } });
const app = express();
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const states = new Map();

function encrypt(text) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
function decrypt(value) {
  const [iv, tag, data] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
function authUrl() {
  const state = crypto.randomBytes(32).toString('hex');
  states.set(state, Date.now() + 600000);
  const url = new URL('https://discord.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: process.env.CLIENT_ID, response_type: 'code', redirect_uri: process.env.REDIRECT_URI, scope: 'identify guilds.join', state }).toString();
  return url.toString();
}
async function refresh(refreshToken) {
  const r = await fetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: {'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refreshToken }) });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error_description || body.error || `OAuth refresh failed (${r.status})`);
  return body;
}
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('auth').setDescription('Get your AutoAuth account connection link'),
    new SlashCommandBuilder().setName('addusers').setDescription('Add all AutoAuth-authorized users to this server').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  ].map(x => x.toJSON());
  await new REST({ version: '10' }).setToken(process.env.BOT_TOKEN).put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
  console.log('Registered global /auth and /addusers commands.');
}

app.get('/', (_req, res) => res.type('html').send('<!doctype html><html><meta charset="utf-8"><title>AutoAuth</title><body style="font:16px system-ui;max-width:650px;margin:12vh auto;padding:24px"><h1>AutoAuth</h1><p>Connect your Discord account so an administrator can include it in their server’s /addusers run.</p><a href="/auth">Connect Discord</a></body></html>'));
app.get('/health', (_req, res) => res.status(200).send('ok'));
app.get('/auth', (_req, res) => res.redirect(302, authUrl()));
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send('Discord authorization was cancelled or denied.');
  const expiry = states.get(state); states.delete(state);
  if (typeof code !== 'string' || typeof state !== 'string' || !expiry || expiry < Date.now()) return res.status(400).send('Authorization link expired or invalid. Open /auth and try again.');
  try {
    const tokenRes = await fetch('https://discord.com/api/v10/oauth2/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({ client_id:process.env.CLIENT_ID, client_secret:process.env.CLIENT_SECRET, grant_type:'authorization_code', code, redirect_uri:process.env.REDIRECT_URI }) });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) { console.error('OAuth exchange failed:', tokens.error); return res.status(502).send('Discord authorization could not be completed. Please try again.'); }
    const userRes = await fetch('https://discord.com/api/v10/users/@me', { headers:{ Authorization:`Bearer ${tokens.access_token}` } });
    const user = await userRes.json();
    if (!userRes.ok || !user.id) return res.status(502).send('Could not retrieve your Discord profile. Please try again.');
    await pool.query(`INSERT INTO authorized_users(user_id, username, access_token_enc, refresh_token_enc, expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET username=EXCLUDED.username, access_token_enc=EXCLUDED.access_token_enc, refresh_token_enc=EXCLUDED.refresh_token_enc, expires_at=EXCLUDED.expires_at, authorized_at=NOW()`, [user.id, user.global_name || user.username || user.id, encrypt(tokens.access_token), encrypt(tokens.refresh_token), Date.now() + Number(tokens.expires_in || 604800) * 1000]);
    return res.type('html').send('<!doctype html><html><meta charset="utf-8"><title>Connected</title><body style="font:16px system-ui;max-width:650px;margin:12vh auto;padding:24px"><h1>Discord connected successfully</h1><p>Your account is saved. An administrator can now run <code>/addusers</code> in the server they want authorized users added to.</p>You can close this page.</body></html>');
  } catch (e) { console.error('OAuth callback error:', e.message); return res.status(500).send('AutoAuth could not finish connecting your account. Please try again later.'); }
});

client.once('ready', () => console.log(`Discord bot logged in as ${client.user.tag}`));
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'auth') return interaction.reply({ content: `Connect your account: ${authUrl()}`, ephemeral: true });
  if (interaction.commandName !== 'addusers') return;
  if (!interaction.inGuild() || !interaction.guild) return interaction.reply({ content:'Run this command in the server you want users added to.', ephemeral:true });
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content:'Only server administrators can use this command.', ephemeral:true });
  await interaction.deferReply({ ephemeral:true });
  let rows;
  try { rows = (await pool.query('SELECT * FROM authorized_users ORDER BY authorized_at ASC')).rows; }
  catch (e) { console.error('Database read failed:', e.message); return interaction.editReply('Database error loading authorized users. Check Render logs.'); }
  if (!rows.length) return interaction.editReply('No users have authorized AutoAuth yet. Users can visit the website’s /auth page or use the /auth command.');
  let added=0, already=0, failed=0; const samples=[];
  for (const row of rows) {
    try {
      let access = decrypt(row.access_token_enc), refreshToken = decrypt(row.refresh_token_enc);
      if (Number(row.expires_at) < Date.now()+60000) {
        const fresh = await refresh(refreshToken); access=fresh.access_token; refreshToken=fresh.refresh_token || refreshToken;
        await pool.query('UPDATE authorized_users SET access_token_enc=$1, refresh_token_enc=$2, expires_at=$3 WHERE user_id=$4', [encrypt(access), encrypt(refreshToken), Date.now()+Number(fresh.expires_in || 604800)*1000, row.user_id]);
      }
      try { await interaction.guild.members.fetch(row.user_id); already++; continue; } catch {}
      await interaction.guild.members.add(row.user_id, { accessToken: access }); added++;
    } catch (e) { failed++; console.warn(`Failed to add ${row.user_id} to ${interaction.guildId}:`, e.message); if(samples.length<5) samples.push(`${row.username} (${row.user_id}): ${String(e.message).slice(0,130)}`); }
  }
  let msg=`Finished for **${interaction.guild.name}**.\nAdded: **${added}**\nAlready in server: **${already}**\nFailed: **${failed}**`;
  if(samples.length) msg+='\n\nFirst failures:\n'+samples.map(x=>'• '+x).join('\n');
  return interaction.editReply(msg);
});

async function start() {
  await pool.query(`CREATE TABLE IF NOT EXISTS authorized_users (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, access_token_enc TEXT NOT NULL, refresh_token_enc TEXT NOT NULL, expires_at BIGINT NOT NULL, authorized_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  app.listen(port, '0.0.0.0', () => console.log(`HTTP server listening on port ${port}`));
  await registerCommands();
  await client.login(process.env.BOT_TOKEN);
}
start().catch(e => { console.error('Startup failed:', e); process.exit(1); });
setInterval(() => { for (const [s, t] of states) if (t < Date.now()) states.delete(s); }, 60000).unref();
