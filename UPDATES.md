# AutoAuth: Extra Info on Recent Updates

This document describes everything added or changed in the latest update.

## Public site
- Home heading is now **"AutoAuth is online"**, with a live stats strip, a call-to-action and a short "how it works" section.
- Nav (left to right): **Login** (far left), then **Home, Info, Authorization, Documentation** and the logo on the right.
- **Documentation** opens a popup first: "You're leaving the site. This link leads to an external website, are you sure you want to open it?" with **Yes, do it!** (green) and **No, I want to stay.** (blue).
- **Info** page has a commands table and an FAQ.
- `/tos` moved to **`/terms-of-service`** (the old `/tos` path 301-redirects). All links updated.
- Privacy Policy and Terms of Service rewritten to cover DM authorization, expiry, opt-out choices, kicking, DMs and attachments.
- Popups lock page scrolling while open.

## Authorization page (`/auth`)
Three cards, in order:
1. **Allow Server Joins** – scopes `identify guilds.join`
2. **Allow Direct Messages** – user install, scopes `applications.commands identify` (`integration_type=1`)
3. **Allow Both** – scopes `applications.commands identify guilds.join`

Each opens an agreement dialog (checkbox + captcha) before redirecting to Discord. The captcha is self-hosted (SVG, single-use HMAC token, rate-limited). The OAuth `state` is signed and single-use. Note: the link supplied for button 2 contained `identifys`, which is not a valid scope; it was corrected to `identify`.

The `/auth` bot command now replies with a clickable link to this page.

## Dashboard
- **Bot Control:** a **Retry** button beside the connection indicator, shown only while disconnected. Quick actions: Add members, **Remove a member**, **Remove all members**, Opt out.
- **Database:** tile actions (right-aligned, wrapping): **Edit expiry**, green **Add to server**, **DM** (only for DM-authorized users), **Opt out** (formerly Revoke), with a choice of DM / server / all.
- **Expiry:** tokens never expire unless an expiry is set. Options: 30 minutes, 1 hour, 6 hours, 12 hours, 1 day, 7 days, 30 days, Never (default).
- **DM Users:** lists only DM-authorized users; select recipients, write a message, add optional attachments (up to 5 files, 8 MB total).
- **Logs/CSV:** new events logged; CSV export gains access and expiry columns.

## Bot commands
- `/auth` – link to the site auth page.
- `/optout [type]` – `server`, `dm` or `all`.
- `/adduser`, `/addusers` – skip users who are expired or not server-authorized.

## Database migration
Run automatically at startup (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`): `server_authorized`, `dm_authorized`, `auth_expires_at`.

## Setup notes
- Add `https://autoauth.cfd/oauth/callback` as a redirect in the Discord Developer Portal.
- Enable user install in the portal for the DM option.
- Env vars unchanged; optional `GOOGLE_VERIFICATION_FILE`, `GOOGLE_SITE_VERIFICATION`.

## Caveats
- DMs depend on each user's Discord privacy settings.
- Kick-all affects authorized users only and skips owners.
- The built-in captcha is basic; Turnstile or hCaptcha can be added.
- Retry uses `client.destroy()` then `login()`, so test it live.
- Chrome Safe Browsing review must be requested through Search Console; a custom domain is the durable fix.

## Later fixes
- Startup check: on boot, every stored authorization is verified (tokens refreshed); revoked ones lose the server flag.
- OAuth callback accepts the state from a backup cookie if Discord drops it, and logs which parameters arrived (`oauth_invalid_state` in Logs).
- Bot login has a timeout, logs each step, and retries every 60 seconds.
- Site address follows `REDIRECT_URI` (now `https://autoauth.cfd`).

## Opt-out page (`/optout`)
- New public page. Users sign in with Discord (`identify` scope only; the token is revoked immediately and nothing is stored), then choose server joins only, DMs only, or everything (deletes their data).
- Confirmation uses a signed, single-use, 10-minute ticket. Routes: `GET /optout`, `POST /optout/start`, `POST /optout/confirm`.
- The site (home, info, FAQ, policies, auth page) and the `/optout` bot replies now link to it.
- Add `identify` redirect is the same `/oauth/callback`; no Developer Portal change is needed.
