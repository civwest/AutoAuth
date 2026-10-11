const http = require("node:http");
const { Client, GatewayIntentBits } = require("discord.js");

const token = process.env.BOT_TOKEN;
const port = Number(process.env.PORT) || 10000;

if (!token) {
  console.error("Missing BOT_TOKEN environment variable. Add it in Render > Environment.");
  process.exit(1);
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Discord bot service is running.");
});

server.listen(port, "0.0.0.0", () => {
  console.log(`HTTP server listening on port ${port}`);
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once("ready", () => {
  console.log(`Discord bot logged in as ${client.user.tag}`);
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.login(token).catch((error) => {
  console.error("Discord login failed:", error.message);
  process.exit(1);
});
