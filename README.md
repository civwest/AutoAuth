# AutoAuth

A Discord bot plus website and owner dashboard. People authorize on the website; server admins add them with `/addusers` or `/adduser`; owners manage everything from the dashboard. Hosted on Render with PostgreSQL.

> **Only download files from the [Releases tab](../../releases).** Each release is a stable version. Downloading any other file from this repository is not recommended and is done at your own risk.

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
4. **OAuth2 > Redirects:** add exactly `https://YOUR-SITE/oauth/callback` (for example `https://autoauth.cfd/oauth/callback`). It must match `REDIRECT_URI` character for character. Also add a second redirect for dashboard sign-in with Discord: `https://YOUR-SITE/login/callback` (it must match `LOGIN_REDIRECT_URI` if you set it).
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
| `LOGIN_REDIRECT_URI` | Optional. Redirect used only for signing in to the dashboard with Discord and linking a Discord account. Defaults to `https://YOUR-SITE/login/callback` (your `REDIRECT_URI` host). Add the same URL under OAuth2 > Redirects in the Developer Portal. |
| `SESSION_SECRET` | Any long random string (also signs auth and opt-out links). Changing it invalidates in-flight sign-ins. |
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
- Dashboard sign-in with Discord (its own callback): `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&response_type=code&redirect_uri=https%3A%2F%2FYOUR-SITE%2Flogin%2Fcallback&scope=identify+guilds+guilds.members.read`

The dashboard Discord sign-in only works for a Discord account that was linked to a login first: sign in with the password, open Messages > Edit profile (via "Signed in as") and press **Link Discord account**. The login page also has a "Log in with Discord" button. While linked, the Servers tab lists servers where that Discord account has Manage Server or Administrator and the bot is not a member, each with an Add bot button. The account's `guilds` token is stored encrypted for this and is revoked when you unlink. The bot's default status is no activity with the message `YOUR-SITE`.

## 5. Pages and routes

| Route | Purpose |
|---|---|
| `/` , `/info` | Public home and info pages |
| `/auth` | Authorization page: server joins, DMs, or both, each with an agreement (no captcha) |
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
- There is no captcha on the authorization agreement; attempts are rate limited per IP.
- Dashboard sessions are stored in PostgreSQL and expire after 2 hours.


**Adding more dashboard users:** open Messages > **Add user** (`/users/add`, only for users with every permission). Type a username and password and tick what they may use (Bot Control, Users, Servers, DM Users, Logs). The page shows the three Render variables to add: `DASHBOARD_ADMINn_USER`, `DASHBOARD_ADMINn_PASSWORD_HASH` and `DASHBOARD_ADMINn_PERMISSIONS` (`all`, `none` or a list like `bot,logs`). Save them in Render and let it redeploy. Every dashboard user can use Messages and message every other user. The password is never stored.


## Dashboard guide

- **Opt out**: server or DM opt-outs only turn that permission off. Opting out of everything revokes the grant with Discord and deletes the saved record and its log entries. People who allowed DMs get a message first. Nobody is removed from servers. *Opt out all* does this for every stored user.
- **Expiry**: after the expiry time a grant can no longer add the member to servers. Tokens refresh automatically, so "Never" stays valid until the user opts out.
- **Quick actions**: removing members needs the bot to have Kick Members.
- **DM Users**: one chat per authorized person. Messages from people who haven't authorized are ignored. Retention is set by `DM_RETENTION_DAYS` (default 30, 0 keeps until deleted).
- **Messages**: private chat between dashboard users, kept in memory only.
- **Add user**: generates three Render variables (`DASHBOARD_ADMINn_USER`, `_PASSWORD_HASH`, `_PERMISSIONS`). Add them in Render > Environment and redeploy.
- **Profile**: link Discord from the profile page to enable "Log in with Discord". Add `<your origin>/login/callback` as a redirect in the Developer Portal (or set `LOGIN_REDIRECT_URI`).

## Side Projects

Dashboard > Side Projects (needs the `projects` permission) creates small Discord-bot web endpoints under `https://<your domain>/projects/<project-name>/...`. Projects are stored in the database (`side_projects`, `side_project_users`), not in environment variables.

| For | URL | Fields |
|---|---|---|
| OAuth callback | `/projects/<name>/oauth/callback` | client ID, client secret, message or redirect, store tokens |
| Interactions endpoint | `/projects/<name>/interactions` | application public key, reply text |
| Webhook events | `/projects/<name>/webhook` | application public key |
| Terms of Service | `/projects/<name>/terms` | title, text |
| Privacy Policy | `/projects/<name>/privacy` | title, text |
| Invite link | `/projects/<name>/invite` | client ID, permissions, scopes |

