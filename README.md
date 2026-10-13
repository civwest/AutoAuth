# AutoAuth

A Discord bot plus website and owner dashboard. People authorize on the website; server admins add them with `/addusers` or `/adduser`; owners manage everything from the dashboard. Hosted on Render with PostgreSQL.

See [UPDATES.md](UPDATES.md) for a description of every feature and recent change.

---

## 1. Nothing personal is hard-coded

No IDs, names, links or invite URLs live in the code. Everything personal comes from Render environment variables (section 3), so the files can stay public and be used as they are. The only files you may want to swap are the images:

| File | What to change |
|---|---|
| `public/bg.webp` | Replace with your own site background photo (same file name). |
| `public/icon.webp` | Replace with your own site icon / favicon (same file name). |
| `env.example` | Reference list of variables only. Never put real values in it. |

## 2. Discord Developer Portal (https://discord.com/developers/applications)

1. **Bot tab:** create the bot and copy the token, which becomes `BOT_TOKEN`. No privileged intents are needed.
2. **General Information:** copy the **Application ID** (`CLIENT_ID`).
3. **OAuth2 tab:** copy the **Client Secret** (`CLIENT_SECRET`).
4. **OAuth2 > Redirects:** add exactly `https://YOUR-SITE/oauth/callback` (for example `https://autoauth.cfd/oauth/callback`). It must match `REDIRECT_URI` character for character.
5. **Installation tab:** enable **User Install** (needed for the DM authorization option) and **Guild Install**.
6. Optionally restrict who can add the bot: untick **Public Bot** on the Bot tab.

## 3. Render setup

1. Create a **PostgreSQL** database on Render. Copy its **Internal Database URL**; this is `DATABASE_URL`.
2. Create a **Web Service** from your GitHub repo.
   - Build command: `yarn` (or `npm install`)
   - Start command: `node index.js`
   - Node 20 or newer.
3. In the web service, open **Environment** and add the variables below.
4. **Custom domain** (optional): web service > Settings > Custom Domains. Add your domain and create the DNS records Render shows. Then set `REDIRECT_URI` to the new domain and update the Discord redirect (step 2.4).

### Environment variables

| Variable | Where to get it |
|---|---|
| `BOT_TOKEN` | Developer Portal > Bot > Reset Token |
| `CLIENT_ID` | Developer Portal > General Information > Application ID |
| `CLIENT_SECRET` | Developer Portal > OAuth2 > Client Secret |
| `REDIRECT_URI` | `https://YOUR-SITE/oauth/callback`. Your site is the address Render shows at the top of the web service (`https://something.onrender.com`) or your custom domain. The public site address and legal text also follow this value. |
| `DATABASE_URL` | Render PostgreSQL > Connections > Internal Database URL |
| `TOKEN_ENCRYPTION_KEY` | 64 hex characters. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. **Never change it later or saved tokens become unreadable.** |
| `SESSION_SECRET` | Any long random string (also signs auth links and captchas). Changing it invalidates in-flight sign-ins. |
| `DASHBOARD_OWNER1_USER` / `DASHBOARD_OWNER2_USER` | Dashboard usernames you choose. |
| `DASHBOARD_OWNER1_PASSWORD_HASH` / `DASHBOARD_OWNER2_PASSWORD_HASH` | scrypt hash in the form `scrypt$<saltHex>$<hashHex>`. See "Dashboard passwords and hashes" below. |
| `OWNER1_DISCORD_ID` / `OWNER2_DISCORD_ID` | Discord user IDs of the two owners (Discord > Settings > Advanced > Developer Mode, then right-click your profile > Copy User ID). Kick-all skips these users and Logs shows them by name. |
| `OWNER1_NAME` / `OWNER2_NAME` | Display names for those owners in Logs. |
| `SITE_OPERATOR` | Name shown in the legal pages and footer as the person running the site (e.g. `Jane Doe`). Defaults to "the site owner". |
| `LINK_DOCS` | URL opened by the Documentation tab (e.g. your GitHub repo). Hidden if unset. |
| `LINK_TIKTOK`, `LINK_YOUTUBE`, `LINK_X`, `LINK_TWITCH`, `LINK_DISCORD` | Footer "Follow the creator" links (`LINK_DISCORD` = your server invite). Each icon is hidden if unset. |
| `DATABASE_SSL` | Optional. Set to `disable` only for a local database. |
| `DISCORD_DOMAIN_VERIFICATION` | Optional. The value Discord shows when you add your domain to your account (looks like `dh=...`). The site serves it at `/.well-known/discord`. |
| `GOOGLE_VERIFICATION_FILE` | Optional (not needed if you verified by DNS). The name of Google's verification file (e.g. `google1234abcd.html`); the site serves it at that path. |
| `GOOGLE_SITE_VERIFICATION` | Optional. The meta-tag content value, as an alternative to the file. |

