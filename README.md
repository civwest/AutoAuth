# AutoAuth

A Discord bot plus website and owner dashboard. People authorize on the website; server admins add them with `/addusers` or `/adduser`; owners manage everything from the dashboard. Hosted on Render with PostgreSQL.

See [UPDATES.md](UPDATES.md) for a description of every feature and recent change.

---

## 1. Nothing personal is hard-coded

No IDs, names, links or invite URLs live in the code. Everything personal comes from Render environment variables (section 3), so the files can stay public and be used as they are. The only files you may want to swap are the images (the site falls back to built-in copies in `embedded-images.js` if `public/` is missing them):

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
| `DASHBOARD_ADMIN1_USER` | Username for the first dashboard login (you choose it, 3 to 32 letters, numbers, `.`, `_` or `-`). See "Dashboard logins" below. |
| `DASHBOARD_ADMIN1_PASSWORD_HASH` | The scrypt hash of that login's password (`scrypt$<salt>$<hash>`). See "Dashboard logins" below. |
| `DASHBOARD_ADMIN1_PERMISSIONS` | What that login may use: `all`, `none`, or a comma list of `bot,users,servers,dm,logs`. Leave it out and the login can only use Messages. Give at least one login `all`. (A login defined with the older `DASHBOARD_OWNERn_USER` / `DASHBOARD_OWNERn_PASSWORD_HASH` names is an owner and has every permission unless you set `PERMISSIONS`.) |
| `DASHBOARD_ADMIN2_USER`, `DASHBOARD_ADMIN2_PASSWORD_HASH`, `DASHBOARD_ADMIN2_PERMISSIONS` | Optional second login. Same three variables, repeated up to `DASHBOARD_ADMIN9_*`. None are required; no login exists unless you add its variables. |
| `OWNER1_DISCORD_ID` / `OWNER2_DISCORD_ID` (optional, up to `OWNER9_`) | Discord user IDs of the owners (Discord > Settings > Advanced > Developer Mode, then right-click your profile > Copy User ID). Kick-all skips these users and Logs shows them by name. |
| `OWNER1_NAME` / `OWNER2_NAME` (optional, same numbers) | Display names for those owners in Logs. |
| `SITE_OPERATOR` | Name shown in the legal pages and footer as the person running the site (e.g. `Jane Doe`). Defaults to "the site owner". |
| `LINK_DOCS` | URL opened by the Documentation tab (e.g. your GitHub repo). Hidden if unset. |
| `LINK_TIKTOK`, `LINK_YOUTUBE`, `LINK_X`, `LINK_TWITCH`, `LINK_DISCORD` | Footer "Follow the creator" links (`LINK_DISCORD` = your server invite). Each icon is hidden if unset. |
| `DATABASE_SSL` | Optional. Set to `disable` only for a local database. |
| `DM_RETENTION_DAYS` | Optional. How many days stored DM chats are kept before automatic deletion (default `30`; `0` keeps them until deleted). |
| `DISCORD_DOMAIN_VERIFICATION` | Optional. The value Discord shows when you add your domain to your account (looks like `dh=...`). The site serves it at `/.well-known/discord`. |
| `GOOGLE_VERIFICATION_FILE` | Optional (not needed if you verified by DNS). The name of Google's verification file (e.g. `google1234abcd.html`); the site serves it at that path. |
| `GOOGLE_SITE_VERIFICATION` | Optional. The meta-tag content value, as an alternative to the file. |

### Dashboard logins

Nothing is premade. To get into the dashboard, add these three variables in Render (example for the first login):

```
DASHBOARD_ADMIN1_USER=jane
DASHBOARD_ADMIN1_PASSWORD_HASH=scrypt$<salt>$<hash>
DASHBOARD_ADMIN1_PERMISSIONS=all
```

Each login uses its own number (`ADMIN1`, `ADMIN2`, ... `ADMIN9`) and needs all three variables. Permission words: `bot` = Bot Control, `users` = Users, `servers` = Servers, `dm` = DM Users, `logs` = Logs. Messages and profiles are open to every login.

**Dashboard passwords and hashes.** Each login needs a password and a matching password hash. You type the password to log in; Render only stores the hash. The easiest way: ask your favorite AI (ChatGPT, Claude, Gemini, etc.) for **a random password and its password hash for each login** in this format: `scrypt$<saltHex>$<hashHex>` (scrypt, N=16384, r=8, p=1, 32-byte key). Save the passwords somewhere safe, and put each hash into that login's `DASHBOARD_ADMINn_PASSWORD_HASH` in Render.

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

## Direct authorization links
These Discord links work from anywhere (a message, a bio, another site). AutoAuth works out what was allowed from the permissions Discord returns, so nothing has to start on the website. Replace `CLIENT_ID` and `YOUR-SITE`; the redirect must be added in Developer Portal > OAuth2 > Redirects.

- Server joins: `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=https%3A%2F%2FYOUR-SITE%2Foauth%2Fcallback&scope=identify+guilds.join+guilds`
- Server joins and DMs: `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=https%3A%2F%2FYOUR-SITE%2Foauth%2Fcallback&integration_type=1&scope=identify+guilds.join+guilds+applications.commands`
- DMs only: `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=https%3A%2F%2FYOUR-SITE%2Foauth%2Fcallback&integration_type=1&scope=identify+guilds+applications.commands`
- Dashboard sign-in with Discord: `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=https%3A%2F%2FYOUR-SITE%2Foauth%2Fcallback&scope=identify+guilds+guilds.members.read`

The dashboard Discord sign-in only works for a Discord account that was linked to a login first: sign in with the password, open Messages > Edit profile (via "Signed in as") and press **Link Discord account**. The login page also has a "Log in with Discord" button. While linked, the Servers tab lists servers where that Discord account has Manage Server or Administrator and the bot is not a member, each with an Add bot button. The account's `guilds` token is stored encrypted for this and is revoked when you unlink. The bot's default status is no activity with the message `YOUR-SITE`.

## 5. Pages and routes

| Route | Purpose |
|---|---|
| `/` , `/info` | Public home and info pages |
| `/auth` | Authorization page: server joins, DMs, or both, each with an agreement and captcha |
| `/optout` | Self-service opt-out (Discord sign-in, then choose server / DM / everything) |
| `/terms-of-service`, `/privacy-policy` | Legal pages (`/tos` redirects) |
| `/login`, `/dashboard` | Owner dashboard: Bot Control, Users, Servers, DM Users, Logs |
| `/channels/<server-id>/<userid>`, `/channels/@dm/<userid>` | Owner view of one DM chat with a person (server id = a server they share with the bot) |
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


**Adding more dashboard users:** open Messages > **Add user** (`/users/add`, only for users with every permission). Type a username and password and tick what they may use (Bot Control, Users, Servers, DM Users, Logs). The page shows the three Render variables to add: `DASHBOARD_ADMINn_USER`, `DASHBOARD_ADMINn_PASSWORD_HASH` and `DASHBOARD_ADMINn_PERMISSIONS` (`all`, `none` or a list like `bot,logs`). Save them in Render and let it redeploy. Every dashboard user can use Messages and message every other user. The password is never stored.