Use the URL in the matching Developer Portal field (Redirects, Interactions Endpoint URL, Webhook Events URL, Terms of Service URL, Privacy Policy URL). Interactions and webhooks verify Discord's Ed25519 signature with the public key you enter. Client secrets and stored tokens are encrypted with `TOKEN_ENCRYPTION_KEY`.

## Project accounts

Anyone can sign up at `/signup`, with Discord or with a username and password (8+ characters). Discord sign-up uses the same `/login/callback` redirect as dashboard login, and the account takes its username from the Discord account (a number is added if it is taken). Accounts log in on the same `/login` page as the dashboard owners. After signing in they land on `/dashboard/<username>`, a dashboard like the main one without the bot controls:

- **Projects**: create, edit and delete up to 10 projects. Account projects are served at `/projects/<username>/<project-name>/<tab>`, for example `/projects/zed/my-bot/oauth/callback`.
- **Project pages**: Setup (what to enter in the Developer Portal), Users (only when an OAuth project stores users) and Logs.
- **Support**: a chat with the site admins. Admins see it under **Support** (needs the `projects` permission) and every new account appears there.
- **Profile**: display name and the linked Discord account.

Account project data (stored users, tokens, logs) is kept in separate tables (`side_project_users`, `project_logs`) and is never shown in the admin Logs or Side Projects tabs. Admins only see account names in Support. Site admin projects stay under **Side Projects** at `/projects/<name>/...`.

Tables added: `accounts`, `support_messages`, `project_logs`; `side_projects` gains `owner_account` and `locked`.


OAuth and invite projects list every Discord OAuth2 scope. Selecting one shows how to set it up in the project dialog and on the project's Setup page. Scopes marked "needs Discord approval" are restricted by Discord.

### Google and X sign-in

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, and/or `X_CLIENT_ID` and `X_CLIENT_SECRET`. A button appears on `/login`, `/signup` and the account profile only when its pair is set. Add these redirect URIs with each provider:

- Google (Cloud Console > Credentials > OAuth client, Web application): `https://<your domain>/auth/google/callback`
- X (Developer Portal > your app > User authentication settings, OAuth 2.0, confidential client, scopes `users.read tweet.read`): `https://<your domain>/auth/x/callback`

Signing up with a service uses the name on that account as the username. Accounts can also link Discord, Google and X from Profile, change their password, or delete the account (this removes their projects, stored users, data and support messages).

### Data tabs

For OAuth projects, the permissions selected decide which tabs appear on the project's dashboard. Selecting any of them turns on Store users and tokens. Data is encrypted with `TOKEN_ENCRYPTION_KEY`.

