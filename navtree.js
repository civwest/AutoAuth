"use strict";
// Sidebar tree used by both dashboards: each project is a toggle that opens its tabs.
const CSS = `<style>.nav details{margin:2px 0 2px 8px;border-left:1px solid var(--line)}.nav summary{cursor:pointer;list-style:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px;border-radius:8px;color:var(--muted);user-select:none}.nav summary::-webkit-details-marker{display:none}.nav summary::after{content:"\\25B8";font-size:12px}.nav details[open]>summary::after{content:"\\25BE"}.nav summary:hover{background:#222a35;color:#fff}.nav summary.on{color:#fff}.nav details a{padding:8px 12px 8px 22px;margin:1px 0;font-size:14px}.nav details a.on{background:#222a35;color:#fff}</style>`;
// A project only shows in the sidebar after it was opened in this browser. "Close" on the Side Projects page hides it again.
const SCRIPT = `<noscript><style>.nav details[data-b]{display:block!important}</style></noscript><script>(function(){var K="aa_open_projects";function rd(){try{var a=JSON.parse(localStorage.getItem(K)||"[]");return Array.isArray(a)?a:[];}catch(e){return[];}}function wr(a){try{localStorage.setItem(K,JSON.stringify(a));}catch(e){}}
function paint(){var o=rd(),i,d=document.querySelectorAll(".nav details[data-b]"),c=document.querySelectorAll("[data-close]");for(i=0;i<d.length;i++)d[i].hidden=o.indexOf(d[i].getAttribute("data-b"))<0;for(i=0;i<c.length;i++)c[i].hidden=o.indexOf(c[i].getAttribute("data-close"))<0;}
window.aaClose=function(b){wr(rd().filter(function(x){return x!==b;}));paint();};
var p=location.pathname.replace(/\\/+$/,""),ds=document.querySelectorAll(".nav details[data-b]"),k;for(k=0;k<ds.length;k++){var b=ds[k].getAttribute("data-b");if(p===b||p.indexOf(b+"/")===0){var o=rd();if(o.indexOf(b)<0){o.push(b);wr(o);}}}
paint();document.addEventListener("DOMContentLoaded",paint);})();</script>`;
// items: [{ name, base, tabs: [[key, label], ...] }]; here: the current path without the query string.
function tree(items, here, esc) {
  if (!items.length) return "";
  return CSS + items.map(({ name, base, tabs }) => {
    const inside = here === base || here.startsWith(base + "/");
    return `<details data-b="${esc(base)}" hidden${inside ? " open" : ""}><summary class="${inside ? "on" : ""}">${esc(name)}</summary>${tabs.map(([k, l]) => `<a class="${here === `${base}/${k}` ? "on" : ""}" href="${base}/${k}">${esc(l)}</a>`).join("")}</details>`;
  }).join("") + SCRIPT;
}
const hereOf = (req) => String((req && (req.originalUrl || req.url)) || "").split("?")[0].replace(/\/+$/, "");
module.exports = { tree, hereOf };
