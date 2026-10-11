# AutoAuth Render rebuild

Implements OAuth account linking and admin-only `/addusers`:
- Users authorize at `/auth` or with the `/auth` Discord command.
- Callback stores the Discord user ID and encrypted OAuth access/refresh tokens in PostgreSQL.
- An administrator runs `/addusers` in the target server; every saved authorized account is added to that server if not already a member.

## Render settings
Build command: `yarn` (or `npm install`)
Start command: `node index.js` (or `npm start`)

Add environment variables in Render:
- `BOT_TOKEN`: Discord bot token
- `CLIENT_ID`: Discord application ID
- `CLIENT_SECRET`: OAuth2 client secret
- `REDIRECT_URI`: `https://YOUR-RENDER-SERVICE.onrender.com/oauth/callback`
- `DATABASE_URL`: connection URL for a Render PostgreSQL database
- `TOKEN_ENCRYPTION_KEY`: 64 hexadecimal characters (32 bytes)

Create a PostgreSQL database in Render and use its internal connection URL. Do not commit secrets to GitHub.

## Discord setup
1. In Developer Portal > OAuth2 > Redirects, add the exact `REDIRECT_URI` from Render.
2. Invite the bot with `bot` and `applications.commands` scopes to every server where it should operate.
3. Ensure the bot has permission to add members / manage server members.
4. `/addusers` is registered globally and may take a while to appear.

Users must approve the `identify` and `guilds.join` OAuth scopes. Only users who authorized AutoAuth are eligible. The bot adds them to the server where the admin invokes `/addusers`.
