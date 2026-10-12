# AutoAuth

A Discord bot plus website and owner dashboard. People authorize on the website; server admins add them with `/addusers` or `/adduser`; owners manage everything from the dashboard. Hosted on Render with PostgreSQL.

See [UPDATES.md](UPDATES.md) for a description of every feature and recent change.

---

## 1. Before you deploy: what to change in the files

Everything personal to the original owner is listed here. Edit these before pushing to GitHub.

| File | Where | What to change |
|---|---|---|
| `index.js` | `DISCORD_OWNER_LABELS` (near the top, ~line 33) | Replace the two Discord **user IDs** and names with your own owners. These IDs are the owners that kick-all skips and that show by name in Logs. Add or remove lines as needed. |
| `site.js` | `LINKS` object (top of file, ~line 8) | `docs` = your GitHub repo URL (the Documentation tab opens it), plus your own `tiktok`, `youtube`, `x`, `twitch` and `discord` invite links used in the footer. |
| `site.js` | `IMAGES` object (~line 17) | Fallback Discord CDN image links. Safe to leave; they are only used if `public/bg.webp` or `public/icon.webp` is missing. |
| `public/bg.webp` | file | Replace with your own background photo (same file name). |
| `public/icon.webp` | file | Replace with your own site icon / favicon (same file name). |
| `site.js` | privacy policy and TOS text (search for "civwest") | The legal text says the project is "run by civwest". Change the name and contact details to yours. |
| `site.js` | `GOOGLE_VERIFICATION_FILE` default, `google955a81d5fc1c3942.html` (~line 275) | Only if you use Google Search Console. Better: set the `GOOGLE_VERIFICATION_FILE` environment variable (see below) instead of editing the file. |
| `dashboard.js` | the "Add bot to server" link in the sidebar (~line 97) | Replace `client_id=1558725033579249816` with **your** Application ID. `permissions=8` is Administrator, which kicking requires. |
| `auth.js` | none | Auth links are built from `CLIENT_ID` and `REDIRECT_URI`; nothing to edit. |
| `env.example` | all values | Reference only. Never commit real values. Set them in Render. |

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
| `DASHBOARD_OWNER1_PASSWORD_HASH` / `DASHBOARD_OWNER2_PASSWORD_HASH` | scrypt hash in the form `scrypt$<saltHex>$<hashHex>`. Generate with the command below. |
| `DATABASE_SSL` | Optional. Set to `disable` only for a local database. |
| `GOOGLE_VERIFICATION_FILE` | Optional. The name of Google's verification file (e.g. `google1234abcd.html`); the site serves it at that path. |
| `GOOGLE_SITE_VERIFICATION` | Optional. The meta-tag content value, as an alternative to the file. |

Generate a password hash (replace `YOUR_PASSWORD`):

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
| `/login`, `/dashboard` | Owner dashboard: Bot Control, Database, DM Users, Logs |
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
