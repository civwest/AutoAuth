"use strict";
// Authenticator-app two-step login (TOTP, RFC 6238) for dashboard logins and project accounts.
//   - setup: QR code + secret, the code is checked before 2FA turns on, 8 one-time recovery codes
//   - login: after the password step the person is sent to /login%2Fa%<token>
//     (the page is /login%2Fa%<token>; the token is random, single-use, expires in 5 minutes and only works in the browser that started the login)
const crypto = require("node:crypto");
const { totpVerify, newSecret, otpauth } = require("./security");
const { qrSvg } = require("./qr");

module.exports = function createTwoFa({ pool, enc, dec, esc, log, page, limited }) {
  const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
  const same = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const save = (req) => new Promise((ok) => req.session.save(ok));
  const normRecovery = (c) => String(c || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  async function row(kind, ident) {
    const r = (await pool.query("SELECT secret_enc,recovery FROM totp_secrets WHERE kind=$1 AND ident=$2", [kind, String(ident)])).rows[0];
    if (!r) return null;
    try { return { secret: dec(r.secret_enc), recovery: Array.isArray(r.recovery) ? r.recovery : [], db: true }; } catch { return null; }
  }
  // The active second factor for a login: the one saved from the profile page, else the Render variable (owners only).
  const active = async (kind, ident, envSecret) => (await row(kind, ident)) || (envSecret ? { secret: envSecret, recovery: [], db: false, env: true } : null);

  // Returns "totp", "recovery" or false. A recovery code works once.
  async function check(rec, kind, ident, code) {
    const c = String(code || "").replace(/\s/g, "");
    if (/^\d{6}$/.test(c)) return totpVerify(rec.secret, c) ? "totp" : false;
    const h = sha(normRecovery(c));
    if (normRecovery(c).length >= 8 && rec.db && rec.recovery.includes(h)) {
      await pool.query("UPDATE totp_secrets SET recovery=$3 WHERE kind=$1 AND ident=$2", [kind, String(ident), JSON.stringify(rec.recovery.filter((x) => x !== h))]);
      return "recovery";
    }
    return false;
  }

  // ----- login step -----
  async function begin(req, p) {
    const token = crypto.randomBytes(24).toString("base64url");
    req.session.p2 = { token, kind: p.kind, ident: String(p.ident), label: p.label, next: p.next || "", method: p.method || "login", exp: Date.now() + 5 * 60 * 1000, tries: 0 };
    await save(req);
    return `/login%2Fa%${token}`;
  }
  const pending = (req) => { const p = req.session && req.session.p2; return p && p.exp > Date.now() && same(p.token, req.params[0]) ? p : null; };

  // One path segment: /login%2Fa%<32 character token>  (that is /login/a%<token> with the slash encoded)
  const TWOFA_URL = /^\/login%2[Ff][aA]%([A-Za-z0-9_-]{32})$/; // matched on the raw path, so %2F stays inside one segment
  function mountLogin(app, finish, envFor = () => "") {
    const view = (res, error) => res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" }).send(page({
      title: "Two-step login", sub: "Enter the 6-digit code from your authenticator app", error: error || "", top: "",
      form: `<form method="post" autocomplete="off"><label>Code</label><input name="code" inputmode="numeric" autocomplete="one-time-code" autofocus required maxlength="20" placeholder="123456"><button class="go">Continue</button></form>`,
      foot: `<p class="muted">Lost your phone? Enter one of your recovery codes instead.</p><a class="alt" href="/login">Cancel</a>`,
    }).replace('<div class="or"><span></span>or<span></span></div>', ""));
    app.get(TWOFA_URL, (req, res) => { const p = pending(req); if (!p) return res.redirect(303, "/login"); view(res); });
    app.post(TWOFA_URL, async (req, res) => {
      const p = pending(req); if (!p) return res.redirect(303, "/login");
      if (limited("2fa:" + req.ip, 30, 600000)) return res.status(429).send("Too many attempts. Try again later.");
      const rec = await active(p.kind, p.ident, envFor(p));
      const how = rec && (await check(rec, p.kind, p.ident, (req.body || {}).code));
      if (!how) {
        p.tries++; await log("two_step_failed", { kind: p.kind, ip: req.ip }, p.label);
        if (p.tries >= 5) { delete req.session.p2; await save(req); return res.redirect(303, "/login?error=1"); }
        await save(req); return view(res.status(401), "That code is not right. Try the newest code.");
      }
      const done = req.session.p2; delete req.session.p2;
      const to = await finish(req, done, how);
      if (how === "recovery") { req.session.flash = "You used a recovery code. Make new ones from your profile when you can."; await save(req); }
      res.redirect(303, to);
    });
  }

  // ----- setup / turn off (profile pages) -----
  // resolve(req) -> { kind, ident, label, env? }
  function handlers(resolve) {
    return {
      async start(req, res) {
        const w = resolve(req); if (!w) return res.status(404).json({ error: "Not found." });
        if (await active(w.kind, w.ident, w.env)) return res.status(400).json({ error: "Two-step login is already on." });
        const secret = newSecret(), uri = otpauth(w.label, secret);
        req.session.tfSetup = { secret, kind: w.kind, ident: String(w.ident), until: Date.now() + 10 * 60 * 1000 }; await save(req);
        res.set("Cache-Control", "no-store").json({ secret, svg: qrSvg(uri, { size: 200 }) });
      },
      async enable(req, res) {
        const w = resolve(req), s = req.session.tfSetup;
        if (!w || !s || s.until < Date.now() || s.kind !== w.kind || s.ident !== String(w.ident)) return res.status(400).json({ error: "Start again: the setup expired." });
        if (limited("2fs:" + req.ip, 15, 600000)) return res.status(429).json({ error: "Too many attempts. Try again later." });
        if (!totpVerify(s.secret, (req.body || {}).code, Date.now(), false)) return res.status(400).json({ error: "That code is not right. Check the newest code in your app." });
        const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString("hex").replace(/^(.{5})(.{5})$/, "$1-$2"));
        await pool.query("INSERT INTO totp_secrets(kind,ident,secret_enc,recovery) VALUES($1,$2,$3,$4) ON CONFLICT(kind,ident) DO UPDATE SET secret_enc=$3,recovery=$4,created_at=NOW()", [w.kind, String(w.ident), enc(s.secret), JSON.stringify(codes.map((c) => sha(normRecovery(c))))]);
        delete req.session.tfSetup; await save(req);
        await log("two_step_enabled", { kind: w.kind }, w.label);
        res.set("Cache-Control", "no-store").json({ codes });
      },
      async disable(req, res) {
        const w = resolve(req); if (!w) return res.status(404).json({ error: "Not found." });
        if (limited("2fd:" + req.ip, 15, 600000)) return res.status(429).json({ error: "Too many attempts. Try again later." });
        const rec = await row(w.kind, w.ident);
        if (!rec) return res.status(400).json({ error: "Two-step login is set in Render, so remove that variable there." });
        if (!(await check(rec, w.kind, w.ident, (req.body || {}).code))) return res.status(400).json({ error: "That code is not right." });
        await pool.query("DELETE FROM totp_secrets WHERE kind=$1 AND ident=$2", [w.kind, String(w.ident)]);
        await log("two_step_disabled", { kind: w.kind }, w.label);
        res.json({ ok: true });
      },
    };
  }

  // The profile card. base is the URL prefix of the three handlers above.
  function card({ on, env, base, left }) {
    const status = on ? (env ? "On (set in Render)" : `On · ${left} recovery code${left === 1 ? "" : "s"} left`) : "Off";
    return `<div class="card" id="tf" style="max-width:640px;margin-top:16px" data-base="${esc(base)}"><h2>Two-step login</h2>
<p class="muted" style="margin-top:0">Use an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password...) so a stolen password alone cannot open this login.</p>
<div style="display:flex;flex-wrap:wrap;align-items:center;gap:12px"><div style="flex:1;min-width:120px"><b>${status}</b></div>${on ? (env ? "" : '<button type="button" class="secondary" id="tf-off" style="width:auto">Turn off</button>') : '<button type="button" class="secondary" id="tf-gen" style="width:auto">Set up</button>'}</div>
<div id="tf-out" style="display:none;margin-top:14px"></div></div>
<script>document.addEventListener('DOMContentLoaded',function(){
var root=document.getElementById('tf');if(!root)return;var base=root.getAttribute('data-base'),out=document.getElementById('tf-out');
function show(){out.style.display='block';out.innerHTML='';}
function msg(t,bad){var p=document.createElement('p');p.textContent=t;if(bad)p.style.color='#ff7b72';out.appendChild(p);}
async function post(path,body){var r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});var j=await r.json().catch(function(){return{};});return{ok:r.ok,j:j};}
function codeBox(label,go){var w=document.createElement('div');w.style.cssText='display:flex;gap:8px;flex-wrap:wrap;margin-top:10px';var i=document.createElement('input');i.setAttribute('inputmode','numeric');i.setAttribute('autocomplete','one-time-code');i.placeholder='Code';i.style.cssText='max-width:180px';var b=document.createElement('button');b.type='button';b.textContent=label;b.style.width='auto';b.addEventListener('click',function(){go(i.value);});w.appendChild(i);w.appendChild(b);out.appendChild(w);i.focus();}
var g=document.getElementById('tf-gen');if(g)g.addEventListener('click',async function(){var x=await post('/start');show();if(!x.ok){msg(x.j.error||'Could not set up.',1);return;}
msg('1. Scan this QR code with your authenticator app.');var q=document.createElement('div');q.style.cssText='background:#fff;display:inline-block;padding:6px;border-radius:8px';q.innerHTML=x.j.svg;out.appendChild(q);
var d=document.createElement('p');d.className='muted';d.textContent="Can't scan? Enter this key by hand: ";var c=document.createElement('code');c.style.wordBreak='break-all';c.textContent=x.j.secret;d.appendChild(c);out.appendChild(d);
msg('2. Type the 6-digit code the app shows to turn it on.');
codeBox('Turn on',async function(v){var y=await post('/enable',{code:v});if(!y.ok){show();msg(y.j.error||'Failed.',1);return;}show();msg('Two-step login is on. Save these recovery codes somewhere safe. Each works once if you lose your phone, and they are not shown again:');var pre=document.createElement('pre');pre.style.cssText='user-select:all;background:#0d1117;padding:10px;border-radius:8px';pre.textContent=y.j.codes.join('\\n');out.appendChild(pre);var done=document.createElement('button');done.type='button';done.textContent='Done';done.style.width='auto';done.addEventListener('click',function(){location.reload();});out.appendChild(done);});});
var o=document.getElementById('tf-off');if(o)o.addEventListener('click',function(){show();msg('Enter a code from your app (or a recovery code) to turn it off.');codeBox('Turn off',async function(v){var y=await post('/disable',{code:v});if(y.ok)location.reload();else{show();msg(y.j.error||'Failed.',1);}});});
});</script>`;
  }

  const summary = async (kind, ident, envSecret) => { const r = await active(kind, ident, envSecret); return r ? { on: true, env: !!r.env, left: r.recovery.length } : { on: false }; };
  return { active, begin, mountLogin, handlers, card, summary };
};
