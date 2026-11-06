/* CAD2SV: PDF-Plan nachzeichnen und als Soundvision-"3D room data" (.txt) exportieren.
   Weltkoordinaten in Metern: X/Y = Grundriss, Z = Höhe (rechtshändig).
   Ansichten projizieren die Welt auf (u,v): top = (x,y), side = (x,z), front = (y,z). */
(() => {
'use strict';
const $ = (id) => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d');
const PT_PER_M = 72 / 0.0254;          // PDF-Punkte pro echtem Meter auf dem Papier
const COLORS = { audience: '#e8890c', stage: '#1f7ae0', wall: '#6b7686', avoid: '#e04444', keepclear: '#12a56f' };
const TOOL_HINT = {
  select: 'Fläche oder Eckpunkt ziehen, mit Shift nur senkrecht oder waagrecht. Leere Stelle ziehen verschiebt die Ansicht.',
  rect: 'Rechteck: erste Ecke, dann gegenüberliegende Ecke. Shift ergibt ein Quadrat.',
  rrect: 'Schräges Rechteck: Kante mit zwei Klicks festlegen, dritter Klick setzt die Breite.',
  poly: 'Polygon: Punkte klicken. Enter, Doppelklick oder Klick auf den ersten Punkt schließt. Rücktaste nimmt einen Punkt zurück.',
  circle: 'Kreis: Mittelpunkt klicken, dann den Radius.',
  ring: 'Bogen: Mittelpunkt, Anfang am Außenradius, Ende, zuletzt Innenradius.',
  scale: 'Skalieren: Anfang und Ende einer Strecke klicken, deren echtes Maß du kennst.',
  origin: 'Nullpunkt: auf die Stelle im Plan klicken, die Koordinate 0 werden soll.',
  align: 'Ausrichten: zwei Punkte auf einer Linie klicken, die zur horizontalen Achse werden soll.',
  measure: 'Messen: zwei Punkte klicken.',
};

const newView = () => ({ bg: null, ppm: PT_PER_M / 100, calibrated: false, originSet: false, ox: 0, oy: 0, rot: 0, flip: false, opacity: 1 });
const S = {
  pdfs: [], views: { top: newView(), side: newView(), front: newView() }, shapes: [], nextId: 1,
  sel: null, view: 'top', tool: 'select', drawZ: 0, sliceY: 0, sliceX: 0, label: 'Audience',
};
const cams = {
  top: { cx: 0, cy: 0, zoom: 12 }, side: { cx: 0, cy: 5, zoom: 12 }, front: { cx: 0, cy: 5, zoom: 12 },
  iso: { az: -0.6, el: 0.75, tx: 0, ty: 0, tz: 0, zoom: 10 },
};
let W = 800, H = 600, dpr = 1;
let draft = null, hover = null, snapHit = null, press = null, drag = null, spaceDown = false, measure = null, snapDisabled = false;
let undoStack = [], redoStack = [], planCache = new Map(), isoFaces = [];
let pdfReady = null, crisp = null, crispTask = null, crispTimer = 0;

/* ---------- Mathe ---------- */
const mul = (m, n) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1], m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3], m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
const inv = (m) => { const d = m[0]*m[3]-m[1]*m[2]; return [m[3]/d, -m[1]/d, -m[2]/d, m[0]/d, (m[2]*m[5]-m[3]*m[4])/d, (m[1]*m[4]-m[0]*m[5])/d]; };
const ap = (m, x, y) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
const num = (v) => { const n = parseFloat(String(v).trim().replace(',', '.')); return Number.isFinite(n) ? n : null; };
const fmt = (n, d = 2) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const inputNum = (n) => String(Math.round(n * 1000) / 1000).replace('.', ',');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function plan2uv(V) {
  const c = Math.cos(V.rot), s = Math.sin(V.rot), f = V.flip ? -1 : 1;
  const a = f * c / V.ppm, cc = f * s / V.ppm, b = s / V.ppm, d = -c / V.ppm;
  return [a, b, cc, d, -(a * V.ox + cc * V.oy), -(b * V.ox + d * V.oy)];
}
const uv2screen = (cam) => [cam.zoom, 0, 0, -cam.zoom, W / 2 - cam.cx * cam.zoom, H / 2 + cam.cy * cam.zoom];
const uvOf = (p, vk) => vk === 'top' ? [p.x, p.y] : vk === 'side' ? [p.x, p.z] : [p.y, p.z];
function setUV(p, vk, u, v) {
  if (vk === 'top') { p.x = u; p.y = v; } else if (vk === 'side') { p.x = u; p.z = v; } else { p.y = u; p.z = v; }
}
function toWorld(u, v) {
  if (S.view === 'top') return { x: u, y: v, z: S.drawZ };
  if (S.view === 'side') return { x: u, y: S.sliceY, z: v };
  return { x: S.sliceX, y: u, z: v };
}
const is3D = () => S.view === 'iso';
const curView = () => S.views[is3D() ? 'top' : S.view];

/* ---------- Geometrie: alles wird zu Dreiecken ---------- */
function newell(pts) {
  let nx = 0, ny = 0, nz = 0;
  pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length];
    nx += (p.y - q.y) * (p.z + q.z); ny += (p.z - q.z) * (p.x + q.x); nz += (p.x - q.x) * (p.y + q.y); });
  return [nx, ny, nz];
}
function triangulate(pts) {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [[pts[0], pts[1], pts[2]]];
  const N = newell(pts), ax = N.map(Math.abs), drop = ax[2] >= ax[0] && ax[2] >= ax[1] ? 2 : ax[0] >= ax[1] ? 0 : 1;
  const keys = ['x', 'y', 'z'].filter((_, i) => i !== drop);
  const orient = (N[drop] >= 0 ? 1 : -1) * (drop === 1 ? -1 : 1);     // Projektion in die dominante Ebene
  const P = pts.map((p) => [p[keys[0]], p[keys[1]]]);
  const cross = (a, b, c) => (P[b][0]-P[a][0])*(P[c][1]-P[a][1]) - (P[b][1]-P[a][1])*(P[c][0]-P[a][0]);
  const inTri = (a, b, c, p) => cross(a, b, p) * orient >= -1e-12 && cross(b, c, p) * orient >= -1e-12 && cross(c, a, p) * orient >= -1e-12;
  const idx = pts.map((_, i) => i), tris = [];
  let guard = n * n + 5;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (cross(a, b, c) * orient <= 1e-12) continue;
      if (idx.some((k) => k !== a && k !== b && k !== c && inTri(a, b, c, k))) continue;
      tris.push([pts[a], pts[b], pts[c]]); idx.splice(i, 1); clipped = true; break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) tris.push([pts[idx[0]], pts[idx[1]], pts[idx[2]]]);
  else for (let i = 1; i < idx.length - 1; i++) tris.push([pts[idx[0]], pts[idx[i]], pts[idx[i + 1]]]);
  return tris;
}
const sweepOf = (s) => Math.min(360, Math.max(0.1, s.a1 - s.a0));
function tess(s) {
  if (s.type === 'poly') return { tris: triangulate(s.pts), loops: [s.pts] };
  const sw = sweepOf(s), full = sw >= 359.999, n = Math.max(3, Math.ceil(s.seg * sw / 360));
  const O = [], I = [], hasInner = s.ri > 1e-6;
  for (let i = 0; i <= n; i++) {
    const a = (s.a0 + sw * i / n) * Math.PI / 180, c = Math.cos(a), d = Math.sin(a);
    O.push({ x: s.c.x + s.r * c, y: s.c.y + s.r * d, z: s.zo });
    I.push(hasInner ? { x: s.c.x + s.ri * c, y: s.c.y + s.ri * d, z: s.z } : { x: s.c.x, y: s.c.y, z: s.z });
  }
  const tris = [];
  for (let i = 0; i < n; i++) {
    tris.push([I[i], O[i], O[i + 1]]);
    if (hasInner) tris.push([I[i], O[i + 1], I[i + 1]]);
  }
  let loops;
  if (full) { loops = [O.slice(0, -1)]; if (hasInner) loops.push(I.slice(0, -1)); }
  else loops = [hasInner ? O.concat(I.slice().reverse()) : O.concat([I[0]])];
  return { tris, loops };
}
const allPoints = (s) => tess(s).loops.flat();