**Dashboard passwords and hashes.** Each owner needs a password and a matching password hash. You type the password to log in; Render only stores the hash. The easiest way: ask your favorite AI (ChatGPT, Claude, Gemini, etc.) for **2 random passwords and their password hashes** in this format: `scrypt$<saltHex>$<hashHex>` (scrypt, N=16384, r=8, p=1, 32-byte key). Save the passwords somewhere safe, and put each hash into `DASHBOARD_OWNER1_PASSWORD_HASH` and `DASHBOARD_OWNER2_PASSWORD_HASH` in Render.

If you would rather generate one yourself, run this (replace `YOUR_PASSWORD`):

```
node -e "const c=require('crypto');const s=c.randomBytes(16);console.log('scrypt\$'+s.toString('hex')+'\$'+c.scryptSync('YOUR_PASSWORD',s,32,{N:16384,r:8,p:1}).toString('hex'))"
```

Keep real passwords, tokens and hashes out of GitHub.

## 4. First start checklist

- Render logs should show `HTTP server listening`, `Connecting to Discord...`, then `Discord bot logged in as ...`. If you see `Discord login failed`, check `BOT_TOKEN`; the dashboard also has a Retry button.
- The database tables and columns are created automatically.
- Invite the bot with the "Add bot to server" link in the dashboard sidebar.
- Visit `/` (site), `/auth` (authorization), `/optout`, `/login` (dashboard).

## 5. Pages and routes

| Route | Purpose |
|---|---|
| `/` , `/info` | Public home and info pages |
| `/auth` | Authorization page: server joins, DMs, or both, each with an agreement and captcha |
| `/optout` | Self-service opt-out (Discord sign-in, then choose server / DM / everything) |
| `/terms-of-service`, `/privacy-policy` | Legal pages (`/tos` redirects) |
| `/login`, `/dashboard` | Owner dashboard: Bot Control, Users, Servers, DM Users, Logs |
| `/channels/@me`, `/channels/@me/<id>` | Owner-only private chat (no Discord connection needed). Messages are kept in memory only and cleared when the chat is closed. |
| `/users/profile`, `/users/profile/edit` | Owner profiles (picture, name, pronouns, status, about, time zone, links, colour) |
| `/.well-known/discord` | Discord domain verification (set `DISCORD_DOMAIN_VERIFICATION`) |
| `/health` | Plain health check |

## 6. Commands

- `/auth`: link to the website authorization page.
- `/optout [type]`: opt out of `server`, `dm` or everything.
- `/addusers`: Administrator only. Adds all server-authorized users to the server.
- `/adduser user_id`: Administrator only. Adds one authorized user.

## 7. Notes

- Authorizations never expire unless an owner sets an expiry in the dashboard Database tab.
- DMs only arrive if the user's Discord privacy settings allow them.
- The built-in captcha is basic. Cloudflare Turnstile or hCaptcha can be added later.
- Dashboard sessions are stored in PostgreSQL and expire after 2 hours.
