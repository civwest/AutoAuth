"use strict";
// Plans (Stripe subscriptions), the /subscribe page, the Stripe webhook, the Billing tab (Stripe customer portal),
// plan limits and emailed receipts.
//   Google Drive storage is NOT part of any plan: it is free and identical for everyone.
//   Plans raise the database-storage and project limits and add extras.
const crypto = require("node:crypto");

// Prices are in CAD: [total for the term, per-month equivalent].
const PRICES = {
  1: { 1: [14.99, 14.99], 3: [42.99, 14.33], 6: [79.99, 13.33], 12: [149.99, 12.5] },
  2: { 1: [24.99, 24.99], 3: [69.99, 23.33], 6: [129.99, 21.67], 12: [239.99, 20.0] },
  3: { 1: [34.99, 34.99], 3: [99.99, 33.33], 6: [179.99, 30.0], 12: [329.99, 27.5] },
};
const TERMS = [1, 3, 6, 12];
// What each plan allows. Tier 0 is everyone without a subscription (it keeps today's project limit, so nobody loses anything).
const PLANS = {
  0: { name: "Free", projects: 10, dbUsers: 25, logDays: 7, priority: false },
  1: { name: "Starter", projects: 15, dbUsers: 1000, logDays: 30, priority: false },
  2: { name: "Plus", projects: 30, dbUsers: 10000, logDays: 90, priority: true },
  3: { name: "Max", projects: 100, dbUsers: 100000, logDays: 365, priority: true },
};
const nf = (n) => n.toLocaleString("en-US");
const PERKS = {
  1: [["gift", "14-day free trial"], ["database", `${nf(PLANS[1].dbUsers)} users stored in our database`], ["folder", `${PLANS[1].projects} projects`], ["clock", `${PLANS[1].logDays} days of project log history`], ["receipt", "Emailed receipts and a billing portal"]],
  2: [["database", `${nf(PLANS[2].dbUsers)} users stored in our database`], ["folder", `${PLANS[2].projects} projects`], ["clock", `${PLANS[2].logDays} days of project log history`], ["lifebuoy", "Priority support"], ["receipt", "Emailed receipts and a billing portal"]],
  3: [["database", `${nf(PLANS[3].dbUsers)} users stored in our database`], ["folder", `${PLANS[3].projects} projects`], ["clock", `${PLANS[3].logDays} days of project log history`], ["lifebuoy", "Priority support, first in the queue"], ["receipt", "Emailed receipts and a billing portal"]],
};
const ICON = {
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8M7.5 8a2.5 2.5 0 1 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 1 1 0 5"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/><path d="M5.6 5.6l3.9 3.9M14.5 14.5l3.9 3.9M18.4 5.6l-3.9 3.9M9.5 14.5l-3.9 3.9"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9.5 4.25 4.25 0 0 1 17.5 18z"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#b9bcc2" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

// Country -> currency, for showing prices in the visitor's own money. Only currencies the rate feed supports.
const EURO = "AT BE CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES HR".split(" ");
const CUR = { US: "USD", CA: "CAD", GB: "GBP", AU: "AUD", NZ: "NZD", JP: "JPY", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF", MX: "MXN", BR: "BRL", IN: "INR", SG: "SGD", HK: "HKD", KR: "KRW", ZA: "ZAR", TR: "TRY", IL: "ILS", PH: "PHP", TH: "THB", MY: "MYR", ID: "IDR" };
for (const c of EURO) CUR[c] = "EUR";
const FALLBACK_RATES = { CAD: 1, USD: 0.7145, EUR: 0.6384, GBP: 0.5345, AUD: 1.0175, JPY: 112.04 }; // used only if the live feed is unreachable

module.exports = function createBilling({ pool, log, esc, origin, express, authPage, limited }) {
  const supportEmail = () => { const e = String(process.env.SUPPORT_EMAIL || "").trim(); if (/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(e)) return e; try { return "support@" + new URL(process.env.REDIRECT_URI).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const stripeKey = () => String(process.env.STRIPE_SECRET_KEY || "");
  const linkFor = (tier, term) => { try { const u = new URL(String(process.env[`STRIPE_LINK_${tier}_${term}`] || "").trim()); return u.protocol === "https:" ? u.toString() : ""; } catch { return ""; } };
  const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,255}\.[^\s@<>"']{2,}$/;

  async function stripe(method, path, params) {
    if (!stripeKey()) throw new Error("Stripe is not set up (STRIPE_SECRET_KEY).");
    const q = params && method === "GET" ? "?" + new URLSearchParams(params) : "";
    const r = await fetch("https://api.stripe.com/v1" + path + q, { method, headers: { Authorization: "Bearer " + stripeKey(), "Content-Type": "application/x-www-form-urlencoded" }, body: params && method !== "GET" ? new URLSearchParams(params) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || "Stripe error " + r.status);
    return j;
  }

  // ---------- plan lookup and limits ----------
  const ENTITLED = (r) => r && (r.status === "active" || r.status === "trialing" || (r.status === "past_due" && Number(r.period_end) * 1000 + 3 * 864e5 > Date.now()));
  async function subRow(accountId) {
    const rows = (await pool.query("SELECT * FROM subscriptions WHERE account_id=$1 ORDER BY tier DESC, updated_at DESC", [accountId])).rows;
    return rows.find(ENTITLED) || rows[0] || null;
  }
  async function tierOf(accountId) { const r = await subRow(accountId); return ENTITLED(r) ? Number(r.tier) : 0; }
  async function limits(accountId) { const t = await tierOf(accountId); return { tier: t, ...PLANS[t] }; }
  const hasCustomer = async (accountId) => !!(await pool.query("SELECT 1 FROM subscriptions WHERE account_id=$1 LIMIT 1", [accountId])).rows[0];
  const DB_USERS_SQL = "SELECT COUNT(*)::int n FROM side_project_users u JOIN side_projects s ON s.slug=u.slug WHERE s.owner_account=$1 AND COALESCE(s.config->>'storage','database')<>'drive'";
  const usage = async (accountId) => (await pool.query(DB_USERS_SQL, [accountId])).rows[0].n;
  // Used when someone authorizes a project: may this user be saved in our database? (Google Drive projects are never limited.)
  async function canStore(p, userId) {
    if (!p.owner_account || (p.config || {}).storage === "drive") return true;
    if ((await pool.query("SELECT 1 FROM side_project_users WHERE slug=$1 AND user_id=$2", [p.slug, String(userId)])).rows[0]) return true;
    const L = await limits(p.owner_account);
    return (await usage(p.owner_account)) < L.dbUsers;
  }
  async function claimByEmail(accountId, email) {
    await pool.query("UPDATE subscriptions SET account_id=$1 WHERE account_id IS NULL AND lower(email)=lower($2)", [accountId, email]).catch(() => {});
  }

  // ---------- Stripe -> our database ----------
  function tierFromSub(sub) {
    for (const it of (sub.items && sub.items.data) || []) {
      const pr = it.price || {}, prod = typeof pr.product === "object" ? pr.product : { id: pr.product };
      const meta = Number((pr.metadata || {}).tier || (prod.metadata || {}).tier);
      if (meta >= 1 && meta <= 3) return meta;
      for (const t of [1, 2, 3]) if (String(process.env[`STRIPE_TIER_${t}_IDS`] || "").split(/[\s,]+/).filter(Boolean).some((id) => id === pr.id || id === prod.id)) return t;
    }
    return 0;
  }
  async function sync(subId, hint = {}) {
    const sub = await stripe("GET", "/subscriptions/" + encodeURIComponent(subId), { "expand[]": "items.data.price.product" });
    let cust = null; try { cust = await stripe("GET", "/customers/" + encodeURIComponent(sub.customer)); } catch {}
    const email = (cust && cust.email) || hint.email || "", it = (sub.items.data || [])[0] || {}, rec = (it.price || {}).recurring || {};
    const months = (Number(rec.interval_count) || 1) * (rec.interval === "year" ? 12 : 1), tier = tierFromSub(sub);
    const existing = (await pool.query("SELECT account_id FROM subscriptions WHERE subscription_id=$1 OR (customer_id=$2 AND account_id IS NOT NULL) LIMIT 1", [sub.id, sub.customer])).rows[0];
    let accountId = existing && existing.account_id || null;
    const ref = /^acct_(\d{1,18})$/.exec(String(hint.ref || ""));
    if (!accountId && ref) accountId = (await pool.query("SELECT id FROM accounts WHERE id=$1", [ref[1]])).rows[0]?.id || null;
    if (!accountId && email) accountId = (await pool.query("SELECT id FROM accounts WHERE lower(email)=lower($1)", [email])).rows[0]?.id || null;
    const periodEnd = sub.current_period_end || (it && it.current_period_end) || 0;
    await pool.query(`INSERT INTO subscriptions(subscription_id,customer_id,account_id,tier,status,months,period_end,trial_end,cancel_at_period_end,email,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
      ON CONFLICT(subscription_id) DO UPDATE SET customer_id=$2,account_id=COALESCE(subscriptions.account_id,$3),tier=$4,status=$5,months=$6,period_end=$7,trial_end=$8,cancel_at_period_end=$9,email=COALESCE(NULLIF($10,''),subscriptions.email),updated_at=NOW()`,
      [sub.id, String(sub.customer), accountId, tier, sub.status, months, periodEnd, sub.trial_end || null, !!sub.cancel_at_period_end, email]);
    await log(accountId ? "subscription_synced" : "subscription_unmatched", { tier, status: sub.status, months, email: email ? email.replace(/^(.).*(@.*)$/, "$1***$2") : "" });
    if (!tier) await log("subscription_unknown_tier", { subscription: sub.id, hint: "Add metadata tier=1|2|3 to the Stripe product or price, or list its id in STRIPE_TIER_<n>_IDS." });
    return { accountId, tier };
  }

  // Looks the account's email up in Stripe and syncs what it finds, so plans work even if a webhook was missed or the
  // buyer paid with another email. Throttled per account; force = true skips the wait (used right after checkout).
  const lastLook = new Map();
  async function refresh(accountId, email, force) {
    if (!stripeKey() || !accountId) return false;
    const gap = force ? 5000 : 5 * 60 * 1000, last = lastLook.get(String(accountId)) || 0;
    if (Date.now() - last < gap) return false;
    lastLook.set(String(accountId), Date.now());
    try {
      if (!email || !EMAIL.test(email)) return false;
      const custs = await stripe("GET", "/customers", { email, limit: "10" });
      let found = false;
      for (const c of custs.data || []) {
        const subs = await stripe("GET", "/subscriptions", { customer: c.id, status: "all", limit: "10" });
        for (const s of subs.data || []) { await sync(s.id, { email, ref: "acct_" + accountId }); found = true; }
      }
      return found;
    } catch (e) { await log("subscription_lookup_failed", { error: String(e.message).slice(0, 200) }); return false; }
  }
  // After checkout Stripe sends the buyer here; the session id ties the payment to the account that started it.
  async function fromCheckout(accountId, sessionId) {
    if (!/^cs_(live|test)_[A-Za-z0-9]{10,200}$/.test(String(sessionId || "")) || !stripeKey()) return false;
    try {
      const cs = await stripe("GET", "/checkout/sessions/" + sessionId);
      if (cs.mode !== "subscription" || !cs.subscription || cs.client_reference_id !== "acct_" + accountId) return false;
      await sync(typeof cs.subscription === "string" ? cs.subscription : cs.subscription.id, { ref: cs.client_reference_id, email: (cs.customer_details && cs.customer_details.email) || cs.customer_email });
      return true;
    } catch (e) { await log("subscription_checkout_lookup_failed", { error: String(e.message).slice(0, 200) }); return false; }
  }

  // ---------- receipts (sent from noreply@ our own domain, through Resend) ----------
  const money = (cents, cur) => { try { return new Intl.NumberFormat("en-CA", { style: "currency", currency: String(cur || "cad").toUpperCase() }).format(Number(cents) / (["jpy", "krw"].includes(String(cur).toLowerCase()) ? 1 : 100)); } catch { return (Number(cents) / 100).toFixed(2) + " " + String(cur).toUpperCase(); } };
  const sender = () => String(process.env.RECEIPT_FROM || "AutoAuth <noreply@autoauth.cfd>");
  async function sendReceipt(inv) {
    if (!inv || !inv.id || !(Number(inv.amount_paid) > 0)) return "skipped";
    const fresh = (await pool.query("INSERT INTO receipts_sent(invoice_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING invoice_id", [inv.id])).rows[0]; if (!fresh) return "duplicate";
    let to = inv.customer_email || ""; if (!to) { const r = (await pool.query("SELECT email FROM subscriptions WHERE customer_id=$1 AND email<>'' LIMIT 1", [inv.customer])).rows[0]; to = r ? r.email : ""; }
    if (!EMAIL.test(to)) { await log("receipt_no_email", { invoice: inv.id }); return "no-email"; }
    if (!process.env.RESEND_API_KEY) { await log("receipt_not_sent", { invoice: inv.id, reason: "RESEND_API_KEY is not set" }); await pool.query("DELETE FROM receipts_sent WHERE invoice_id=$1", [inv.id]); return "no-provider"; }
    const line = ((inv.lines && inv.lines.data) || [])[0] || {}, desc = line.description || "AutoAuth subscription";
    const period = line.period && line.period.start ? `${new Date(line.period.start * 1000).toISOString().slice(0, 10)} to ${new Date(line.period.end * 1000).toISOString().slice(0, 10)}` : "";
    const total = money(inv.amount_paid, inv.currency), when = new Date((inv.status_transitions && inv.status_transitions.paid_at ? inv.status_transitions.paid_at : inv.created) * 1000).toISOString().slice(0, 10);
    const rows = [["Receipt", inv.number || inv.id], ["Date", when], ["Item", desc], ...(period ? [["Period", period]] : []), ["Amount paid", total]];
    const links = [inv.hosted_invoice_url && ["View invoice", inv.hosted_invoice_url], inv.invoice_pdf && ["Download PDF", inv.invoice_pdf]].filter(Boolean).filter((x) => /^https:\/\//.test(x[1]));
    const html = `<div style="font:15px/1.5 system-ui,sans-serif;color:#111;max-width:520px"><h2 style="margin:0 0 8px">Thanks for subscribing to AutoAuth</h2><p style="margin:0 0 16px">Here is your receipt.</p><table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) => `<tr><td style="padding:6px 0;color:#555">${esc(k)}</td><td style="padding:6px 0;text-align:right"><b>${esc(v)}</b></td></tr>`).join("")}</table><p>${links.map(([l, u]) => `<a href="${esc(u)}">${esc(l)}</a>`).join(" &middot; ")}</p><p style="color:#666;font-size:13px">Manage or cancel your subscription any time from the Billing tab in your AutoAuth dashboard.${supportEmail() ? ` Questions? Write to ${esc(supportEmail())}.` : ""}</p></div>`;
    const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n") + "\n" + links.map(([l, u]) => `${l}: ${u}`).join("\n") + "\n\nManage or cancel any time from the Billing tab in your AutoAuth dashboard.";
    try {
      const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ from: sender(), to: [to], subject: `Your AutoAuth receipt${inv.number ? " " + inv.number : ""}`, html, text, ...(supportEmail() ? { reply_to: supportEmail() } : {}) }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.message || "status " + r.status); }
      await log("receipt_sent", { invoice: inv.id });
      return "sent";
    } catch (e) { await pool.query("DELETE FROM receipts_sent WHERE invoice_id=$1", [inv.id]); await log("receipt_failed", { invoice: inv.id, error: String(e.message).slice(0, 200) }); return "failed"; }
  }

  // ---------- webhook ----------
  function verifySig(raw, header, secret, now = Date.now()) {
    const parts = String(header || "").split(",").map((x) => x.trim().split("=")), t = (parts.find((p) => p[0] === "t") || [])[1];
    const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1]); if (!t || !sigs.length || !secret) return false;
    if (Math.abs(now / 1000 - Number(t)) > 300) return false;
    const want = crypto.createHmac("sha256", secret).update(`${t}.`).update(raw).digest("hex");
    return sigs.some((s) => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
  }
  async function handle(ev) {
    const o = ev.data && ev.data.object || {};
    if (ev.type === "checkout.session.completed") {
      if (o.mode === "subscription" && o.subscription) await sync(typeof o.subscription === "string" ? o.subscription : o.subscription.id, { ref: o.client_reference_id, email: (o.customer_details && o.customer_details.email) || o.customer_email });
    } else if (/^customer\.subscription\.(created|updated|deleted|paused|resumed|trial_will_end)$/.test(ev.type)) await sync(o.id);
    else if (ev.type === "invoice.paid" || ev.type === "invoice.payment_succeeded") { if (o.subscription) await sync(o.subscription).catch(() => {}); await sendReceipt(o); }
    else if (ev.type === "invoice.payment_failed" && o.subscription) await sync(o.subscription);
  }

  // ---------- currency ----------
  let rates = { at: 0, v: FALLBACK_RATES };
  async function ratesNow() {
    if (Date.now() - rates.at < 6 * 3600 * 1000) return rates.v;
    rates.at = Date.now(); // do not hammer the feed if it is down
    try { const j = await (await fetch("https://api.frankfurter.dev/v1/latest?base=CAD", { signal: AbortSignal.timeout(4000) })).json(); if (j && j.rates) rates.v = { CAD: 1, ...j.rates }; } catch {}
    return rates.v;
  }
  function countryOf(req, res) {
    const ck = /(?:^|;\s*)aa_cc=([A-Z]{2})\b/.exec(req.headers.cookie || "");
    const q = String(req.query.cc || "").toUpperCase();
    let cc = /^[A-Z]{2}$/.test(q) ? q : ck ? ck[1] : "";
    if (!cc) cc = String(req.get("cf-ipcountry") || req.get("x-vercel-ip-country") || req.get("x-country-code") || "").toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc) || cc === "XX" || cc === "T1") { const m = /-([A-Za-z]{2})\b/.exec(String(req.get("accept-language") || "")); cc = m ? m[1].toUpperCase() : "CA"; }
    if (!ck || ck[1] !== cc) res.cookie("aa_cc", cc, { maxAge: 365 * 864e5, sameSite: "lax", secure: !!req.secure, path: "/" });
    return cc;
  }

  // ---------- pages ----------
  const CSS = `:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#000;color:#fff;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}a{color:inherit}
.top{display:flex;justify-content:space-between;align-items:center;padding:18px 24px}.top a{text-decoration:none;font-weight:700}.top .r a{font-weight:600;color:#d1d5db;margin-left:16px}
main{max-width:1120px;margin:0 auto;padding:12px 16px 56px}h1{font-size:clamp(28px,5vw,40px);margin:12px 0 6px;text-align:center}.lead{color:#b9bcc2;text-align:center;margin:0 auto 22px;max-width:640px}
.bar{display:flex;justify-content:center;margin:0 0 26px;position:relative}.dd{position:relative}.dd>button{background:#2b2b2e;color:#fff;border:1px solid #3d3d41;border-radius:12px;padding:11px 18px;font:600 15px system-ui;cursor:pointer;display:flex;gap:10px;align-items:center;min-width:170px;justify-content:space-between}
.dd>button:hover{background:#343438}.dd ul{position:absolute;left:0;right:0;top:calc(100% + 6px);margin:0;padding:6px;list-style:none;background:#1c1c1f;border:1px solid #3d3d41;border-radius:12px;z-index:5;box-shadow:0 12px 30px #000a}
.dd li{padding:9px 12px;border-radius:8px;cursor:pointer}.dd li:hover,.dd li:focus,.dd li[aria-selected=true]{background:#2f2f33;outline:0}.dd li small{color:#8f939a;margin-left:6px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}@media(max-width:860px){.grid{grid-template-columns:1fr;max-width:460px;margin:0 auto}}
.plan{border:1px solid #d1d5db;border-radius:20px;padding:26px 24px;display:flex;flex-direction:column;background:#000}.plan.cur{border-color:#fff;box-shadow:0 0 0 1px #fff}
.plan h2{margin:0;font-size:22px}.tag{display:inline-block;margin-left:8px;font-size:12px;font-weight:700;padding:3px 9px;border:1px solid #d1d5db;border-radius:999px;vertical-align:middle;color:#e5e7eb}
.price{font-size:38px;font-weight:800;margin:14px 0 0;line-height:1.1}.price small{font-size:15px;font-weight:500;color:#b9bcc2}.bill{color:#b9bcc2;font-size:14px;min-height:42px;margin:4px 0 16px}.save{color:#fff;font-weight:700}
.sub{display:block;text-align:center;background:#fff;color:#000;text-decoration:none;font-weight:700;padding:13px;border-radius:12px;border:0;font-size:16px;cursor:pointer;width:100%}.sub:hover{background:#e5e7eb}.sub[aria-disabled=true]{background:#2b2b2e;color:#8f939a;cursor:default}
ul.perks{list-style:none;margin:22px 0 0;padding:0;display:flex;flex-direction:column;gap:13px}ul.perks li{display:flex;gap:12px;align-items:flex-start}ul.perks svg{flex:none;margin-top:2px}
.free{margin:26px auto 0;max-width:760px;border:1px solid #d1d5db;border-radius:16px;padding:16px 20px;display:flex;gap:14px;align-items:flex-start;color:#e5e7eb}.free svg{flex:none;margin-top:3px}.fine{color:#8f939a;font-size:13px;text-align:center;margin-top:18px}
.card{max-width:460px;margin:8vh auto;border:1px solid #d1d5db;border-radius:20px;padding:28px}.card input{width:100%;padding:12px;border-radius:10px;border:1px solid #3d3d41;background:#111;color:#fff;font-size:16px;margin:8px 0 14px}.card .sub{margin-top:6px}.err{color:#ff8a8a}`;
  const shell = (title, body, who) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" type="image/webp" href="/assets/icon.webp"><style>${CSS}</style></head><body><div class="top"><a href="/">AutoAuth</a><div class="r">${who ? `<a href="/dashboard/${esc(who)}">Dashboard</a>` : '<a href="/login">Log in</a><a href="/signup">Sign up</a>'}</div></div>${body}</body></html>`;

  async function pricingPage(req, res) {
    const cc = countryOf(req, res), code = CUR[cc] || "CAD", r = await ratesNow(), rate = r[code] || 1, shownCode = r[code] ? code : "CAD";
    const s = req.session && req.session.acct, cur = s ? await tierOf(s.id) : 0;
    const data = { prices: PRICES, cur: { code: shownCode, rate: r[code] ? rate : 1 }, cc, current: cur, links: Object.fromEntries([1, 2, 3].map((t) => [t, TERMS.filter((m) => linkFor(t, m)).length === TERMS.length])) };
    const names = { 1: PLANS[1].name, 2: PLANS[2].name, 3: PLANS[3].name };
    const cards = [1, 2, 3].map((t) => `<article class="plan${cur === t ? " cur" : ""}" data-t="${t}"><h2>${names[t]}${t === 1 ? '<span class="tag">14-day free trial</span>' : ""}</h2>
<div class="price" data-price></div><div class="bill" data-bill></div>
<a class="sub" data-sub href="/subscribe/go?tier=${t}&term=1">${cur === t ? "Current plan" : "Subscribe"}</a>
<ul class="perks">${PERKS[t].map(([i, txt]) => `<li>${icon(i)}<span>${esc(txt)}</span></li>`).join("")}</ul></article>`).join("");
    const body = `<main><h1>Choose your plan</h1><p class="lead">Every plan gives you more room and extras. Nothing about how AutoAuth works is held back from free accounts.</p>
<div class="bar"><div class="dd" id="dd"><button type="button" id="dd-btn" aria-haspopup="listbox" aria-expanded="false"><span id="dd-lab">1 month</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg></button>
<ul id="dd-list" role="listbox" hidden><li role="option" tabindex="0" data-m="1" aria-selected="true">1 month</li><li role="option" tabindex="0" data-m="3">3 months <small>save ~4%</small></li><li role="option" tabindex="0" data-m="6">6 months <small>save ~11%</small></li><li role="option" tabindex="0" data-m="12">1 year <small>save ~17%</small></li></ul></div></div>
<div class="grid">${cards}</div>
<div class="free">${icon("cloud")}<div><b>Google Drive storage is free on every plan.</b><div style="color:#b9bcc2">Save your project data to your own Google Drive with no limits from us, whether or not you subscribe.</div></div></div>
<p class="fine">Prices are set in CAD${shownCode === "CAD" ? "" : ` and shown here as an estimate in ${shownCode} (live exchange rate)`}. Your card is charged by Stripe; the exact amount is shown at checkout. Use the same email you use on AutoAuth, so your subscription finds your account. Cancel any time from the Billing tab.</p></main>
<script type="application/json" id="pd">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>(function(){var D=JSON.parse(document.getElementById('pd').textContent),term=1;
function fmt(n,c){try{return new Intl.NumberFormat(undefined,{style:'currency',currency:c,maximumFractionDigits:(c==='JPY'||c==='KRW'||c==='HUF'||c==='IDR')?0:2}).format(n);}catch(e){return c+' '+n.toFixed(2);}}
function render(){document.querySelectorAll('.plan').forEach(function(el){var t=el.dataset.t,p=D.prices[t][term],m=p[1],tot=p[0],one=D.prices[t][1][0]*term,loc=D.cur.code!=='CAD';
 el.querySelector('[data-price]').innerHTML=(loc?'\\u2248 ':'')+fmt(m*D.cur.rate,D.cur.code)+' <small>/ month</small>';
 var b=term===1?'Billed monthly at '+fmt(tot,'CAD')+' CAD':'Billed '+fmt(tot,'CAD')+' CAD every '+(term===12?'year':term+' months');
 if(loc)b+=' (\\u2248 '+fmt(tot*D.cur.rate,D.cur.code)+')';if(term>1)b+=' <span class="save">\\u00b7 save '+Math.round((1-tot/one)*100)+'%</span>';
 el.querySelector('[data-bill]').innerHTML=b;
 var a=el.querySelector('[data-sub]');if(Number(t)===D.current){a.textContent='Current plan';a.setAttribute('aria-disabled','true');a.removeAttribute('href');}else if(!D.links[t]){a.textContent='Coming soon';a.setAttribute('aria-disabled','true');a.removeAttribute('href');}else{a.textContent='Subscribe';a.href='/subscribe/go?tier='+t+'&term='+term;a.removeAttribute('aria-disabled');}});}
var btn=document.getElementById('dd-btn'),list=document.getElementById('dd-list'),lab=document.getElementById('dd-lab');
function open(o){list.hidden=!o;btn.setAttribute('aria-expanded',o?'true':'false');if(o){var s=list.querySelector('[aria-selected=true]');s&&s.focus();}}
btn.addEventListener('click',function(){open(list.hidden);});
list.addEventListener('click',function(e){var li=e.target.closest('li');if(!li)return;pick(li);});
list.addEventListener('keydown',function(e){var li=document.activeElement;if(e.key==='Enter'||e.key===' '){e.preventDefault();pick(li);}else if(e.key==='ArrowDown'){e.preventDefault();(li.nextElementSibling||list.firstElementChild).focus();}else if(e.key==='ArrowUp'){e.preventDefault();(li.previousElementSibling||list.lastElementChild).focus();}else if(e.key==='Escape'){open(false);btn.focus();}});
function pick(li){term=Number(li.dataset.m);[].forEach.call(list.children,function(x){x.setAttribute('aria-selected',x===li?'true':'false');});lab.textContent=li.firstChild.textContent.trim();open(false);btn.focus();render();}
document.addEventListener('click',function(e){if(!document.getElementById('dd').contains(e.target))open(false);});
render();})();</script>`;
    res.set("Cache-Control", "private, no-store").send(shell("AutoAuth Plans", body, s && s.username));
  }

  function mountPublic(app) {
    app.get("/subscribe", async (req, res) => {
      const s = req.session && req.session.acct;
      if (s) { const a = (await pool.query("SELECT email FROM accounts WHERE id=$1", [s.id])).rows[0]; if (a) await refresh(s.id, a.email); }
      return pricingPage(req, res);
    });
    app.get("/subscribe/success", async (req, res) => {
      const s = req.session && req.session.acct; if (!s) return res.redirect(303, "/login");
      const a = (await pool.query("SELECT email FROM accounts WHERE id=$1", [s.id])).rows[0];
      let ok = await fromCheckout(s.id, req.query.session_id);
      if (!ok && a) ok = await refresh(s.id, a.email, true);
      res.set("Cache-Control", "no-store").redirect(303, ok ? `/dashboard/${s.username}/billing` : `/dashboard/${s.username}`);
    });

    app.get("/subscribe/go", async (req, res) => {
      const tier = Number(req.query.tier), term = Number(req.query.term);
      if (![1, 2, 3].includes(tier) || !TERMS.includes(term)) return res.redirect(303, "/subscribe");
      const s = req.session && req.session.acct;
      if (!s) return res.set("Cache-Control", "no-store").send(shell("Subscribe", `<div class="card"><h2 style="margin-top:0">Log in to subscribe</h2><p style="color:#b9bcc2">Your plan belongs to your AutoAuth account. Log in or create one, then come back and choose your plan.</p><a class="sub" href="/login">Log in</a><a class="sub" style="margin-top:10px;background:#2b2b2e;color:#fff" href="/signup">Create an account</a></div>`));
      if (await hasCustomer(s.id)) return res.redirect(303, `/dashboard/${s.username}/billing`);
      const link = linkFor(tier, term); if (!link) return res.redirect(303, "/subscribe");
      const a = (await pool.query("SELECT id,email FROM accounts WHERE id=$1", [s.id])).rows[0]; if (!a) return res.redirect(303, "/subscribe");
      if (!a.email) return res.set("Cache-Control", "no-store").send(emailPage(tier, term, ""));
      const u = new URL(link); u.searchParams.set("prefilled_email", a.email); u.searchParams.set("client_reference_id", "acct_" + a.id);
      await log("subscribe_started", { tier, term });
      res.set("Cache-Control", "no-store").redirect(303, u.toString());
    });
    const emailPage = (tier, term, err) => shell("Add your email", `<div class="card"><h2 style="margin-top:0">Add your email</h2><p style="color:#b9bcc2">Your subscription is matched to your account by email, so use the same address you will pay with.</p>${err ? `<p class="err">${esc(err)}</p>` : ""}<form method="post" action="/subscribe/email"><input type="hidden" name="tier" value="${tier}"><input type="hidden" name="term" value="${term}"><label>Email</label><input type="email" name="email" autocomplete="email" required maxlength="200"><button class="sub">Continue to payment</button></form></div>`);
    app.post("/subscribe/email", async (req, res) => {
      const s = req.session && req.session.acct; if (!s) return res.redirect(303, "/login");
      const tier = Number(req.body.tier), term = Number(req.body.term), email = String(req.body.email || "").trim().toLowerCase();
      if (limited("em:" + req.ip, 10, 600000)) return res.status(429).send("Too many attempts. Try again later.");
      if (!EMAIL.test(email) || email.length > 200) return res.status(400).send(emailPage(tier, term, "Enter a valid email address."));
      try { await pool.query("UPDATE accounts SET email=$2 WHERE id=$1", [s.id, email]); } catch (e) { if (e.code === "23505") return res.status(400).send(emailPage(tier, term, "That email is already used by another account.")); throw e; }
      await claimByEmail(s.id, email);
      res.redirect(303, `/subscribe/go?tier=${[1, 2, 3].includes(tier) ? tier : 1}&term=${TERMS.includes(term) ? term : 1}`);
    });

    app.post("/stripe/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!secret) return res.status(503).send("Webhook not configured.");
      if (!Buffer.isBuffer(req.body) || !verifySig(req.body, req.get("stripe-signature"), secret)) return res.status(400).send("Bad signature.");
      let ev; try { ev = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).send("Bad payload."); }
      try { await handle(ev); res.json({ received: true }); }
      catch (e) { console.error("stripe webhook", e.message); await log("stripe_webhook_error", { type: ev.type, error: String(e.message).slice(0, 200) }); res.status(500).send("Error."); } // Stripe retries on 5xx
    });
  }

  // The Billing tab in a project account's dashboard.
  function mountDash({ app, acctOnly, verifyOrigin, page }) {
    app.get("/dashboard/:u/billing", acctOnly, async (req, res) => {
      const a = req.acct, r = await subRow(a.id); if (!r) return res.redirect(303, "/subscribe");
      const on = ENTITLED(r), P = PLANS[on ? r.tier : 0], d = (sec) => (sec ? new Date(Number(sec) * 1000).toISOString().slice(0, 10) : "");
      const statusText = r.status === "trialing" ? `Free trial until ${d(r.trial_end || r.period_end)}` : r.status === "active" ? (r.cancel_at_period_end ? `Ends ${d(r.period_end)} (cancelled)` : `Renews ${d(r.period_end)}`) : r.status === "past_due" ? "Payment failed. Update your card in the portal" : "Not active";
      const used = await usage(a.id), msg = req.query.e ? '<div class="card" style="border-color:#7a2b35"><b>Could not open the billing portal.</b> Try again, or contact support.</div>' : "";
      page(req, res, "billing", `<div class="top"><div><h1>Billing</h1></div></div>${msg}<div class="card" style="max-width:640px"><h2 style="margin-top:0">${esc(P.name)} plan${on ? "" : " (inactive)"}</h2><p><b>${esc(statusText)}</b>${r.months ? ` · billed every ${r.months === 12 ? "year" : r.months === 1 ? "month" : r.months + " months"}` : ""}</p>
<p class="muted">Database storage: ${used} of ${nf(P.dbUsers)} users · Projects: up to ${P.projects} · Log history: ${P.logDays} days. Google Drive storage is unlimited on every plan.</p>
<form method="post" action="/dashboard/${esc(a.username)}/billing/portal"><button class="green" style="width:auto">Manage billing</button></form>
<p class="muted" style="margin-bottom:0">Opens Stripe's secure portal to change plan, update your card, see invoices or cancel.</p></div>`);
    });
    app.post("/dashboard/:u/billing/portal", acctOnly, verifyOrigin, async (req, res) => {
      const a = req.acct, r = await subRow(a.id); if (!r) return res.redirect(303, "/subscribe");
      if (limited("bp:" + a.id, 10, 600000)) return res.status(429).send("Too many attempts. Try again later.");
      try {
        const params = { customer: r.customer_id, return_url: `${origin()}/dashboard/${a.username}/billing` };
        if (process.env.STRIPE_PORTAL_CONFIG) params.configuration = process.env.STRIPE_PORTAL_CONFIG;
        const s = await stripe("POST", "/billing_portal/sessions", params);
        await log("billing_portal_opened", {}, a.username);
        res.set("Cache-Control", "no-store").redirect(303, s.url);
      } catch (e) { await log("billing_portal_error", { error: String(e.message).slice(0, 200) }, a.username); res.redirect(303, `/dashboard/${a.username}/billing?e=1`); }
    });
  }

  return { PLANS, PRICES, mountPublic, mountDash, limits, tierOf, canStore, usage, hasCustomer, claimByEmail, verifySig, handle, sendReceipt, sync, refresh, fromCheckout, linkFor, EMAIL, subRow };
};