function labelColor(label) {
  const k = String(label).toLowerCase().replace(/[^a-z]/g, '');
  for (const key in COLORS) if (k.startsWith(key)) return COLORS[key];
  let h = 0; for (const c of k) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 42%)`;
}

/* ---------- Export ---------- */
function cleanLabel(l) {
  const map = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss' };
  const out = String(l).replace(/[äöüÄÖÜß]/g, (c) => map[c]).replace(/["\r\n]/g, ' ').replace(/[^\x20-\x7E]/g, '').trim();
  return out || 'Surface';
}
const nstr = (v) => { const r = Math.round(v * 1000) / 1000; return String(r === 0 ? 0 : r); };
function exportTriangles(rotDeg = 0) {
  const a = rotDeg * Math.PI / 180, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  const out = [];
  for (const sh of S.shapes) {
    if (sh.visible === false) continue;
    for (const t of tess(sh).tris) {
      let v = t.map((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z }));
      const ux = v[1].x-v[0].x, uy = v[1].y-v[0].y, uz = v[1].z-v[0].z, wx = v[2].x-v[0].x, wy = v[2].y-v[0].y, wz = v[2].z-v[0].z;
      const nx = uy*wz-uz*wy, ny = uz*wx-ux*wz, nz = ux*wy-uy*wx, len = Math.hypot(nx, ny, nz);
      if (len < 1e-7) continue;                                   // entartetes Dreieck
      if (Math.abs(nz) > 1e-6 * len && nz < 0) v = v.reverse();   // Vorderseite (weiß) nach oben
      if (sh.flip) v = v.slice().reverse();
      out.push({ label: cleanLabel(sh.label), v });
    }
  }
  return out;
}
function exportText(rotDeg = 0) {
  let t = '"; Exported by CAD2SV"\n"; "\n";   using Outside is front (white)"\n";   using Name By Layer"\n";   using Visible Entities"\n";"\n";"\n";"\n"; LengthUnit", "m"\n";"\n';
  for (const tri of exportTriangles(rotDeg)) {
    t += `"Label","${tri.label}"\n`;
    for (const p of tri.v) t += `${nstr(p.x)},${nstr(p.y)},${nstr(p.z)}\n`;
    t += '";"\n';
  }
  return t;
}

/* ---------- Undo ---------- */
const snapshot = () => JSON.stringify({ views: S.views, shapes: S.shapes, nextId: S.nextId });
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 150) undoStack.shift(); redoStack = []; }
function restore(json) {
  const d = JSON.parse(json);
  S.views = d.views; S.shapes = d.shapes; S.nextId = d.nextId;
  if (!S.shapes.some((s) => s.id === S.sel)) S.sel = null;
  ensurePlanBitmaps(); invalidateCrisp(); scheduleCrisp(); changed();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

/* Kalibrierung ändern: der Plan bleibt am Bildschirm stehen.
   In der Draufsicht wandern die Flächen mit dem Plan mit (sie sind darauf gezeichnet).
   Schnitte sind nur Hintergrund, dort bleibt die Welt wie sie ist. */
function recalibrate(vk, mutate) {
  const V = S.views[vk], before = plan2uv(V);
  mutate(V);
  const T = mul(plan2uv(V), inv(before)), scale = Math.hypot(T[0], T[1]), rot = Math.atan2(T[1], T[0]) * 180 / Math.PI;
  const cam = cams[vk]; const [cx, cy] = ap(T, cam.cx, cam.cy); cam.cx = cx; cam.cy = cy; cam.zoom /= scale;
  if (vk === 'top') for (const s of S.shapes) {
    if (s.type === 'poly') s.pts.forEach((p) => { [p.x, p.y] = ap(T, p.x, p.y); });
    else { [s.c.x, s.c.y] = ap(T, s.c.x, s.c.y); s.r *= scale; s.ri *= scale; s.a0 += rot; s.a1 += rot; }
  }
  invalidateCrisp(); scheduleCrisp();
}

/* ---------- PDF ---------- */
function loadPdfjs() {
  if (pdfReady) return pdfReady;
  const addScript = (src) => new Promise((res, rej) => { const e = document.createElement('script'); e.src = src; e.onload = res; e.onerror = rej; document.head.appendChild(e); });
  pdfReady = (async () => {
    for (const base of window.PDFJS_SOURCES) {
      try {
        await addScript(base + 'pdf.min.js');
        if (location.protocol === 'file:') await addScript(base + 'pdf.worker.min.js');   // file:// erlaubt keinen Worker
        else window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
        return window.pdfjsLib;
      } catch (e) { /* nächste Quelle */ }
    }
    pdfReady = null;
    throw new Error('pdf.js konnte nicht geladen werden. Internet nötig oder vendor/ befüllen (siehe README).');
  })();
  return pdfReady;
}
async function addPdf(name, bytes, id) {
  const lib = await loadPdfjs();
  const doc = await lib.getDocument({ data: bytes.slice() }).promise;
  const rec = { id: id || 'pdf' + Date.now() + Math.floor(Math.random() * 1000), name, bytes, doc };
  S.pdfs.push(rec);
  return rec;
}
const cacheKey = (bg) => bg.pdfId + '#' + bg.page;
function planEntry(bg) {
  const key = cacheKey(bg);
  if (!planCache.has(key)) {
    const e = { canvas: null, w: 0, h: 0, rs: 1, page: null, grid: null, cell: 1 };
    planCache.set(key, e);
    renderBase(bg, e).catch((err) => { console.error(err); toast('Plan konnte nicht gerendert werden: ' + err.message, true); });
  }
  return planCache.get(key);
}
async function renderBase(bg, e) {
  const rec = S.pdfs.find((p) => p.id === bg.pdfId);
  if (!rec) return;
  const page = await rec.doc.getPage(bg.page);
  const vp1 = page.getViewport({ scale: 1 });
  e.page = page; e.w = vp1.width; e.h = vp1.height;
  const rs = Math.min(5000 / Math.max(vp1.width, vp1.height), 5);
  const c = document.createElement('canvas'), vp = page.getViewport({ scale: rs });
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  e.rs = rs;
  render();
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  e.canvas = c;
  render(); scheduleCrisp();
  buildSnapPoints(page, vp1, e).catch((err) => console.warn('Fangpunkte:', err));
}
async function buildSnapPoints(page, vp, e) {
  const O = window.pdfjsLib.OPS, list = await page.getOperatorList();
  const seen = new Set(), xs = [], ys = [], MAX = 500000, base = vp.transform;
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
  const add = (x, y) => {
    if (xs.length >= MAX) return;
    const [px, py] = ap(mul(base, ctm), x, y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    const k = Math.round(px * 20) + ':' + Math.round(py * 20);
    if (seen.has(k)) return; seen.add(k); xs.push(px); ys.push(py);
  };
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i], a = list.argsArray[i];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() || ctm;
    else if (fn === O.transform) ctm = mul(ctm, a);
    else if (fn === O.paintFormXObjectBegin) { stack.push(ctm); if (a[0]) ctm = mul(ctm, a[0]); }
    else if (fn === O.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === O.constructPath) {
      const ops = a[0], co = a[1]; let j = 0, cx = 0, cy = 0, sx = 0, sy = 0;
      for (const op of ops) {
        if (op === O.moveTo) { cx = sx = co[j]; cy = sy = co[j + 1]; j += 2; add(cx, cy); }
        else if (op === O.lineTo) { const x = co[j], y = co[j + 1]; j += 2; add(x, y); add((cx + x) / 2, (cy + y) / 2); cx = x; cy = y; }
        else if (op === O.curveTo) { cx = co[j + 4]; cy = co[j + 5]; j += 6; add(cx, cy); }
        else if (op === O.curveTo2 || op === O.curveTo3) { cx = co[j + 2]; cy = co[j + 3]; j += 4; add(cx, cy); }
        else if (op === O.rectangle) {
          const x = co[j], y = co[j + 1], w = co[j + 2], h = co[j + 3]; j += 4;
          add(x, y); add(x + w, y); add(x + w, y + h); add(x, y + h); add(x + w / 2, y); add(x + w, y + h / 2); add(x + w / 2, y + h); add(x, y + h / 2);
          cx = sx = x; cy = sy = y;
        } else if (op === O.closePath) { add((cx + sx) / 2, (cy + sy) / 2); cx = sx; cy = sy; }
      }
    }
  }
  const cell = Math.max(e.w, e.h) / 400, grid = new Map();
  xs.forEach((x, i) => { const k = Math.floor(x / cell) * 100000 + Math.floor(ys[i] / cell); let g = grid.get(k); if (!g) grid.set(k, g = []); g.push(i); });
  e.xs = xs; e.ys = ys; e.grid = grid; e.cell = cell;
  renderPanels();
}
function nearestPlanPoint(e, x, y, r) {
  if (!e.grid) return null;
  const n = Math.ceil(r / e.cell);
  if (n > 40) return null;
  const c0 = Math.floor(x / e.cell), c1 = Math.floor(y / e.cell);
  let best = null, bd = r * r;
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const g = e.grid.get((c0 + i) * 100000 + (c1 + j)); if (!g) continue;
    for (const k of g) { const d = (e.xs[k] - x) ** 2 + (e.ys[k] - y) ** 2; if (d < bd) { bd = d; best = [e.xs[k], e.ys[k]]; } }
  }
  return best;
}
function ensurePlanBitmaps() { for (const k of ['top', 'side', 'front']) if (S.views[k].bg) planEntry(S.views[k].bg); }

/* Beim Hineinzoomen scharf nachrendern: nur der sichtbare Ausschnitt. */
function invalidateCrisp() { crisp = null; if (crispTask) { crispTask.cancel(); crispTask = null; } clearTimeout(crispTimer); }
function scheduleCrisp() {
  clearTimeout(crispTimer);
  if (crispTask) { crispTask.cancel(); crispTask = null; }
  crispTimer = setTimeout(renderCrisp, 220);
}
async function renderCrisp() {
  if (is3D()) return;
  const V = S.views[S.view]; if (!V.bg) return;
  const e = planEntry(V.bg); if (!e.page || !e.canvas) return;
  const M = mul(uv2screen(cams[S.view]), plan2uv(V));
  /* Auch beim Herauszoomen neu rendern: stark verkleinerte Bitmaps verlieren dünne CAD-Linien. */
  const ratio = Math.hypot(M[0], M[1]) * dpr / e.rs;
  if (ratio > 0.8 && ratio <= 1.1) { crisp = null; render(); return; }
  const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
  const task = e.page.render({ canvasContext: c.getContext('2d'), viewport: e.page.getViewport({ scale: 1 }), transform: M.map((v) => v * dpr), background: 'rgba(0,0,0,0)' });
  crispTask = task;
  try { await task.promise; } catch (err) { return; }
  if (crispTask !== task) return;
  crispTask = null;
  crisp = { canvas: c, M, view: S.view, key: cacheKey(V.bg) };
  render();
}

/* ---------- Zeichnen ---------- */
let renderQueued = false;
function render() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; draw(); }); }
function resize() {
  const r = $('canvasWrap').getBoundingClientRect();
  W = Math.max(50, r.width); H = Math.max(50, r.height); dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  invalidateCrisp(); scheduleCrisp(); render();
}
function setM(m) { ctx.setTransform(m[0]*dpr, m[1]*dpr, m[2]*dpr, m[3]*dpr, m[4]*dpr, m[5]*dpr); }
const resetM = () => ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

function drawPlan(V, M, alphaScale = 1, useCrisp = true) {
  if (!V.bg) return;
  const e = planEntry(V.bg);
  if (!e.w) return;
  setM(M);
  ctx.globalAlpha = V.opacity * alphaScale;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, e.w, e.h);
  if (e.canvas) { ctx.imageSmoothingEnabled = true; ctx.drawImage(e.canvas, 0, 0, e.w, e.h); }
  if (useCrisp && crisp && crisp.view === S.view && crisp.key === cacheKey(V.bg)) {
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, e.w, e.h); ctx.clip();
    ctx.fillRect(0, 0, e.w, e.h);                  // Basisbild abdecken, sonst doppelte Linien beim Verschieben
    setM(mul(M, inv(crisp.M)));
    ctx.drawImage(crisp.canvas, 0, 0, W, H);
    ctx.restore();
  }
  ctx.globalAlpha = 1; resetM();
}
function niceStep(zoom) { for (const s of [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) if (s * zoom >= 44) return s; return 2000; }
function drawGrid(cam, vk) {
  const step = niceStep(cam.zoom), M = uv2screen(cam);
  const [u0, v1] = ap(inv(M), 0, 0), [u1, v0] = ap(inv(M), W, H);
  ctx.lineWidth = 1;
  ctx.strokeStyle = S.views[vk].bg ? 'rgba(40,110,190,.16)' : 'rgba(255,255,255,.09)';
  ctx.beginPath();
  for (let u = Math.ceil(u0 / step) * step; u <= u1; u += step) { const [x] = ap(M, u, 0); ctx.moveTo(Math.round(x) + .5, 0); ctx.lineTo(Math.round(x) + .5, H); }
  for (let v = Math.ceil(v0 / step) * step; v <= v1; v += step) { const [, y] = ap(M, 0, v); ctx.moveTo(0, Math.round(y) + .5); ctx.lineTo(W, Math.round(y) + .5); }
  ctx.stroke();
}
function halo(text, x, y, color = '#fff', align = 'left') {
  ctx.font = '600 12px -apple-system, Helvetica, Arial, sans-serif';
  ctx.textAlign = align; ctx.lineJoin = 'round';
  ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}
function arrow(x0, y0, x1, y1, color, label) {
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath(); ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - 9 * Math.cos(a - .4), y1 - 9 * Math.sin(a - .4));
  ctx.lineTo(x1 - 9 * Math.cos(a + .4), y1 - 9 * Math.sin(a + .4)); ctx.fill();
  halo(label, x1 + 8 * Math.cos(a) - 3, y1 + 8 * Math.sin(a) + 4, color);
}
function drawOrigin(cam, vk) {
  const [x, y] = ap(uv2screen(cam), 0, 0);
  const names = { top: ['X', 'Y'], side: ['X', 'Z'], front: ['Y', 'Z'] }[vk];
  const col = { X: '#e5484d', Y: '#2fb86a', Z: '#3e8bff' };
  arrow(x, y, x + 52, y, col[names[0]], names[0]);
  arrow(x, y, x, y - 52, col[names[1]], names[1]);
  ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 7); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#111'; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 2, 0, 7); ctx.fillStyle = '#111'; ctx.fill();
}
function shapePath(loops, proj) {
  ctx.beginPath();
  for (const lp of loops) { lp.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); }
}
function drawShapes2D(cam, vk) {
  const M = uv2screen(cam), proj = (p) => { const [u, v] = uvOf(p, vk); return ap(M, u, v); };
  for (const s of S.shapes) {
    if (s.visible === false) continue;
    const t = tess(s), col = labelColor(s.label), on = s.id === S.sel;
    ctx.globalAlpha = on ? .42 : .26; ctx.fillStyle = col;
    ctx.beginPath();
    for (const tr of t.tris) { tr.forEach((p, i) => { const [x, y] = proj(p); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.closePath(); }
    ctx.fill('nonzero');
    ctx.globalAlpha = 1;
    shapePath(t.loops, proj);
    if (on) { ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.stroke(); }
    ctx.lineWidth = on ? 2 : 1.5; ctx.strokeStyle = col; ctx.stroke();
    if (vk === 'top' && cam.zoom > 3) {
      const pts = t.loops[0]; let cx = 0, cy = 0; pts.forEach((p) => { const [x, y] = proj(p); cx += x; cy += y; });
      halo(s.label, cx / pts.length, cy / pts.length + 4, '#fff', 'center');
    }
  }
}
function handlesOf(s, vk) {
  const out = [];
  if (s.type === 'poly') {
    const groups = new Map();
    s.pts.forEach((p, i) => { const [u, v] = uvOf(p, vk), k = Math.round(u * 500) + ':' + Math.round(v * 500); if (!groups.has(k)) groups.set(k, { u, v, kind: 'v', idxs: [] }); groups.get(k).idxs.push(i); });
    out.push(...groups.values());
    if (vk === 'top') s.pts.forEach((p, i) => { const q = s.pts[(i + 1) % s.pts.length]; if (Math.hypot(p.x - q.x, p.y - q.y) * cams.top.zoom > 40) out.push({ u: (p.x + q.x) / 2, v: (p.y + q.y) / 2, kind: 'mid', i }); });
    return out;
  }
  const am = (s.a0 + sweepOf(s) / 2) * Math.PI / 180, full = sweepOf(s) >= 359.999;
  if (vk === 'top') {
    const a = full ? 0 : am;
    out.push({ u: s.c.x, v: s.c.y, kind: 'c' });
    out.push({ u: s.c.x + s.r * Math.cos(a), v: s.c.y + s.r * Math.sin(a), kind: 'ro' });
    if (s.ri > 1e-6) out.push({ u: s.c.x + s.ri * Math.cos(a), v: s.c.y + s.ri * Math.sin(a), kind: 'ri' });
    if (!full) {
      const a0 = s.a0 * Math.PI / 180, a1 = s.a1 * Math.PI / 180;
      out.push({ u: s.c.x + s.r * Math.cos(a0), v: s.c.y + s.r * Math.sin(a0), kind: 'a0' });
      out.push({ u: s.c.x + s.r * Math.cos(a1), v: s.c.y + s.r * Math.sin(a1), kind: 'a1' });
    }
  } else {
    const cu = vk === 'side' ? s.c.x : s.c.y;
    out.push({ u: cu + s.r, v: s.zo, kind: 'zo' }, { u: cu - s.r, v: s.zo, kind: 'zo' });
    out.push({ u: cu + s.ri, v: s.z, kind: 'z' });
    if (s.ri > 1e-6) out.push({ u: cu - s.ri, v: s.z, kind: 'z' });
  }
  return out;
}
function drawHandles(cam, vk) {
  const s = S.shapes.find((x) => x.id === S.sel); if (!s || s.visible === false) return;
  const M = uv2screen(cam);
  for (const h of handlesOf(s, vk)) {
    const [x, y] = ap(M, h.u, h.v);
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#111';
    if (h.kind === 'mid') { ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 7); ctx.fill(); ctx.stroke(); }
    else { ctx.fillStyle = '#fff'; ctx.fillRect(x - 4.5, y - 4.5, 9, 9); ctx.strokeRect(x - 4.5, y - 4.5, 9, 9); }
  }
}
function drawDraft(cam) {
  const M = uv2screen(cam), m = (u, v) => ap(M, u, v);
  const seg = (a, b, col = '#e5484d', w = 2) => { const p = m(a[0], a[1]), q = m(b[0], b[1]); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); };
  const dot = (a) => { const p = m(a[0], a[1]); ctx.fillStyle = '#e5484d'; ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, 7); ctx.fill(); };
  const tag = (txt) => { if (hover) { const p = m(hover.u, hover.v); halo(txt, p[0] + 14, p[1] - 12, '#ffd27a'); } };
  if (measure && measure.a && measure.b) {
    seg(measure.a, measure.b, '#00b8d9'); dot(measure.a); dot(measure.b);
    const p = m((measure.a[0] + measure.b[0]) / 2, (measure.a[1] + measure.b[1]) / 2);
    halo(fmt(Math.hypot(measure.a[0] - measure.b[0], measure.a[1] - measure.b[1])) + ' m', p[0] + 8, p[1] - 8, '#7fe7ff');
  }
  if (!draft || !draft.pts.length) return;
  const P = draft.pts, cur = hover ? [hover.u, hover.v] : null;
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const styleFill = () => { ctx.globalAlpha = .25; ctx.fillStyle = '#e5484d'; ctx.fill(); ctx.globalAlpha = 1; ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 2; ctx.stroke(); };
  const fillPoly = (pts) => { ctx.beginPath(); pts.forEach((a, i) => { const p = m(a[0], a[1]); i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); }); ctx.closePath(); styleFill(); };
  P.forEach(dot);
  const T = draft.tool;
  if (T === 'rect' && cur) { fillPoly([P[0], [cur[0], P[0][1]], cur, [P[0][0], cur[1]]]); tag(`${fmt(Math.abs(cur[0] - P[0][0]))} × ${fmt(Math.abs(cur[1] - P[0][1]))} m`); }
  else if (T === 'rrect') {
    if (P.length === 1 && cur) { seg(P[0], cur); tag(fmt(d(P[0], cur)) + ' m'); }
    else if (cur) { const q = rrectCorners(P[0], P[1], cur); fillPoly(q); tag(`${fmt(d(P[0], P[1]))} × ${fmt(d(q[1], q[2]))} m`); }
  } else if (T === 'poly') {
    P.forEach((a, i) => { if (i) seg(P[i - 1], a); });
    if (cur) { seg(P[P.length - 1], cur); tag(fmt(d(P[P.length - 1], cur)) + ' m'); }
  } else if (T === 'circle' && cur) {
    const r = d(P[0], cur), p = m(P[0][0], P[0][1]);
    ctx.beginPath(); ctx.arc(p[0], p[1], r * cam.zoom, 0, 7); styleFill();
    tag('r = ' + fmt(r) + ' m');
  } else if (T === 'ring') {
    if (P.length === 1 && cur) { seg(P[0], cur); tag('r = ' + fmt(d(P[0], cur)) + ' m'); }
    else if (P.length >= 2) {
      const r = d(P[0], P[1]), a0 = Math.atan2(P[1][1] - P[0][1], P[1][0] - P[0][0]);
      const sw = draft.sweep || 0, ri = P.length === 3 && cur ? Math.min(d(P[0], cur), r) : 0;
      const p = m(P[0][0], P[0][1]);
      ctx.beginPath(); ctx.arc(p[0], p[1], r * cam.zoom, -a0, -(a0 + sw), sw > 0);
      if (ri > 0) ctx.arc(p[0], p[1], ri * cam.zoom, -(a0 + sw), -a0, sw < 0); else ctx.lineTo(p[0], p[1]);
      ctx.closePath(); styleFill();
      tag(P.length === 3 ? 'innen ' + fmt(ri) + ' m' : fmt(Math.abs(sw) * 180 / Math.PI, 1) + '°');
    }
  } else if ((T === 'scale' || T === 'measure' || T === 'align') && cur) {
    seg(P[0], cur, T === 'scale' ? '#e5484d' : '#00b8d9');
    if (T !== 'align') tag((T === 'scale' && !curView().calibrated ? '≈ ' : '') + fmt(d(P[0], cur)) + ' m');
  }
}
function draw() {
  resetM();
  ctx.clearRect(0, 0, W, H);
  if (is3D()) return draw3D();
  const vk = S.view, V = S.views[vk], cam = cams[vk];
  drawPlan(V, mul(uv2screen(cam), plan2uv(V)));
  drawGrid(cam, vk);
  drawShapes2D(cam, vk);
  drawOrigin(cam, vk);
  drawHandles(cam, vk);
  drawDraft(cam);
  if (snapHit) {
    const [x, y] = ap(uv2screen(cam), snapHit.u, snapHit.v);
    ctx.strokeStyle = '#00a3cc'; ctx.lineWidth = 2;
    ctx.strokeRect(x - 6, y - 6, 12, 12);
  } else if (hover && S.tool !== 'select') {
    const [x, y] = ap(uv2screen(cam), hover.u, hover.v);
    ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y); ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8); ctx.stroke();
  }
}

/* ---------- 3D (orthografisch, Plan liegt als Textur auf z=0) ---------- */
function isoLinear() {
  const c = cams.iso, ca = Math.cos(c.az), sa = Math.sin(c.az), se = Math.sin(c.el), ce = Math.cos(c.el);
  return (x, y, z) => {
    const dx = x - c.tx, dy = y - c.ty, dz = z - c.tz;
    const rx = dx * ca - dy * sa, ry = dx * sa + dy * ca;
    return [W / 2 + rx * c.zoom, H / 2 - (ry * se + dz * ce) * c.zoom, ry * ce - dz * se];
  };
}
function isoAffine(w) {
  const P = isoLinear();
  const o = P(...w(0, 0)), a = P(...w(1, 0)), b = P(...w(0, 1));
  return [a[0] - o[0], a[1] - o[1], b[0] - o[0], b[1] - o[1], o[0], o[1]];
}
function draw3D() {
  ctx.fillStyle = '#23262c'; ctx.fillRect(0, 0, W, H);
  const P = isoLinear();
  const T = S.views.top, Sd = S.views.side, Fr = S.views.front;
  drawPlan(T, mul(isoAffine((u, v) => [u, v, 0]), plan2uv(T)), .9, false);
  if (Sd.bg) drawPlan(Sd, mul(isoAffine((u, v) => [u, 0, v]), plan2uv(Sd)), .45, false);
  if (Fr.bg) drawPlan(Fr, mul(isoAffine((u, v) => [0, u, v]), plan2uv(Fr)), .45, false);
  const step = Math.max(niceStep(cams.iso.zoom), 1), ext = step * 20;
  ctx.strokeStyle = 'rgba(128,140,160,.22)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let i = -20; i <= 20; i++) {
    let a = P(i * step, -ext, 0), b = P(i * step, ext, 0); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    a = P(-ext, i * step, 0); b = P(ext, i * step, 0); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
  }
  ctx.stroke();
  const faces = [];
  for (const s of S.shapes) {
    if (s.visible === false) continue;
    const col = labelColor(s.label);
    for (const t of tess(s).tris) { const q = t.map((p) => P(p.x, p.y, p.z)); faces.push({ s, q, col, d: (q[0][2] + q[1][2] + q[2][2]) / 3 }); }
  }
  faces.sort((a, b) => b.d - a.d);
  isoFaces = faces;
  for (const f of faces) {
    const on = f.s.id === S.sel;
    ctx.beginPath(); ctx.moveTo(f.q[0][0], f.q[0][1]); ctx.lineTo(f.q[1][0], f.q[1][1]); ctx.lineTo(f.q[2][0], f.q[2][1]); ctx.closePath();
    ctx.globalAlpha = on ? .9 : .72; ctx.fillStyle = f.col; ctx.fill();
    ctx.lineWidth = .7; ctx.strokeStyle = f.col; ctx.stroke(); ctx.globalAlpha = 1;
  }
  for (const s of S.shapes) {
    if (s.visible === false) continue;
    shapePath(tess(s).loops, (p) => P(p.x, p.y, p.z));
    ctx.lineWidth = s.id === S.sel ? 2.5 : 1; ctx.strokeStyle = s.id === S.sel ? '#fff' : 'rgba(0,0,0,.65)'; ctx.stroke();
  }
  const o = P(0, 0, 0), L = 60 / cams.iso.zoom;
  for (const [n, v, c] of [['X', [L, 0, 0], '#e5484d'], ['Y', [0, L, 0], '#2fb86a'], ['Z', [0, 0, L], '#3e8bff']]) { const e = P(...v); arrow(o[0], o[1], e[0], e[1], c, n); }
  ctx.beginPath(); ctx.arc(o[0], o[1], 4, 0, 7); ctx.fillStyle = '#fff'; ctx.fill();
}
function hit3D(x, y) {
  const side = (a, b) => (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  for (let i = isoFaces.length - 1; i >= 0; i--) {
    const q = isoFaces[i].q, d1 = side(q[0], q[1]), d2 = side(q[1], q[2]), d3 = side(q[2], q[0]);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return isoFaces[i].s;
  }
  return null;
}

/* ---------- Fangen ---------- */
function snap(sx, sy, exclude) {
  const cam = cams[S.view], M = uv2screen(cam), [u, v] = ap(inv(M), sx, sy);
  const R = 11; let best = null, bd = R;
  const tryPt = (a, b, type) => { const [x, y] = ap(M, a, b), d = Math.hypot(x - sx, y - sy); if (d < bd) { bd = d; best = { u: a, v: b, type }; } };
  if ($('optSnap').checked && !snapDisabled) {
    tryPt(0, 0, 'Nullpunkt');
    for (const s of S.shapes) {
      if (s.id === exclude || s.visible === false) continue;
      for (const p of allPoints(s)) { const [a, b] = uvOf(p, S.view); tryPt(a, b, 'Eckpunkt'); }
    }
    const V = S.views[S.view];
    if (V.bg) {
      const e = planEntry(V.bg);
      if (e.grid) {
        const pu = plan2uv(V), IP = inv(mul(M, pu)), [px, py] = ap(IP, sx, sy), pr = R * Math.hypot(IP[0], IP[1]);
        const n = nearestPlanPoint(e, px, py, pr);
        if (n) { const [a, b] = ap(pu, n[0], n[1]); tryPt(a, b, 'Planpunkt'); }
      }
    }
  }
  if (best) return best;
  if ($('optGridSnap').checked) return { u: Math.round(u * 2) / 2, v: Math.round(v * 2) / 2, type: null };
  return { u, v, type: null };
}
function constrain(pt, anchor, e, tool) {
  if (!e.shiftKey || !anchor) return pt;
  const du = pt.u - anchor[0], dv = pt.v - anchor[1];
  if (tool === 'rect') { const m = Math.max(Math.abs(du), Math.abs(dv)); return { u: anchor[0] + Math.sign(du || 1) * m, v: anchor[1] + Math.sign(dv || 1) * m, type: null }; }
  const step = tool === 'handle' ? Math.PI / 2 : Math.PI / 4;   // Eckpunkte: nur senkrecht oder waagrecht
  const a = Math.round(Math.atan2(dv, du) / step) * step, l = Math.hypot(du, dv);
  return { u: anchor[0] + l * Math.cos(a), v: anchor[1] + l * Math.sin(a), type: null };
}
function rrectCorners(a, b, c) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
  const h = (c[0] - b[0]) * nx + (c[1] - b[1]) * ny;
  return [a, b, [b[0] + nx * h, b[1] + ny * h], [a[0] + nx * h, a[1] + ny * h]];
}

/* ---------- Werkzeuge ---------- */
function addShape(s) {
  pushUndo();
  s.id = S.nextId++; s.label = s.label || S.label; s.visible = true; s.flip = false;
  S.shapes.push(s); S.sel = s.id;
  changed();
  return s;
}
function addPoly(uvs, kind) { addShape({ type: 'poly', kind, pts: uvs.map(([u, v]) => toWorld(u, v)) }); }
function setTool(t) {
  if (is3D() && t !== 'select') setView('top');
  if ((t === 'circle' || t === 'ring') && S.view !== 'top') { setView('top'); toast('Kreise und Bögen liegen im Grundriss, deshalb Draufsicht. Ihre Höhe stellst du danach ein.'); }
  S.tool = t; draft = null; if (t !== 'measure') measure = null;
  document.querySelectorAll('.tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  cv.style.cursor = t === 'select' ? 'default' : 'crosshair';
  updateHint(); render();
}
function updateHint() { $('hint').textContent = is3D() ? '3D: ziehen dreht, rechte Taste oder Leertaste verschiebt, Rad oder Pinch zoomt, Klick wählt eine Fläche.' : TOOL_HINT[S.tool]; }
function clickTool(pt) {
  const t = S.tool, q = [pt.u, pt.v];
  if (t === 'origin') {
    pushUndo();
    const [px, py] = ap(inv(plan2uv(S.views[S.view])), q[0], q[1]);
    recalibrate(S.view, (V) => { V.ox = px; V.oy = py; V.originSet = true; });
    toast(S.view === 'top' ? 'Nullpunkt gesetzt. Die Flächen bleiben auf dem Plan liegen.' : 'Nullpunkt des Schnitts gesetzt.');
    setTool('select'); changed(); return;
  }
  if (!draft) draft = { tool: t, pts: [] };
  draft.pts.push(q);
  const P = draft.pts;
  if (t === 'rect' && P.length === 2) {
    const [a, b] = P;
    if (Math.abs(a[0] - b[0]) < 1e-3 || Math.abs(a[1] - b[1]) < 1e-3) { P.pop(); return; }
    draft = null; addPoly([a, [b[0], a[1]], b, [a[0], b[1]]], 'rect');
  } else if (t === 'rrect' && P.length === 3) { draft = null; addPoly(rrectCorners(P[0], P[1], P[2]), 'rect'); }
  else if (t === 'poly' && P.length > 1) {
    const M = uv2screen(cams[S.view]), dist = (a, b) => { const A = ap(M, a[0], a[1]), B = ap(M, b[0], b[1]); return Math.hypot(A[0] - B[0], A[1] - B[1]); };
    if (P.length > 3 && dist(q, P[0]) < 11) { P.pop(); finishPoly(); }
    else if (dist(q, P[P.length - 2]) < 4) { P.pop(); if (P.length >= 3) finishPoly(); }
  } else if (t === 'circle' && P.length === 2) {
    const r = Math.hypot(P[0][0] - P[1][0], P[0][1] - P[1][1]);
    if (r < 1e-3) { P.pop(); return; }
    draft = null;
    addShape({ type: 'round', c: { x: P[0][0], y: P[0][1] }, r, ri: 0, a0: 0, a1: 360, z: S.drawZ, zo: S.drawZ, seg: 48 });
  } else if (t === 'ring') {
    if (P.length === 2) { draft.sweep = 0; draft.lastA = Math.atan2(P[1][1] - P[0][1], P[1][0] - P[0][0]); }
    if (P.length === 4) {
      const r = Math.hypot(P[0][0] - P[1][0], P[0][1] - P[1][1]), ri = Math.min(Math.hypot(P[0][0] - P[3][0], P[0][1] - P[3][1]), r * 0.999);
      const a = Math.atan2(P[1][1] - P[0][1], P[1][0] - P[0][0]) * 180 / Math.PI, sw = draft.sweep * 180 / Math.PI;
      draft = null;
      if (r < 1e-3 || Math.abs(sw) < 0.5) return;
      const a0 = sw >= 0 ? a : a + sw;
      addShape({ type: 'round', c: { x: P[0][0], y: P[0][1] }, r, ri, a0, a1: a0 + Math.min(Math.abs(sw), 360), z: S.drawZ, zo: S.drawZ, seg: 48 });
    }
  } else if (t === 'measure') {
    if (P.length === 1) measure = null;
    else { measure = { a: P[0], b: P[1] }; draft = null; }
  } else if (t === 'scale' && P.length === 2) { openScaleDialog(P[0], P[1]); }
  else if (t === 'align' && P.length === 2) {
    pushUndo();
    const V = S.views[S.view], I = inv(plan2uv(V)), A = ap(I, P[0][0], P[0][1]), B = ap(I, P[1][0], P[1][1]);
    const ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
    recalibrate(S.view, (X) => { X.rot = X.flip ? ang + Math.PI : ang; });
    setTool('select'); changed(); toast('Plan ausgerichtet: diese Linie ist jetzt die horizontale Achse.');
  }
}
function finishPoly() {
  if (!draft || draft.tool !== 'poly' || draft.pts.length < 3) { toast('Ein Polygon braucht mindestens drei Punkte.', true); return; }
  const pts = draft.pts; draft = null; addPoly(pts, 'poly');
}
function trackSweep() {
  if (!draft || draft.tool !== 'ring' || draft.pts.length !== 2 || !hover) return;
  const a = Math.atan2(hover.v - draft.pts[0][1], hover.u - draft.pts[0][0]);
  let d = a - draft.lastA; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  draft.sweep = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, draft.sweep + d)); draft.lastA = a;
}

/* ---------- Dialoge ---------- */
let scalePts = null;
function openScaleDialog(a, b) {
  scalePts = [a, b];
  $('scaleLen').value = ''; $('scaleErr').textContent = '';
  $('dlgScale').returnValue = '';
  $('dlgScale').showModal(); $('scaleLen').focus();
}
function applyScale() {
  const len = num($('scaleLen').value);
  if (len === null || len <= 0) { $('scaleErr').textContent = 'Bitte eine Länge größer als 0 eingeben, zum Beispiel 24,5.'; return false; }
  const meters = len * Number($('scaleUnit').value), vk = S.view, V = S.views[vk];
  const I = inv(plan2uv(V)), A = ap(I, scalePts[0][0], scalePts[0][1]), B = ap(I, scalePts[1][0], scalePts[1][1]);
  const dist = Math.hypot(A[0] - B[0], A[1] - B[1]);
  if (dist < 1e-6) { $('scaleErr').textContent = 'Die beiden Punkte liegen aufeinander. Bitte neu markieren.'; return false; }
  pushUndo();
  const ppm = dist / meters;
  recalibrate(vk, (X) => { X.ppm = ppm; X.calibrated = true; });
  let shared = 0;
  for (const k of ['top', 'side', 'front']) {
    const O = S.views[k];
    if (k !== vk && O.bg && V.bg && !O.calibrated && cacheKey(O.bg) === cacheKey(V.bg)) { recalibrate(k, (X) => { X.ppm = ppm; X.calibrated = true; }); shared++; }
  }
  toast(`Skaliert: Maßstab ca. 1:${Math.round(PT_PER_M / ppm)}` + (shared ? ' (auch für Ansichten mit gleichem Blatt)' : ''));
  return true;
}
function openExport() {
  $('exportName').value = ($('projectName').value || 'Venue').replace(/[\\/:*?"<>|]/g, '_') + '_soundvision.txt';
  refreshExport();
  $('dlgExport').showModal();
}
function refreshExport() {
  const rot = Number($('exportRot').value), tris = exportTriangles(rot), T = S.views.top;
  const warnings = [];
  if (!S.shapes.length) warnings.push('Es gibt noch keine Flächen. Die Datei wäre leer.');
  if (T.bg && !T.calibrated) warnings.push('Die Draufsicht ist noch nicht skaliert. Alle Maße wären nur geschätzt (1:100).');
  if (T.bg && !T.originSet) warnings.push('Kein Nullpunkt gesetzt. Es wird die linke untere Blattecke verwendet.');
  const hidden = S.shapes.filter((s) => s.visible === false).length;
  if (hidden) warnings.push(`${hidden} ausgeblendete Fläche(n) werden nicht exportiert.`);
  $('exportWarnings').innerHTML = warnings.map((w) => `<div class="warn">${esc(w)}</div>`).join('');
  let box = '';
  if (tris.length) {
    const all = tris.flatMap((t) => t.v), r = (k) => [Math.min(...all.map((p) => p[k])), Math.max(...all.map((p) => p[k]))];
    const [x, y, z] = ['x', 'y', 'z'].map(r);
    box = ` Ausdehnung: X ${fmt(x[0])} bis ${fmt(x[1])}, Y ${fmt(y[0])} bis ${fmt(y[1])}, Z ${fmt(z[0])} bis ${fmt(z[1])} m.`;
  }
  $('exportSummary').textContent = `${S.shapes.length - hidden} Fläche(n), ${tris.length} Dreiecke.` + box;
  const lines = exportText(rot).split('\n');
  $('exportPreview').textContent = lines.slice(0, 60).join('\n') + (lines.length > 60 ? `\n… (${lines.length} Zeilen gesamt)` : '');
  $('exportGo').disabled = !tris.length;
}
async function download(name, data, type = 'text/plain;charset=utf-8') {
  /* Als Artifact gehostet laufen Downloads über die Plattform, lokal über einen normalen Link. */
  if (window.claude && window.claude.use) {
    const dl = await window.claude.use('downloads');
    if (dl) {
      await dl.save({ filename: name, data });
      return;
    }
  }
  const url = URL.createObjectURL(new Blob([data], { type })), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ---------- Panels ---------- */
function changed(skipProps) { render(); renderPanels(skipProps); scheduleAutosave(); }
function setView(v) {
  if (S.view === v) return;
  draft = null; hover = null; snapHit = null; invalidateCrisp();
  S.view = v;
  if (v === 'iso' && S.tool !== 'select') { S.tool = 'select'; cv.style.cursor = 'default'; }
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  document.querySelectorAll('.tools button').forEach((b) => b.classList.toggle('on', b.dataset.tool === S.tool));
  updateHint(); renderPanels(); scheduleCrisp(); render();
}
function renderSteps() {
  const T = S.views.top, list = [
    ['PDF-Plan importieren', !!T.bg],
    ['Plan skalieren', T.calibrated],
    ['Nullpunkt setzen', T.originSet],
    ['Flächen nachzeichnen', S.shapes.length > 0],
    ['Höhen einstellen (Seite / 3D)', S.shapes.some((s) => s.type === 'poly' ? s.pts.some((p) => p.z !== 0) : s.z !== 0 || s.zo !== 0)],
  ];
  const now = list.findIndex((l) => !l[1]);
  $('steps').innerHTML = list.map(([t, ok], i) => `<li class="${ok ? 'done' : ''} ${i === now ? 'now' : ''}"><b>${ok ? '✓' : i + 1}</b><span>${t}</span></li>`).join('');
}
function renderPlanPanel() {
  const v3 = is3D(); $('planSection').style.display = v3 ? 'none' : '';
  $('planeField').style.display = v3 ? 'none' : '';
  if (v3) return;
  const V = S.views[S.view];
  $('planeLabel').textContent = S.view === 'top' ? 'Zeichenhöhe Z' : S.view === 'side' ? 'Zeichenebene Y' : 'Zeichenebene X';
  const pv = S.view === 'top' ? S.drawZ : S.view === 'side' ? S.sliceY : S.sliceX;
  if (document.activeElement !== $('planeValue')) $('planeValue').value = inputNum(pv);
  let opts = '<option value="">Kein Plan</option>';
  for (const p of S.pdfs) for (let i = 1; i <= p.doc.numPages; i++)
    opts += `<option value="${p.id}#${i}">${esc(p.name)}${p.doc.numPages > 1 ? ' – Seite ' + i : ''}</option>`;
  $('bgSelect').innerHTML = opts;
  $('bgSelect').value = V.bg ? cacheKey(V.bg) : '';
  $('bgOpacity').value = V.opacity;
  if (document.activeElement !== $('bgRatio')) $('bgRatio').value = String(Math.round(PT_PER_M / V.ppm * 10) / 10).replace('.', ',');
  const e = V.bg ? planEntry(V.bg) : null;
  let note = V.calibrated ? 'Skaliert.' : (V.bg ? 'Noch nicht skaliert, angenommen wird 1:100.' : 'Kein Plan in dieser Ansicht.');
  if (e && e.grid) note += ` ${e.xs.length.toLocaleString('de-DE')} Fangpunkte.`;
  else if (e && e.canvas) note += ' Fangpunkte werden gelesen…';
  $('scaleNote').textContent = note;
  $('btnFlip').style.display = S.view === 'top' ? 'none' : '';
  $('btnNextSheet').hidden = sheetList().length < 2;
}
const sheetList = () => S.pdfs.flatMap((p) => Array.from({ length: p.doc.numPages }, (_, i) => ({ pdfId: p.id, page: i + 1 })));
const roundName = (s) => sweepOf(s) >= 359.999 ? (s.ri > 1e-6 ? 'Ring' : 'Kreis') : 'Bogen';
function renderList() {
  $('shapeCount').textContent = S.shapes.length ? `(${S.shapes.length})` : '';
  const ul = $('shapes');
  if (!S.shapes.length) { ul.innerHTML = '<li class="note" style="cursor:default">Noch keine Flächen gezeichnet.</li>'; return; }
  ul.innerHTML = S.shapes.map((s) => `<li data-id="${s.id}" class="${s.id === S.sel ? 'on' : ''} ${s.visible === false ? 'off' : ''}">
    <span class="sw" style="background:${labelColor(s.label)}"></span>
    <span class="nm">${esc(s.label)}</span><span class="ty">${s.type === 'poly' ? (s.kind === 'rect' ? 'Rechteck' : 'Polygon') : roundName(s)}</span>
    <button data-act="vis" title="${s.visible === false ? 'Einblenden' : 'Ausblenden'}" aria-label="Ein- oder ausblenden">${s.visible === false ? '◌' : '●'}</button>
    <button data-act="del" title="Löschen" aria-label="Löschen">×</button></li>`).join('');
}
function renderProps() {
  const s = S.shapes.find((x) => x.id === S.sel), box = $('props');
  if (!s) { box.innerHTML = '<p class="note">Nichts ausgewählt.</p>'; return; }
  const labelRow = `<label class="row"><span>Name / Layer</span><input data-f="label" list="labelList" value="${esc(s.label)}"></label>
    <datalist id="labelList"><option value="Audience"><option value="Stage"><option value="Wall"><option value="Avoid"><option value="KeepClear"></datalist>`;
  const flip = `<label class="chk"><input type="checkbox" data-f="flip" ${s.flip ? 'checked' : ''}>Vorderseite umkehren</label>`;
  const btns = `<div class="btnrow"><button id="propDup" class="quiet" type="button">Duplizieren</button><button id="propDel" class="quiet" type="button">Löschen</button></div>`;
  if (s.type === 'poly') {
    const rows = s.pts.map((p, i) => `<tr><td>${i + 1}</td>${['x', 'y', 'z'].map((k) => `<td><input data-v="${i}" data-k="${k}" value="${inputNum(p[k])}" inputmode="decimal" aria-label="Punkt ${i + 1} ${k.toUpperCase()}"></td>`).join('')}</tr>`).join('');
    box.innerHTML = labelRow + `<label class="row"><span>Alle Z auf</span><input id="allZ" placeholder="Höhe in m" inputmode="decimal"></label>` +
      `<table class="vtable"><thead><tr><th></th><th>X</th><th>Y</th><th>Z</th></tr></thead><tbody>${rows}</tbody></table>` + flip + btns;
  } else {
    const r = (lab, f, v) => `<label class="row"><span>${lab}</span><input data-f="${f}" value="${inputNum(v)}" inputmode="decimal"></label>`;
    box.innerHTML = labelRow + r('Mitte X', 'cx', s.c.x) + r('Mitte Y', 'cy', s.c.y) + r('Radius', 'r', s.r) + r('Innenradius', 'ri', s.ri) +
      r('Winkel von', 'a0', s.a0) + r('Winkel bis', 'a1', s.a1) + r('Z innen', 'z', s.z) + r('Z außen', 'zo', s.zo) + r('Segmente', 'seg', s.seg) + flip + btns;
  }
}
function renderPanels(skipProps) {
  renderSteps(); renderPlanPanel(); renderList();
  if (!skipProps) renderProps();
  $('dropHint').style.display = S.pdfs.length || S.shapes.length ? 'none' : '';
}

function applyPropChange(t) {
  const s = S.shapes.find((x) => x.id === S.sel); if (!s) return;
  if (t.id === 'allZ') { const z = num(t.value); if (z === null) return; pushUndo(); s.pts.forEach((p) => { p.z = z; }); changed(); return; }
  /* Eigene Felder nicht neu aufbauen, damit Tab zum nächsten Feld funktioniert */
  if (t.dataset.v !== undefined) { const v = num(t.value); if (v === null) return renderProps(); pushUndo(); s.pts[+t.dataset.v][t.dataset.k] = v; changed(true); return; }
  const f = t.dataset.f; if (!f) return;
  if (f === 'label') { pushUndo(); s.label = t.value.trim() || 'Surface'; S.label = s.label; changed(true); return; }
  if (f === 'flip') { pushUndo(); s.flip = t.checked; changed(true); return; }
  const v = num(t.value); if (v === null) return renderProps();
  pushUndo();
  if (f === 'cx') s.c.x = v; else if (f === 'cy') s.c.y = v;
  else if (f === 'r') s.r = Math.max(0.01, v); else if (f === 'ri') s.ri = Math.max(0, Math.min(v, s.r * 0.999));
  else if (f === 'seg') s.seg = Math.max(6, Math.min(360, Math.round(v)));
  else if (f === 'a1') s.a1 = v <= s.a0 ? v + 360 : v;
  else s[f] = v;
  if (s.a1 - s.a0 > 360) s.a1 = s.a0 + 360;
  changed(true);
}
function duplicateSel() {
  const s = S.shapes.find((x) => x.id === S.sel); if (!s) return;
  const c = JSON.parse(JSON.stringify(s));
  if (c.type === 'poly') c.pts.forEach((p) => { p.x += 1; p.y -= 1; }); else { c.c.x += 1; c.c.y -= 1; }
  pushUndo(); c.id = S.nextId++; S.shapes.push(c); S.sel = c.id; changed();
}
function deleteSel() {
  if (!S.shapes.some((x) => x.id === S.sel)) return;
  pushUndo(); S.shapes = S.shapes.filter((x) => x.id !== S.sel); S.sel = null; changed();
}

/* ---------- Pointer ---------- */
const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
function hitHandle(x, y) {
  const s = S.shapes.find((q) => q.id === S.sel); if (!s || s.visible === false) return null;
  const M = uv2screen(cams[S.view]); let best = null, bd = 9;
  for (const h of handlesOf(s, S.view)) {
    const [a, b] = ap(M, h.u, h.v), d = Math.hypot(a - x, b - y) + (h.kind === 'mid' ? 1.5 : 0);
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}
function hitShape(x, y) {
  const M = uv2screen(cams[S.view]), proj = (p) => { const [u, v] = uvOf(p, S.view); return ap(M, u, v); };
  const inTri = (a, b, c) => { const f = (p, q) => (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]); const d1 = f(a, b), d2 = f(b, c), d3 = f(c, a); return (d1 > 0 && d2 > 0 && d3 > 0) || (d1 < 0 && d2 < 0 && d3 < 0); };
  const nearSeg = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l)); return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) < 6; };
  for (let i = S.shapes.length - 1; i >= 0; i--) {
    const s = S.shapes[i]; if (s.visible === false) continue;
    const t = tess(s);
    if (t.tris.some((tr) => inTri(proj(tr[0]), proj(tr[1]), proj(tr[2])))) return s;
    for (const lp of t.loops) for (let k = 0; k < lp.length; k++) if (nearSeg(proj(lp[k]), proj(lp[(k + 1) % lp.length]))) return s;
  }
  return null;
}
function moveShape(s, vk, du, dv) {
  if (s.type === 'poly') s.pts.forEach((p) => { const [u, v] = uvOf(p, vk); setUV(p, vk, u + du, v + dv); });
  else if (vk === 'top') { s.c.x += du; s.c.y += dv; }
  else { if (vk === 'side') s.c.x += du; else s.c.y += du; s.z += dv; s.zo += dv; }
}
function applyHandle(s, h, u, v) {
  if (s.type === 'poly') { h.idxs.forEach((i) => setUV(s.pts[i], S.view, u, v)); return; }
  const ang = () => Math.atan2(v - s.c.y, u - s.c.x) * 180 / Math.PI, rad = () => Math.hypot(u - s.c.x, v - s.c.y);
  switch (h.kind) {
    case 'c': s.c.x = u; s.c.y = v; break;
    case 'ro': s.r = Math.max(rad(), s.ri + 0.01, 0.01); break;
    case 'ri': s.ri = Math.min(rad(), s.r * 0.999); break;
    case 'a0': { let a = ang(); while (a >= s.a1) a -= 360; while (a < s.a1 - 360) a += 360; s.a0 = a; break; }
    case 'a1': { let a = ang(); while (a <= s.a0) a += 360; while (a > s.a0 + 360) a -= 360; s.a1 = a; break; }
    case 'zo': s.zo = v; break;
    case 'z': s.z = v; break;
  }
}
const isTrackpadWheel = (e) => e.wheelDeltaY ? e.wheelDeltaY === -3 * e.deltaY : e.deltaMode === 0;
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const [x, y] = pos(e), cam = cams[S.view];
  if (!e.ctrlKey && isTrackpadWheel(e)) {
    if (is3D()) panIso(-e.deltaX, -e.deltaY);
    else { cam.cx += e.deltaX / cam.zoom; cam.cy -= e.deltaY / cam.zoom; }
  } else {
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0016));
    if (is3D()) cam.zoom = Math.min(400, Math.max(.3, cam.zoom * factor));
    else {
      const [u, v] = ap(inv(uv2screen(cam)), x, y);
      cam.zoom = Math.min(3000, Math.max(.2, cam.zoom * factor));
      cam.cx = u - (x - W / 2) / cam.zoom; cam.cy = v + (y - H / 2) / cam.zoom;
    }
  }
  scheduleCrisp(); render();
}, { passive: false });
function panIso(dx, dy) {
  const c = cams.iso, ca = Math.cos(c.az), sa = Math.sin(c.az), se = Math.max(Math.sin(c.el), .15);
  const rx = -dx / c.zoom, ry = dy / c.zoom / se;
  c.tx += rx * ca + ry * sa; c.ty += -rx * sa + ry * ca;
}
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  const [x, y] = pos(e);
  press = { x, y, lx: x, ly: y, moved: false, button: e.button };
  if (e.button === 1 || e.button === 2 || spaceDown) { drag = { mode: 'pan' }; return; }
  if (is3D()) { drag = { mode: 'orbit' }; return; }
  if (S.tool === 'select') {
    const h = hitHandle(x, y);
    if (h) {
      const s = S.shapes.find((q) => q.id === S.sel);
      if (e.altKey && h.kind === 'v') {
        if (s.pts.length - h.idxs.length >= 3) { pushUndo(); s.pts = s.pts.filter((_, i) => !h.idxs.includes(i)); s.kind = 'poly'; changed(); }
        else toast('Ein Polygon braucht mindestens drei Punkte.', true);
        drag = null; return;
      }
      pushUndo();
      if (h.kind === 'mid') {
        const a = s.pts[h.i], b = s.pts[(h.i + 1) % s.pts.length];
        s.pts.splice(h.i + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
        s.kind = 'poly';
        drag = { mode: 'handle', s, h: { kind: 'v', idxs: [h.i + 1], u: h.u, v: h.v } };
      } else drag = { mode: 'handle', s, h };
      drag.anchor = [drag.h.u, drag.h.v];
      return;
    }
    const s = hitShape(x, y);
    if (s) {
      if (S.sel !== s.id) { S.sel = s.id; renderPanels(); }
      const [u, v] = ap(inv(uv2screen(cams[S.view])), x, y);
      drag = { mode: 'move', s, lu: u, lv: v, pushed: false }; render(); return;
    }
    if (S.sel !== null) { S.sel = null; renderPanels(); render(); }
    drag = { mode: 'pan' };
    return;
  }
  const anchor = draft && draft.pts.length ? (S.tool === 'rect' ? draft.pts[0] : draft.pts[draft.pts.length - 1]) : null;
  const pt = constrain(snap(x, y), anchor, e, S.tool);
  hover = pt; trackSweep();
  clickTool(pt);
  render();
});
cv.addEventListener('pointermove', (e) => {
  const [x, y] = pos(e);
  if (press) {
    if (Math.hypot(x - press.x, y - press.y) > 4) press.moved = true;
    const dx = x - press.lx, dy = y - press.ly; press.lx = x; press.ly = y;
    if (drag && drag.mode === 'pan') {
      if (is3D()) panIso(dx, dy);
      else { const c = cams[S.view]; c.cx -= dx / c.zoom; c.cy += dy / c.zoom; }
      scheduleCrisp(); render(); return;
    }
    if (drag && drag.mode === 'orbit') {
      const c = cams.iso; c.az += dx * 0.008; c.el = Math.max(0.03, Math.min(Math.PI / 2, c.el + dy * 0.008));
      render(); return;
    }
    if (drag && drag.mode === 'move') {
      if (press.moved) {
        if (!drag.pushed) { pushUndo(); drag.pushed = true; }
        const [u, v] = ap(inv(uv2screen(cams[S.view])), x, y);
        moveShape(drag.s, S.view, u - drag.lu, v - drag.lv); drag.lu = u; drag.lv = v;
        render();
      }
      return;
    }
    if (drag && drag.mode === 'handle') {
      const pt = constrain(snap(x, y, drag.s.id), drag.anchor, e, 'handle');
      applyHandle(drag.s, drag.h, pt.u, pt.v);
      snapHit = pt.type ? pt : null; $('snapInfo').textContent = pt.type || '';
      showCoords(pt); render(); return;
    }
  }
  if (is3D()) return;
  let pt;
  if (S.tool === 'select') { const [u, v] = ap(inv(uv2screen(cams[S.view])), x, y); pt = { u, v, type: null }; }
  else {
    const anchor = draft && draft.pts.length ? (draft.tool === 'rect' ? draft.pts[0] : draft.pts[draft.pts.length - 1]) : null;
    pt = constrain(snap(x, y), anchor, e, draft ? draft.tool : S.tool);
  }
  hover = pt; trackSweep();
  snapHit = S.tool !== 'select' && pt.type ? pt : null;
  $('snapInfo').textContent = snapHit ? pt.type : '';
  showCoords(pt);
  render();
});
function showCoords(pt) {
  const n = { top: ['X', 'Y'], side: ['X', 'Z'], front: ['Y', 'Z'] }[S.view];
  $('coords').textContent = `${n[0]} ${fmt(pt.u)}   ${n[1]} ${fmt(pt.v)} m`;
}
cv.addEventListener('pointerup', (e) => {
  if (!press) return;
  const [x, y] = pos(e), far = Math.hypot(x - press.x, y - press.y) > 10;
  if (is3D() && drag && drag.mode === 'orbit' && !press.moved) { const s = hit3D(x, y); S.sel = s ? s.id : null; renderPanels(); }
  if (drag && (drag.mode === 'handle' || (drag.mode === 'move' && drag.pushed))) { snapHit = null; $('snapInfo').textContent = ''; changed(); }
  /* Rechteck und Kreis gehen auch per Ziehen */
  if (!drag && draft && far && draft.pts.length === 1 && (draft.tool === 'rect' || draft.tool === 'circle')) {
    clickTool(constrain(snap(x, y), draft.pts[0], e, draft.tool));
  }
  press = null; drag = null;
  render();
});
cv.addEventListener('dblclick', () => { if (draft && draft.tool === 'poly' && draft.pts.length >= 3) { finishPoly(); render(); } });
cv.addEventListener('pointerleave', () => { if (!press) { hover = null; snapHit = null; render(); } });

/* ---------- Tastatur ---------- */
const TOOLKEY = { v: 'select', r: 'rect', t: 'rrect', p: 'poly', c: 'circle', a: 'ring', k: 'scale', n: 'origin', l: 'align', m: 'measure' };
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName, typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
  if (e.key === 'Alt') snapDisabled = true;
  if (e.metaKey || e.ctrlKey) {
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); saveProject(); return; }
    if (typing) return;
    if (k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'y') { e.preventDefault(); redo(); }
    else if (k === 'd') { e.preventDefault(); duplicateSel(); }
    return;
  }
  if (typing || document.querySelector('dialog[open]')) return;
  if (e.code === 'Space') { spaceDown = true; cv.style.cursor = 'grab'; e.preventDefault(); return; }
  if (e.key === 'Escape') { if (draft) draft = null; else { setTool('select'); S.sel = null; measure = null; renderPanels(); } render(); return; }
  if (e.key === 'Enter') { if (draft && draft.tool === 'poly') { finishPoly(); render(); } return; }
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    if (draft && draft.pts.length > 0) { draft.pts.pop(); if (!draft.pts.length) draft = null; render(); }
    else deleteSel();
    return;
  }
  const k = e.key.toLowerCase();
  if (['1', '2', '3', '4'].includes(k)) { setView(['top', 'side', 'front', 'iso'][+k - 1]); return; }
  if (k === 'f') return fit();
  if (k === 's') { $('optSnap').checked = !$('optSnap').checked; toast('Fangen ' + ($('optSnap').checked ? 'an' : 'aus')); return; }
  if (k === 'g') { $('optGridSnap').checked = !$('optGridSnap').checked; return; }
  if (TOOLKEY[k]) setTool(TOOLKEY[k]);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') { spaceDown = false; cv.style.cursor = S.tool === 'select' ? 'default' : 'crosshair'; }
  if (e.key === 'Alt') snapDisabled = false;
});

/* ---------- Einpassen ---------- */
function fit() {
  if (is3D()) {
    let pts = S.shapes.flatMap(allPoints); const c = cams.iso;
    const V = S.views.top, e = V.bg ? planEntry(V.bg) : null;
    if (e && e.w) { const M = plan2uv(V); [[0, 0], [e.w, 0], [e.w, e.h], [0, e.h]].forEach(([a, b]) => { const [x, y] = ap(M, a, b); pts.push({ x, y, z: 0 }); }); }
    if (!pts.length) pts = [{ x: -15, y: -15, z: 0 }, { x: 15, y: 15, z: 5 }];
    const r = (k) => [Math.min(...pts.map((p) => p[k])), Math.max(...pts.map((p) => p[k]))], [x, y, z] = ['x', 'y', 'z'].map(r);
    c.tx = (x[0] + x[1]) / 2; c.ty = (y[0] + y[1]) / 2; c.tz = (z[0] + z[1]) / 2;
    c.zoom = Math.max(.3, Math.min(W, H) * .9 / Math.max(1, Math.hypot(x[1] - x[0], y[1] - y[0], z[1] - z[0])));
    render(); return;
  }
  const vk = S.view, V = S.views[vk], cam = cams[vk], uv = [];
  const e = V.bg ? planEntry(V.bg) : null;
  if (e && e.w) { const M = plan2uv(V); [[0, 0], [e.w, 0], [e.w, e.h], [0, e.h]].forEach(([a, b]) => uv.push(ap(M, a, b))); }
  S.shapes.forEach((s) => allPoints(s).forEach((p) => uv.push(uvOf(p, vk))));
  if (!uv.length) uv.push([-20, -2], [20, 18]);
  const u = uv.map((p) => p[0]), v = uv.map((p) => p[1]);
  const u0 = Math.min(...u), u1 = Math.max(...u), v0 = Math.min(...v), v1 = Math.max(...v);
  cam.cx = (u0 + u1) / 2; cam.cy = (v0 + v1) / 2;
  cam.zoom = Math.min(3000, Math.max(.2, Math.min(W / Math.max(u1 - u0, .5), H / Math.max(v1 - v0, .5)) * .92));
  invalidateCrisp(); scheduleCrisp(); render();
}
function fitAll() { const was = S.view; for (const k of ['top', 'side', 'front', 'iso']) { S.view = k; fit(); } S.view = was; }

/* ---------- Dateien ---------- */
function toast(msg, bad) {
  const t = $('toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = ''; }, bad ? 6000 : 3200);
}
async function waitPageSize(bg) {
  const e = planEntry(bg);
  for (let i = 0; i < 400 && !e.w; i++) await new Promise((r) => setTimeout(r, 25));
  return e;
}
async function assignBg(vk, bg) {
  const V = S.views[vk];
  V.bg = bg;
  if (bg) {
    const e = await waitPageSize(bg);
    if (!V.originSet && !V.calibrated) { V.ox = 0; V.oy = e.h; }
    /* Gleiches Blatt wie eine schon skalierte Ansicht: gleicher Maßstab */
    const same = !V.calibrated && Object.values(S.views).find((O) => O !== V && O.calibrated && O.bg && cacheKey(O.bg) === cacheKey(bg));
    if (same) recalibrate(vk, (X) => { X.ppm = same.ppm; X.calibrated = true; });
  }
  invalidateCrisp();
  if (S.view === vk) fit();
  changed();
}
async function importPdf(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('Das ist keine PDF-Datei.', true); return; }
  toast('Lade ' + file.name + ' …');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const rec = await addPdf(file.name, bytes);
    if (is3D()) setView('top');
    await assignBg(S.view, { pdfId: rec.id, page: 1 });
    toast(rec.doc.numPages > 1 ? `${rec.doc.numPages} Seiten geladen. Unter „Blatt“ wählst du die Seite für jede Ansicht.` : 'Plan geladen. Jetzt eine bekannte Strecke markieren.');
    if (!S.views[S.view].calibrated) setTool('scale');
  } catch (err) {
    console.error(err);
    toast(err.name === 'PasswordException' ? 'Die PDF ist passwortgeschützt und lässt sich nicht öffnen.' : 'PDF konnte nicht geladen werden: ' + err.message, true);
  }
}
const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (b) => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
function saveProject() {
  const data = { app: 'CAD2SV', version: 1, name: $('projectName').value, views: S.views, shapes: S.shapes, nextId: S.nextId, label: S.label,
    pdfs: S.pdfs.map((p) => ({ id: p.id, name: p.name, data: toB64(p.bytes) })) };
  download(($('projectName').value || 'Venue') + '.cad2sv.json', JSON.stringify(data), 'application/json')
    .then(() => toast('Projekt gespeichert, inklusive PDF.'))
    .catch((err) => toast('Nicht gespeichert: ' + (err.message || err.code || 'abgebrochen'), true));
}
async function applyProject(d, getBytes) {
  planCache.clear(); invalidateCrisp();
  S.pdfs = [];
  for (const p of d.pdfs || []) await addPdf(p.name, getBytes(p), p.id);
  S.views = d.views; S.shapes = d.shapes || []; S.nextId = d.nextId || S.shapes.length + 1; S.sel = null; S.label = d.label || 'Audience';
  $('projectName').value = d.name || 'Venue';
  undoStack = []; redoStack = [];
  ensurePlanBitmaps();
  await Promise.all(['top', 'side', 'front'].map((k) => S.views[k].bg ? waitPageSize(S.views[k].bg) : null));
  fitAll(); changed();
}
async function openProject(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.app !== 'CAD2SV') throw new Error('keine CAD2SV-Projektdatei');
    await applyProject(d, (p) => fromB64(p.data));
    toast('Projekt geladen.');
  } catch (err) { toast('Projekt konnte nicht geöffnet werden: ' + err.message, true); }
}
/* Autosave in IndexedDB. Reine Komfortfunktion: Fehler bleiben folgenlos. */
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('cad2sv', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
let autosaveTimer = 0, restoring = false;
function scheduleAutosave() {
  if (restoring) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(async () => {
    try {
      const db = await idb();
      db.transaction('kv', 'readwrite').objectStore('kv').put({ name: $('projectName').value, views: S.views, shapes: S.shapes, nextId: S.nextId, label: S.label, pdfs: S.pdfs.map((p) => ({ id: p.id, name: p.name, bytes: p.bytes })) }, 'autosave');
    } catch (e) { /* kein Autosave möglich */ }
  }, 1200);
}
async function tryRestore() {
  try {
    const db = await idb();
    const d = await new Promise((res, rej) => { const r = db.transaction('kv').objectStore('kv').get('autosave'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (d && (d.shapes.length || d.pdfs.length)) {
      restoring = true;
      await applyProject(d, (p) => p.bytes);
      restoring = false;
      toast('Letzte Sitzung wiederhergestellt.');
    }
  } catch (e) { restoring = false; console.warn('Wiederherstellen nicht möglich', e); }
}
let resetArmed = 0;
function resetAll(force) {
  const btn = $('btnNew');
  if (force !== true && (S.shapes.length || S.pdfs.length) && !resetArmed) {   // zweiter Klick bestätigt
    btn.textContent = 'Wirklich verwerfen?';
    resetArmed = setTimeout(() => { resetArmed = 0; btn.textContent = 'Neu'; }, 3500);
    return;
  }
  clearTimeout(resetArmed); resetArmed = 0; btn.textContent = 'Neu';
  S.pdfs = []; S.shapes = []; S.sel = null; S.nextId = 1; S.views = { top: newView(), side: newView(), front: newView() };
  planCache.clear(); invalidateCrisp(); undoStack = []; redoStack = []; draft = null; measure = null;
  $('projectName').value = 'Venue';
  fitAll(); setTool('select'); changed();
}

/* ---------- Verdrahtung ---------- */
document.querySelectorAll('.tools button').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('btnPdf').onclick = () => $('filePdf').click();
$('filePdf').onchange = (e) => { importPdf(e.target.files[0]); e.target.value = ''; };
$('btnOpen').onclick = () => $('fileProject').click();
$('fileProject').onchange = (e) => { if (e.target.files[0]) openProject(e.target.files[0]); e.target.value = ''; };
$('btnSave').onclick = saveProject;
$('btnNew').onclick = () => resetAll();
$('btnExport').onclick = openExport;
$('btnFit').onclick = fit;
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
$('exportRot').onchange = refreshExport;
$('exportGo').onclick = () => {
  let name = $('exportName').value.trim() || 'venue_soundvision.txt';
  if (!/\.txt$/i.test(name)) name += '.txt';
  download(name, exportText(Number($('exportRot').value)))
    .then(() => toast('Datei gespeichert: ' + name))
    .catch((err) => toast('Nicht gespeichert: ' + (err.message || err.code || 'abgebrochen'), true));
};
$('scaleOk').onclick = (e) => {
  if (!applyScale()) { e.preventDefault(); return; }
  draft = null;
  setTimeout(() => { setTool(S.views[S.view].originSet ? 'select' : 'origin'); changed(); }, 0);
};
$('scaleCancel').onclick = () => $('dlgScale').close();
$('dlgScale').addEventListener('close', () => { if ($('dlgScale').returnValue !== 'ok') { draft = null; render(); } });
$('planeValue').onchange = (e) => {
  const v = num(e.target.value); if (v === null) return renderPlanPanel();
  if (S.view === 'top') S.drawZ = v; else if (S.view === 'side') S.sliceY = v; else S.sliceX = v;
  e.target.value = inputNum(v);
};
$('bgSelect').onchange = async (e) => {
  const val = e.target.value; pushUndo();
  if (!val) { await assignBg(S.view, null); return; }
  const [pdfId, page] = val.split('#');
  await assignBg(S.view, { pdfId, page: +page });
};
$('btnNextSheet').onclick = async () => {
  const list = sheetList(), bg = S.views[S.view].bg;
  const i = bg ? list.findIndex((s) => cacheKey(s) === cacheKey(bg)) : -1;
  pushUndo();
  await assignBg(S.view, list[(i + 1) % list.length]);
};
$('bgOpacity').oninput =(e) => { curView().opacity = +e.target.value; render(); scheduleAutosave(); };
$('bgRatio').onchange = (e) => {
  const r = num(e.target.value); if (!r || r <= 0) return renderPlanPanel();
  pushUndo(); recalibrate(S.view, (V) => { V.ppm = PT_PER_M / r; V.calibrated = true; });
  changed();
};
const rotateBg = (deg) => { pushUndo(); recalibrate(S.view, (V) => { V.rot += deg * Math.PI / 180; }); changed(); };
$('btnRotL').onclick = () => rotateBg(-90);
$('btnRotR').onclick = () => rotateBg(90);
$('btnFlip').onclick = () => { pushUndo(); S.views[S.view].flip = !S.views[S.view].flip; invalidateCrisp(); scheduleCrisp(); changed(); };
$('props').addEventListener('change', (e) => applyPropChange(e.target));
$('props').addEventListener('click', (e) => { if (e.target.id === 'propDup') duplicateSel(); if (e.target.id === 'propDel') deleteSel(); });
$('shapes').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]'); if (!li) return;
  const id = +li.dataset.id, s = S.shapes.find((x) => x.id === id), act = e.target.dataset.act;
  if (act === 'del') { S.sel = id; deleteSel(); return; }
  if (act === 'vis') { pushUndo(); s.visible = s.visible === false; changed(); return; }
  S.sel = id; changed();
});
/* Beispielplan zum Ausprobieren: Saal 30 × 20 m, Bühne 10 × 5 m, Kreis r = 4 m (1:100); Seite 2 ist ein Schnitt. */
const SAMPLE_PDF = 'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUiA1IDAgUl0gL0NvdW50IDIgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAxMTkxIDg0Ml0gL0NvbnRlbnRzIDQgMCBSID4+CmVuZG9iago0IDAgb2JqCjw8IC9MZW5ndGggMzA3ID4+CnN0cmVhbQowLjggdyAwIDAgMCBSRwoxMDAuMDAwIDgwLjAwMCA4NTAuMzk0IDU2Ni45MjkgcmUgUwozODMuNDY1IDUwNS4xOTcgMjgzLjQ2NSAxNDEuNzMyIHJlIFMKNjM4LjU4MyAyNzguNDI1IG0gNjM4LjU4MyAzNDEuMDQ4IDU4Ny44MjAgMzkxLjgxMSA1MjUuMTk3IDM5MS44MTEgYyA0NjIuNTc0IDM5MS44MTEgNDExLjgxMSAzNDEuMDQ4IDQxMS44MTEgMjc4LjQyNSBjIDQxMS44MTEgMjE1LjgwMiA0NjIuNTc0IDE2NS4wMzkgNTI1LjE5NyAxNjUuMDM5IGMgNTg3LjgyMCAxNjUuMDM5IDYzOC41ODMgMjE1LjgwMiA2MzguNTgzIDI3OC40MjUgYyBTCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvUGFnZSAvUGFyZW50IDIgMCBSIC9NZWRpYUJveCBbMCAwIDExOTEgODQyXSAvQ29udGVudHMgNiAwIFIgPj4KZW5kb2JqCjYgMCBvYmoKPDwgL0xlbmd0aCAxMDggPj4Kc3RyZWFtCjAuOCB3IDAgMCAwIFJHCjEwMC4wMDAgMjAwLjAwMCBtIDcyMy42MjIgMjAwLjAwMCBsIDk1MC4zOTQgMjg1LjAzOSBsIDk1MC4zOTQgNDgzLjQ2NSBsIDEwMC4wMDAgNDgzLjQ2NSBsIGggUwplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA3CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMjEgMDAwMDAgbiAKMDAwMDAwMDIwOSAwMDAwMCBuIAowMDAwMDAwNTY3IDAwMDAwIG4gCjAwMDAwMDA2NTUgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA3IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo4MTQKJSVFT0YK';
$('btnSample').onclick = () => importPdf(new File([fromB64(SAMPLE_PDF)], 'Beispielplan.pdf', { type: 'application/pdf' }));
const wrap = $('canvasWrap');
wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('dragging'); });
wrap.addEventListener('dragleave', () => wrap.classList.remove('dragging'));
wrap.addEventListener('drop', (e) => { e.preventDefault(); wrap.classList.remove('dragging'); importPdf(e.dataTransfer.files[0]); });
new ResizeObserver(resize).observe(wrap);

resize();
document.querySelector('.tabs button[data-view="top"]').classList.add('on');
setTool('select');
fitAll();
renderPanels();
loadPdfjs().catch((e) => toast(e.message, true));
tryRestore();

/* Für automatisierte Tests */
window.CAD2SV = { S, cams, setView, setTool, addPdf, assignBg, importPdf, exportText, exportTriangles, tess, plan2uv, uv2screen, fit, ap, inv, resetAll, planEntry };
})();
