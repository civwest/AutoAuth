# Render Discord Bot Starter

This starter is designed to run on Render. You do not need to install Node.js or dependencies on your computer.

## Deploy on Render

1. Upload these files to a new branch in your GitHub repository.
2. In Render, create a Web Service and connect that repository and branch.
3. Set Build Command to `npm install`.
4. Set Start Command to `npm start`.
5. In Render Environment settings, add `BOT_TOKEN` with your Discord bot token as its value.
6. Deploy the service.

Render supplies the `PORT` environment variable automatically.

## Important

- Never commit your real bot token or share it in chat.
- Do not upload `node_modules`.
- This is only the clean starting point. Slash commands, OAuth2, and storage have not been added yet.