| Permission | Tab |
|---|---|
| `identify` | Users (remove a user and their data) |
| `email` | Emails, with CSV download |
| `connections` | Connections |
| `guilds` | Servers |
| `webhook.incoming` | Webhooks (send a message to a user's webhook) |
| `guilds.join` | Add to server (needs the project's bot token; 100 users at a time) |

### Abuse flagging

Applies only to account projects. A project is locked automatically when it adds members to `FLAG_GUILDS_24H` (default 30) different servers within 24 hours, or more than `FLAG_MEMBERS_1H` (default 100) members within an hour. When that happens:

- The project's public endpoints stop working and its dashboard shows it as locked.
- The owner gets a Support message explaining why and that admins cannot see their data.
- Each affected person gets a DM from the bot with an apology and a link to `/report/<id>` to share evidence. The DM only reaches people the bot is allowed to message.
- It appears under **Flags** on the admin Support tab (project name, owner, reason, reports). Admins can unlock it or keep it locked and mark it resolved. Admins never see the project's data.

Tables added: `account_identities`, `project_data`, `project_flags`, `flag_reports`.


## Security

Built in, with nothing to turn on:

- **Rate limiter** (per IP, in memory): 240 requests/min overall, 20/min on login, sign-up and OAuth pages, 90/min for POST requests, 600/min for Discord interaction and webhook endpoints. Over the limit returns 429 with `Retry-After`. An IP that hits a limit 5 times in 10 minutes is blocked for 15 minutes and the block is logged (`security_ip_blocked`). Static images and `/health` are not counted.
- **Login protection**: 8 failed logins per IP, or 5 for one username from one IP, lock that login for 15 minutes. Passwords are hashed with scrypt. Common and guessable account passwords are rejected.
- **Two-step login (TOTP)** for dashboard logins: open your profile, press Set up under Two-step login, scan or enter the secret in an authenticator app, and add the shown variable (`DASHBOARD_ADMINn_TOTP_SECRET`, or `DASHBOARD_OWNERn_TOTP_SECRET`) in Render. Each code works once. The login page has a Code field for it.
- **Headers**: Content-Security-Policy, X-Frame-Options (no framing), nosniff, HSTS, Referrer-Policy, Permissions-Policy and Cross-Origin-Opener-Policy. Private pages are sent with `Cache-Control: no-store`.
- **Host check**: requests for any other host name get 421. Your domain from `REDIRECT_URI` (and `www.`), `localhost` and `*.onrender.com` are allowed. Add more with `ALLOWED_HOSTS` (comma separated).
- **Cross-site POST blocking**: browsers' `Sec-Fetch-Site` and `Origin` are checked on every form and API post.
- **Discord signatures**: interaction and webhook endpoints verify Discord's Ed25519 signature and reject requests older than 5 minutes.
- **Webhook addresses** stored from OAuth must be Discord's own before the server will call them.
- **Slow-request protection** (header, request and keep-alive timeouts), URL length limit, request size limits.
- **Data**: tokens and project data are AES-256-GCM encrypted with `TOKEN_ENCRYPTION_KEY`; accounts and the dashboard use bound, expiring sessions; `/.well-known/security.txt` lists your contact email.
- Startup warns about a short `SESSION_SECRET` or a placeholder `TOKEN_ENCRYPTION_KEY`.

| Variable | Default | Purpose |
|---|---|---|
| `RATE_LIMIT_PER_MIN` | 240 | Requests per IP per minute |
| `RATE_LIMIT_AUTH_PER_MIN` | 20 | Login, sign-up and OAuth pages |
| `RATE_LIMIT_WRITE_PER_MIN` | 90 | POST/PUT/DELETE requests |
| `RATE_LIMIT_HOOK_PER_MIN` | 600 | Discord interaction/webhook endpoints |
| `ALLOWED_HOSTS` | | Extra allowed host names, or `*` to turn the host check off |
| `DASHBOARD_ADMINn_TOTP_SECRET` | | Two-step login secret for that dashboard login |

The rate limiter keeps its counts in memory, so they reset when the service restarts and are not shared if you run more than one instance. Project accounts and dashboard logins can both turn on authenticator-app login from their profile page.

## Plans, billing and receipts

- `/subscribe` shows three plans (Starter has a 14-day free trial) with a 1 / 3 / 6 / 12 month dropdown. Prices are set in CAD; visitors see an estimate in their own currency from a country cookie (`aa_cc`) and a live exchange rate, and Stripe shows the exact amount at checkout.
- Each Subscribe button goes to one of your Stripe Payment Links and adds the account's email (`prefilled_email`) and `client_reference_id`, so the subscription matches the account. Accounts need an email first; the site asks for one.
- Plans only raise limits and add extras (more stored users in our database, more projects, longer log history, priority support). **Google Drive storage is free and identical for everyone.**
- Subscribers get a Billing tab that opens Stripe's customer portal.
- Receipts are emailed from `noreply@` your domain through Resend (`RESEND_API_KEY`, `RECEIPT_FROM`), once per paid invoice.
- Tell the site which product is which tier: add metadata `tier` = `1`, `2` or `3` to each Stripe product (or price), or list the ids in `STRIPE_TIER_<n>_IDS`.
- Stripe webhook: endpoint `https://YOUR-DOMAIN/stripe/webhook`, events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
- Two-step login: after the password or sign-in step, people go to `/login/2fa/<one-time token>`; the code box never appears on the normal login page.

## Under construction

The home page shows this list in a notice at the top. The contact email in the footer defaults to `support@` plus your domain; set `SUPPORT_EMAIL` to change it. When the bot is not connected to Discord, every public page shows an Offline banner at the top.

These parts are not built yet and show "Under construction" where they appear. They are removed from this list when the code is added.

- **Controls for these OAuth permissions** (each selected one gets its own tab that says Under construction): `guilds.members.read`, `bot`, `applications.commands`, `applications.commands.update`, `applications.commands.permissions.update`, `role_connections.write`, `openid`, `applications.entitlements`, and every permission Discord restricts (RPC, relationships, presences, activities, voice, lobbies, SDK, builds, store, messages, DM channels, group DMs).

Built and working: authenticator-app two-step login, Google Drive storage (free for everyone), plans and billing, Discord, Google and X sign-in, project accounts, project dashboards, Support chat, data tabs for `identify`, `email`, `connections`, `guilds`, `webhook.incoming` and `guilds.join`, abuse flagging, and account deletion.
