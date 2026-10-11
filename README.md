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
