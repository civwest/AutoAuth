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
- `/optout/confirm` no longer uses the Origin check: the callback page sends `Referrer-Policy: no-referrer`, so browsers post `Origin: null` from it. The signed single-use ticket already protects against forged requests.

## README
The README is now a setup guide: files to edit (with locations), Developer Portal steps, every Render environment variable and where to find it, and a first-start checklist.

## v1.3.3
- Captcha: a rate-limited or failed captcha request now shows a clear message instead of leaving a broken image and empty token. Limits raised (captcha 150 and sign-in starts 40 per 10 minutes per IP). The captcha refreshes itself every 4 minutes so it cannot silently expire while the agreement dialog is open.
- Captcha made easier to read: no look-alike characters (0/O, 1/I, 5/S, 2/Z, 8/B, 6/G removed), less rotation and noise, bigger text, not case sensitive.
- Dashboard: **Shut down bot** (disconnects the Discord bot and stops auto-reconnect; the site and dashboard stay up; **Start bot** brings it back) and **Restart service** (exits the process so Render starts it again). A full stop of the Render service itself is done from Render (Suspend).
- Bot reconnect: the Discord client is now created fresh on every connect/start. A destroyed discord.js client could not log in again, which is why **Start bot** failed after **Shut down bot**. A stable proxy keeps the dashboard and site pointed at the current client. Reconnecting needs nothing from startup: only `BOT_TOKEN` and `CLIENT_ID`.

## v1.3.4
- Dashboard offline mode: when the bot is disconnected, Quick actions, Discord presence, Servers and the DM Users tab are greyed out; clicking them opens a popup with a **Start the bot** button.
- All personal values moved to environment variables (owner IDs and names, operator name, social and docs links, invite link uses `CLIENT_ID`); nothing sensitive remains in the code. See the README variable table.

## v1.3.5
- Dashboard: the offline popup is gone from the sidebar. When the bot is disconnected, Quick actions, Discord presence, Servers and the DM Users fields are greyed out and each shows an in-box message with a **Start the bot** button. The sidebar always works.
- **Database** renamed **Users** (`/dashboard/users`; old URLs redirect). **Servers** is now its own tab (`/dashboard/servers`).
- Button results (add, remove, expiry, opt-out, DM and so on) now appear in a popup instead of a banner. DM sending only lists failures, with usernames, when something failed.
- **Owner messaging** at `/channels/@me` and `/channels/@me/<id>`: a Discord-style DM between the two owners. The conversation id is created once and never changes. Messages are held in memory only and cleared on **Close chat** or when both owners have left; a transcript can be downloaded first. "Signed in as" in the sidebar opens it. No Discord connection is needed.
- **Profiles** at `/users/profile` (view) and `/users/profile/edit`: profile picture, display name, pronouns, status, about, time zone, links and profile colour.
- Logging in now remembers where you were going (`/login?next=...`, same-site owner paths only) and sends you back there.
- `/.well-known/discord` serves `DISCORD_DOMAIN_VERIFICATION` for Discord's domain verification.
- New database tables created automatically: `owner_profiles`, `owner_dms`.

## v1.3.6
- **Messages** is now its own tab in the dashboard sidebar (between DM Users and Logs). It stays highlighted on the chat and profile pages. "Signed in as" still links to it.

## v1.3.7
- "Signed in as" in the sidebar now opens your profile (`/users/profile`) instead of Messages. Profile pages no longer highlight the Messages tab.

