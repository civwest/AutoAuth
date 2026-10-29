"use strict";
// Sidebar tree used by both dashboards: each project is a toggle that opens its tabs.
const CSS = `<style>.nav details{margin:2px 0 2px 8px;border-left:1px solid var(--line)}.nav summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-radius:8px;color:var(--muted);user-select:none}.nav summary::-webkit-details-marker{display:none}.nav summary::after{content:"\\25B8";font-size:12px}.nav details[open]>summary::after{content:"\\25BE"}.nav summary:hover{background:#222a35;color:#fff}.nav summary.on{color:#fff}.nav details a{padding:8px 12px 8px 22px;margin:1px 0;font-size:14px}.nav details a.on{background:#222a35;color:#fff}</style>`;
// items: [{ name, base, tabs: [[key, label], ...] }]; here: the current path without the query string.
function tree(items, here, esc) {
  if (!items.length) return "";
  return CSS + items.map(({ name, base, tabs }) => {
    const inside = here === base || here.startsWith(base + "/");
    return `<details${inside ? " open" : ""}><summary class="${inside ? "on" : ""}">${esc(name)}</summary>${tabs.map(([k, l]) => `<a class="${here === `${base}/${k}` ? "on" : ""}" href="${base}/${k}">${esc(l)}</a>`).join("")}</details>`;
  }).join("");
}
const hereOf = (req) => String((req && (req.originalUrl || req.url)) || "").split("?")[0].replace(/\/+$/, "");
module.exports = { tree, hereOf };
