# AutoAuth Dashboard

The main Bot Control page displays the bot's Discord gateway connection and actual Discord presence (online/idle/DND/invisible), authorized-user count, `/addusers` usage count, log count, and guild list. Owners can change the Discord presence and activity from the page.

Tabs:
- Bot Control
- Database: search linked accounts and revoke saved OAuth credentials.
- Logs: recent OAuth, dashboard login, presence, and `/addusers` audit events.

Login URL: `/login`. The dashboard at `/dashboard` redirects unauthenticated visitors to `/login`. The old `/dashboard/login` URL redirects to `/login`.

## Render
Build command: `yarn` (or `npm install`)
Start command: `node index.js` (or `npm start`)

Required Render environment values: BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, DATABASE_URL, TOKEN_ENCRYPTION_KEY (64 hex chars), SESSION_SECRET, DASHBOARD_OWNER1_USER=civwest, DASHBOARD_OWNER1_PASSWORD_HASH, DASHBOARD_OWNER2_USER=jacob, DASHBOARD_OWNER2_PASSWORD_HASH.

The owner password hashes are generated separately for this delivery. Copy them from the assistant response into Render Environment; do not commit the hashes or passwords to GitHub. OAuth redirect URL must exactly match the Discord Developer Portal entry.

The PostgreSQL schema is created automatically. Dashboard sessions are stored in Express's in-memory session store and will log out on service restarts; that is acceptable for a small personal dashboard. Audit logs and authorization records persist in PostgreSQL.
\n\nDashboard server controls: the Servers table has a Leave server action for each guild; it asks for confirmation and records the action in Logs. Audit log actor IDs 1426813617394946068 and 1481562091520262236 are displayed as You (Civwest) and Jacob, respectively.\n

## Session security and owner-only add commands
- Dashboard sessions are stored in PostgreSQL, bound to the browser's User-Agent fingerprint, and expire after 2 hours. Refreshing or closing/reopening the page in the same browser keeps the session until it expires.
- The `/addusers` and `/adduser user_id` commands require the Discord Administrator permission. `/adduser` adds one account that has already completed `/auth`. The commands also enforce Administrator permission at runtime.
- The bot's application-install visibility must also be restricted in the Discord Developer Portal if you want to prevent other people from using an installation link to add the bot to their servers. Code-level command restrictions prevent others from running the bulk/single-user add commands.
- New dependency `connect-pg-simple` uses the existing `DATABASE_URL`; no new database service is required.

## Public website
`site.js` serves `/` (bot status), `/info`, `/tos` and `/privacy-policy`; `/home` redirects to `/`. The dashboard and `/login` are unchanged.

Images: save the background as `public/bg.webp` and the logo/favicon as `public/icon.webp`. They are served at `/assets/bg.webp` and `/assets/icon.webp`. If those files are missing, the site falls back to the original Discord CDN links, which expire.

## Commands
`/auth`, `/optout` (user deletes own saved data and revokes the grant), `/addusers` and `/adduser` (admins).