## DM Users as individual chats (part of v1.3.7)
- **DM Users** is now a list of one chat per person, and each person opens as a Discord-style thread (`/dashboard/dm/<userid>`). It shows what the owners sent from the dashboard and what people send to the bot in Discord DMs, with unread counts, attachment links and a reply box.
- Tags: **Mutual server DM** (the sender shares a server with the bot), **Authorized DM** (they allowed DMs on the website) and **Other DM**.
- The bot now receives DMs (Discord's non-privileged `DirectMessages` intent; no Developer Portal change). Stored in the new `bot_dms` table; deleted after `DM_RETENTION_DAYS` (default 30), when an owner deletes the conversation, or when the person opts out of everything. The Privacy Policy describes this.
- Owners can reply to anyone who has messaged the bot, not only people who allowed DMs on the website.
- DM chat URLs are now `/channels/<mutual-server-id>/<userid>` (the id of a server the person shares with the bot, found when they message it). People with no mutual server use `/channels/@dm/<userid>`. The old `/dashboard/dm/<userid>` URL redirects. New column `bot_dms.mutual_guild` is added automatically.

## v1.3.8
- **Linked Roles** tab (`/dashboard/roles`), locked behind "Start the bot" while the bot is offline: shows the **Linked Roles Verification URL** (`/linked-role`) with a copy button, setup steps, the linked members, and a **Refresh** button that registers the role requirements with Discord and re-sends every linked member's current status.
- Roles are assigned by Discord itself ("Linked Roles"): requirements are *Server joins allowed*, *DMs allowed* and *Days authorized*. Members connect through the verification URL (scopes `identify` and `role_connections.write`); tokens are stored encrypted in the new `role_links` table and removed when the member opts out of everything. Opting out of server joins or DMs updates their Discord status automatically.
- Users tab: the **Add to server** buttons are greyed out while the bot is offline.
- Privacy Policy updated for Linked Roles.
- Developer Portal step: set **Linked Roles Verification URL** to `https://YOUR-SITE/linked-role` (General Information).

## v1.3.9
- **Linked Roles redesigned** like partner/affiliate badges for a single server. Members only connect through the verification URL; they do **not** need to authorize AutoAuth. The Linked Roles tab now lets you:
  - define up to 5 requirements (the Discord limit), each **Manual** (you switch it on per person, e.g. Partner, Affiliate; defaults added on first start) or **Auto** (worked out from AutoAuth status: authorized for server joins, authorized for DMs, or connected for N days);
  - assign or remove manual requirements per member with one click, or by Discord ID before the person has even connected;
  - press **Refresh** to register the requirements with Discord and re-send every connected member's status.
  New tables `role_defs` and `role_assign` are created automatically.
- **Offline lock:** on the Servers, DM Users and Linked Roles pages the whole page (everything except the sidebar) is greyed out with a "You have to start the bot first" box and **Start the bot** button, and the page can't scroll. Bot Control keeps its per-box overlays.
- **Main site:** when the owners shut the bot down manually, the home page says "The Discord connection was temporarily severed by the owners" instead of "AutoAuth is starting up".
- **Images:** the background and icon are now also built into `embedded-images.js`, so they load even if `public/` is missing from the deployed repository. A file in `public/` still takes priority.
- Privacy Policy updated for the new Linked Roles behaviour.

## v1.4.0
- **Linked Roles: Twitch requirements** (StreamCord style) on top of Manual and AutoAuth-status requirements. New requirement type *Auto: connected Twitch account*: has a connected Twitch account, follows a given channel, or is subscribed to a given channel. After connecting Discord, members are sent to Twitch to sign in; status is checked live on connect and on **Refresh**.
- No Twitch Partner/Affiliate rules and no default Partner/Affiliate roles any more.
- Needs `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` and the Twitch redirect URL `https://YOUR-SITE/twitch/callback`. New table `twitch_links` (tokens encrypted); `role_defs` gains `rule_text`, `rule_id`. Twitch data is deleted when a member opts out of everything.
- Web opt-out now works for people who only connected Linked Roles. Privacy Policy updated for Twitch.

## v1.4.1
- **Linked Roles removed** (tab, `/linked-role`, Twitch requirements, `/twitch/callback`). The old `role_links`, `role_defs`, `role_assign` and `twitch_links` tables are dropped on start, which deletes the stored Linked Roles/Twitch tokens. You can clear the Linked Roles Verification URL in the Developer Portal and delete the Twitch app and `TWITCH_*` variables.
- **Messages > Add user** (replaces the My profile button; your profile is still under "Signed in as"). Choose a username and password and the page gives you the Render variables to add (`DASHBOARD_OWNERn_USER` and `DASHBOARD_OWNERn_PASSWORD_HASH`) to grant another person dashboard access. Up to 9 dashboard users.
- **Profiles:** new Discord field (user ID, discord.com/users link, invite link or username), shown as a link on the profile.

## v1.4.2
- **Dashboard users are now `DASHBOARD_ADMINn_*`** (old `DASHBOARD_OWNERn_*` names still work). New `DASHBOARD_ADMINn_PERMISSIONS` (`all`, `none`, or a list of `bot,users,servers,dm,logs`). Admins 1 and 2 default to all; later ones to Messages only. Tabs and routes a user may not use are hidden and blocked.
- **Add user** (Messages) now has a permissions picker and outputs the three variables. It was also fixed: its script had a syntax error that stopped the page working. Only users with every permission see it.
- **Messages:** every dashboard user can message every other one.
- **User menu and Quick actions fixed** (Edit expiry, Add to server, DM, Opt out, Add/Remove/Opt out quick actions): a script error on the page stopped the buttons.
- **Status editor:** *None* now sets a status message only. New *Streaming* option: the message box disappears, the button turns green and says *Continue*, and a form asks for the Twitch URL and stream title; *Verify stream* checks the channel and shows its live thumbnail, then *Set status*. Saving no longer reloads the page; a green banner confirms, e.g. "Set the bot's status to Online: Listening to AutoAuth." Note: Discord does not let bots attach their own image to a status; Discord itself shows the Twitch preview on a streaming status.

## v1.4.3
- Only `DASHBOARD_ADMIN1_*` is required now. Admins 1 and 2 only default to every permission when `DASHBOARD_ADMINn_PERMISSIONS` is not set; set it (e.g. `bot,logs` or `none`) to limit them too.

## v1.4.4
- **No premade logins.** No dashboard login is required and none gets default access. A login exists only if its `DASHBOARD_ADMINn_USER` and `_PASSWORD_HASH` are set, and `DASHBOARD_ADMINn_PERMISSIONS` decides what it may use (`all`, `none` or a list; if left out, Messages only). Set `all` on at least one login to use Add user.
- README: every dashboard login variable is now listed explicitly with an example and the permission words.
- Logins defined with the `DASHBOARD_OWNERn_*` variables are owners and have full permission by default; `DASHBOARD_ADMINn_*` logins only get what their `_PERMISSIONS` lists (Messages only if unset).

## v1.4.5
- **Default bot status:** no activity, status message `autoauth.cfd` (the host from `REDIRECT_URI`).
- **Authorization links work from anywhere.** The Discord authorize links (server joins, server joins + DMs, DMs only) no longer need to start on the website: the callback works out the mode from the scopes Discord granted. The site's own buttons now request the same scopes (including `guilds`).
- **Sign in to the dashboard with Discord** (`identify guilds guilds.members.read`): link your Discord account on Edit profile > *Link Discord account* (needs a password sign-in first), then use "Sign in with Discord" on the login page or the direct link. Unlinked accounts are refused. New table `dashboard_discord`; the token is revoked immediately.

## v1.4.6
- **Servers tab:** new box *Servers the bot is not in*. With a linked Discord account it lists the servers where that account has Manage Server or Administrator and the bot is not a member, each with icon, name and an **Add bot** button (cached one minute; Refresh reloads). Without a linked account it shows blurred placeholder rows with greyed buttons and a **Link with Discord** button on top.
- **Login page:** proper Discord-styled **Log in with Discord** button (blurple, Discord logo).
- A linked login keeps its Discord `guilds` token encrypted (table `dashboard_discord` gains token columns) so the list works after a normal password sign-in; unlinking revokes it. If it expires you are asked to link again.

## v1.4.7
- Dashboard login: the username is no longer case sensitive.
- Mobile dashboard: the sidebar is now a three-line menu button that slides the list out (tap outside or a link to close).

## v1.4.8
- **Profile:** banner image (upload, remove) and a crop step for both the picture and the banner (drag + zoom); file choosers are now buttons. The Discord link button is the real Discord-styled button.
- **Mobile:** public pages checked at phone width; Users and Servers tables turn into cards on phones so the action buttons are reachable.
- **Site text:** fuller description of what AutoAuth is on the home page, footer and meta description; the Authorization page no longer mentions a quick check (there is no captcha).
- **Quick actions:** *Opt out all users* (server joins, DMs or everything). Owner-started opt-outs (single user or all) DM people who allowed DMs first, then deauthorize.
- DMs from people who have not authorized are ignored; DM Users shows only authorized people, without mutual-server tags.
- Fix: schema order for `owner_profiles` on a brand-new database.

## v1.4.9
- **Dashboard sign-in with Discord now has its own callback URL**, `/login/callback` (optional env `LOGIN_REDIRECT_URI`). It no longer goes through the authorization callback, so it signs you in instead of showing the connected screen. Add `https://YOUR-SITE/login/callback` under OAuth2 > Redirects in the Developer Portal. The Link Discord button and the login button use it; the old login link that used `/oauth/callback` no longer works.

## v1.5.0
- New Side Projects tab: create OAuth callback, interactions, webhook, terms, privacy and invite endpoints at `/projects/<name>/...`, stored in the database.
- Image cropper rebuilt in Discord's Edit Image style (circle for avatar, rectangle for banner, zoom slider, pinch and drag).
- Removed the Discord ID field from the profile; Servers box reads "Servers you're in."
- Removed explanatory text from dashboard pages; it now lives in the README.

## v1.5.1
- Fixed Side Projects Create/Save buttons not responding (page script ran before the dashboard helpers loaded).

## v1.5.2
- Project accounts: Discord sign-up/login at `/signup`, dashboard at `/dashboard/<username>`, projects at `/projects/<username>/<project>/<tab>`.
- Per-project Setup, Users and Logs pages; account project data is hidden from site admins.
- Support chat between accounts and admins (new Support tab).

## v1.5.3
- OAuth and invite projects can select any Discord OAuth2 scope, with setup instructions per scope and a generated authorize link.

## v1.5.4
- `/signup` now matches `/login`: Discord button above the username and password fields.
- Login page links to Create an account. Accounts can sign up and log in with a username and password.
- Discord sign-up takes the username from the Discord account; the username step is gone.

## v1.5.5
- Google and X sign-up, log-in and linking for project accounts (buttons appear when credentials are set); Discord, Google and X linking and password change on the profile.
- Delete account button on the profile.
- Data tabs per selected permission (Emails, Connections, Servers, Webhooks) and an Add to server tool for `guilds.join`.
- Automatic abuse flagging for account projects: lock, apology DMs with a report page, owner notice, and an admin Flags list.

## v1.5.6
- Discord, Google and X buttons are now the same size on login, signup and profile.
- Profile shows Link buttons for Discord, Google and X, and Unlink buttons for each linked account. Google and X show even before their credentials are set; the button then explains the provider is not set up.

## v1.5.7
- Fixed the DM Users tab (and Users, Logs, Servers) being sent to the signup page.
- Connect/Unlink buttons for Discord, Google and X are on the main dashboard profile page; Google and X can also be used to log in to the dashboard once linked.
- README: use releases only; other files at your own risk.

## v1.5.8
- Removed the GitHub release check. Features are live when built; anything not built yet says "Under construction".
- Every selected OAuth permission without finished controls gets its own tab that says Under construction. The Google Drive storage option is shown disabled.
- Support tab on account dashboards shows an unread count.

## v1.5.9
- Footer shows the contact email (support@ your domain, or SUPPORT_EMAIL).
- Public pages show an Offline banner at the top when the bot is not connected.
- The home page shows an Under construction notice for features that are not built yet.
