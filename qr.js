"use strict";
// Minimal QR code generator (byte mode, error correction level M, versions 1-10). No dependencies.
// qrSvg(text) returns an inline <svg>; throws if the text is longer than 213 bytes.
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function rsGen(n) { let g = [1]; for (let i = 0; i < n; i++) { const r = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { r[j] ^= g[j]; r[j + 1] ^= mul(g[j], EXP[i]); } g = r; } return g; }
function rsRem(data, n) { const g = rsGen(n), r = new Array(n).fill(0); for (const b of data) { const f = b ^ r.shift(); r.push(0); if (f) for (let i = 0; i < n; i++) r[i] ^= mul(g[i + 1], f); } return r; }
// [ecc codewords per block, [blocks, data codewords] groups] for level M
const VER = [null, [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]], [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const bch = (v, poly, bits) => { let r = v << bits; const top = poly.toString(2).length - 1; for (let i = r.toString(2).length - 1; i >= top; i--) if (r >> i & 1) r ^= poly << (i - top); return (v << bits) | r; };
const MASKS = [(r, c) => (r + c) % 2 === 0, (r) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];

function build(bytes) {
  let v = 1; const cap = (x) => VER[x][1].reduce((s, [n, d]) => s + n * d, 0);
  while (v <= 10 && cap(v) < bytes.length + 2 + (v > 9 ? 1 : 0)) v++;
  if (v > 10) throw new Error("QR text too long");
  const total = cap(v), bits = [], put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push(val >> i & 1); };
  put(4, 4); put(bytes.length, v > 9 ? 16 : 8); for (const b of bytes) put(b, 8);
  put(0, Math.min(4, total * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let p = 0; data.length < total; p++) data.push(p % 2 ? 0x11 : 0xec);
  const [ecn, groups] = VER[v], blocks = []; let o = 0;
  for (const [n, d] of groups) for (let i = 0; i < n; i++) { const b = data.slice(o, o + d); o += d; blocks.push({ d: b, e: rsRem(b, ecn) }); }
  const out = []; const maxd = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxd; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecn; i++) for (const b of blocks) out.push(b.e[i]);
  const N = 17 + 4 * v, M = Array.from({ length: N }, () => new Array(N).fill(null)), fn = Array.from({ length: N }, () => new Array(N).fill(false));
  const set = (r, c, val) => { if (r >= 0 && c >= 0 && r < N && c < N) { M[r][c] = val; fn[r][c] = true; } };
  const finder = (r0, c0) => { for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) set(r0 + r, c0 + c, r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))); };
  finder(0, 0); finder(0, N - 7); finder(N - 7, 0);
  const al = ALIGN[v]; for (const r of al) for (const c of al) { if (fn[r][c]) continue; for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) set(r + a, c + b, Math.max(Math.abs(a), Math.abs(b)) !== 1); }
  for (let i = 8; i < N - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  set(N - 8, 8, true);
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(8, i, false); if (!fn[i][8]) set(i, 8, false); }
  for (let i = 0; i < 8; i++) { if (!fn[8][N - 1 - i]) set(8, N - 1 - i, false); if (!fn[N - 1 - i][8]) set(N - 1 - i, 8, false); }
  if (v >= 7) { const vi = bch(v, 0x1f25, 12); for (let i = 0; i < 18; i++) { const bit = !!(vi >> i & 1), a = Math.floor(i / 3), b = i % 3 + N - 11; set(a, b, bit); set(b, a, bit); } }
  const stream = []; for (const b of out) for (let i = 7; i >= 0; i--) stream.push(b >> i & 1);
  const place = (mask) => {
    const G = M.map((row) => row.slice()); let k = 0, up = true;
    for (let c = N - 1; c > 0; c -= 2) { if (c === 6) c--; for (let i = 0; i < N; i++) { const r = up ? N - 1 - i : i; for (const cc of [c, c - 1]) if (!fn[r][cc]) { const bit = k < stream.length ? stream[k++] : 0; G[r][cc] = !!bit !== MASKS[mask](r, cc); } } up = !up; }
    const fmt = bch(0 << 3 | mask, 0x537, 10) ^ 0x5412;
    const f = (r, c, val) => { G[r][c] = val; };
    for (let i = 0; i < 15; i++) { const bit = !!(fmt >> i & 1);
      if (i < 6) f(i, 8, bit); else if (i < 8) f(i + 1, 8, bit); else f(N - 15 + i, 8, bit);
      if (i < 8) f(8, N - 1 - i, bit); else if (i < 9) f(8, 15 - i, bit); else f(8, 14 - i, bit); }
    return G;
  };
  const penalty = (G) => {
    let p = 0;
    for (let r = 0; r < N; r++) for (const get of [(a, b) => G[r][b], (a, b) => G[b][r]]) { let run = 1; for (let c = 1; c < N; c++) { if (get(r, c) === get(r, c - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let r = 0; r < N - 1; r++) for (let c = 0; c < N - 1; c++) if (G[r][c] === G[r][c + 1] && G[r][c] === G[r + 1][c] && G[r][c] === G[r + 1][c + 1]) p += 3;
    const dark = G.flat().filter(Boolean).length; p += Math.floor(Math.abs(dark * 20 - N * N * 10) / (N * N)) * 10;
    return p;
  };
  let best = null, bp = Infinity; for (let m = 0; m < 8; m++) { const G = place(m), p = penalty(G); if (p < bp) { bp = p; best = G; } }
  return best;
}
function qrSvg(text, { size = 220, dark = "#000", light = "#fff" } = {}) {
  const G = build(Buffer.from(String(text), "utf8")), N = G.length, q = 4; let d = "";
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (G[r][c]) d += `M${c + q},${r + q}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N + 2 * q} ${N + 2 * q}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="100%" height="100%" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`;
}
module.exports = { qrSvg };
