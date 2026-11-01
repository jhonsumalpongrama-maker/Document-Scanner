/*
  Document Scanner (web version)
  Straightens and cleans up a phone photo of a handout, all inside the browser.

  Same steps as the Python version:
    1. find the four corners of the page
    2. straighten it (perspective transform)
    3. clean up (remove shadows, boost contrast, or pure black and white)
    4. save as PNG, JPG or PDF
*/
'use strict';

const $ = (id) => document.getElementById(id);

const MAX_SOURCE = 3000;   // longest side kept from the photo (keeps big phone photos fast)
const MAX_OUTPUT = 2000;   // longest side of the scan
const DETECT_SIZE = 400;   // the photo is shrunk to this size to look for the page

const els = {
  file: $('file'),
  scan: $('scan'),
  straighten: $('straighten'),
  status: $('status'),
  original: $('original'),
  result: $('result'),
  dropzone: $('dropzone'),
  phOriginal: $('placeholder-original'),
  phResult: $('placeholder-result'),
  savePng: $('save-png'),
  saveJpg: $('save-jpg'),
  savePdf: $('save-pdf'),
};

const state = {
  source: null,      // { canvas, data (ImageData), w, h }
  corners: null,     // four {x, y} points in photo coordinates: TL, TR, BR, BL
  found: false,
  drag: -1,          // index of the corner being dragged
  hasResult: false,
  fileName: 'scan',
};

/* ================================================================ INPUT ==== */

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    setStatus('That file is not an image. Please choose a photo.');
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    // Browsers apply the phone's rotation (EXIF) when they draw the image.
    const ratio = Math.min(1, MAX_SOURCE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * ratio));
    const h = Math.max(1, Math.round(img.naturalHeight * ratio));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);

    state.source = { canvas, data: ctx.getImageData(0, 0, w, h), w, h };
    state.fileName = file.name.replace(/\.[^.]+$/, '') || 'scan';
    clearResult();

    const page = findPage(state.source);
    state.corners = page.corners;
    state.found = page.found;
    drawOriginal();
    els.scan.disabled = false;
    setStatus(page.found
      ? 'Page found. Check the corners, then click Scan.'
      : 'Page edges not found. Drag the four dots onto the page corners, or click Scan to only clean up the lighting.');
    if (page.found) scanNow();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus('Could not open that image.');
  };
  img.src = url;
}

/* ============================================================== PROCESS ==== */

/* ---- 1. find the page ---- */

function otsuThreshold(values) {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.min(255, Math.max(0, values[i] | 0))]++;
  const total = values.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumBack = 0, weightBack = 0, best = 0, bestT = 127;
  for (let t = 0; t < 256; t++) {
    weightBack += hist[t];
    if (!weightBack) continue;
    const weightFore = total - weightBack;
    if (!weightFore) break;
    sumBack += t * hist[t];
    const meanBack = sumBack / weightBack;
    const meanFore = (sumAll - sumBack) / weightFore;
    const between = weightBack * weightFore * (meanBack - meanFore) ** 2;
    if (between > best) { best = between; bestT = t; }
  }
  return bestT;
}

function boxBlur(src, w, h, radius) {
  // separable box blur on a Float32Array
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const size = radius * 2 + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let x = -radius; x <= radius; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / size;
      acc += src[row + Math.min(w - 1, x + radius + 1)] - src[row + Math.max(0, x - radius)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / size;
      acc += tmp[Math.min(h - 1, y + radius + 1) * w + x] - tmp[Math.max(0, y - radius) * w + x];
    }
  }
  return out;
}

function looksLikePage(c, w, h) {
  // corners cut off by the photo's edge, or far from right angles -> not a whole page
  const mx = 0.02 * w, my = 0.02 * h;
  const onBorder = c.filter((p) => p.x < mx || p.x > w - mx || p.y < my || p.y > h - my).length;
  if (onBorder >= 2) return false;
  for (let i = 0; i < 4; i++) {
    const p = c[i], a = c[(i + 3) % 4], b = c[(i + 1) % 4];
    const ax = a.x - p.x, ay = a.y - p.y, bx = b.x - p.x, by = b.y - p.y;
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) + 1e-9);
    const angle = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (Math.abs(angle - 90) > 30) return false;
  }
  return true;
}

function fullImageCorners(w, h) {
  return [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }];
}

function findPage(source) {
  const { canvas, w, h } = source;
  const fallback = { corners: fullImageCorners(w, h), found: false };

  // shrink the photo so the search is fast
  const ratio = Math.min(1, DETECT_SIZE / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * ratio));
  const sh = Math.max(1, Math.round(h * ratio));
  const small = document.createElement('canvas');
  small.width = sw;
  small.height = sh;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(canvas, 0, 0, sw, sh);
  const px = sctx.getImageData(0, 0, sw, sh).data;

  // brightness, slightly blurred
  const gray = new Float32Array(sw * sh);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  }
  const blurred = boxBlur(gray, sw, sh, 2);

  // the page is lighter than the desk: split the photo into light and dark
  const threshold = otsuThreshold(blurred);
  const light = new Uint8Array(sw * sh);
  for (let i = 0; i < light.length; i++) light[i] = blurred[i] > threshold ? 1 : 0;

  // biggest connected light area = the page
  const seen = new Uint8Array(sw * sh);
  const stack = new Int32Array(sw * sh);
  let best = null;
  for (let start = 0; start < light.length; start++) {
    if (!light[start] || seen[start]) continue;
    let top = 0, area = 0;
    stack[top++] = start;
    seen[start] = 1;
    // the four extreme points of the area are the page corners
    const ext = { tl: null, tr: null, br: null, bl: null };
    let minS = Infinity, maxS = -Infinity, minD = Infinity, maxD = -Infinity;
    while (top) {
      const idx = stack[--top];
      const x = idx % sw, y = (idx - x) / sw;
      area++;
      const s = x + y, d = x - y;
      if (s < minS) { minS = s; ext.tl = { x, y }; }
      if (s > maxS) { maxS = s; ext.br = { x, y }; }
      if (d > maxD) { maxD = d; ext.tr = { x, y }; }
      if (d < minD) { minD = d; ext.bl = { x, y }; }
      if (x > 0 && light[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[top++] = idx - 1; }
      if (x < sw - 1 && light[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[top++] = idx + 1; }
      if (y > 0 && light[idx - sw] && !seen[idx - sw]) { seen[idx - sw] = 1; stack[top++] = idx - sw; }
      if (y < sh - 1 && light[idx + sw] && !seen[idx + sw]) { seen[idx + sw] = 1; stack[top++] = idx + sw; }
    }
    if (!best || area > best.area) best = { area, ext };
  }

  if (!best || best.area < 0.2 * sw * sh) return fallback;
  const small4 = [best.ext.tl, best.ext.tr, best.ext.br, best.ext.bl];
  if (!looksLikePage(small4, sw, sh)) return fallback;

  // back to full-photo coordinates, pulled in a little so no desk shows at the edges
  const full = small4.map((p) => ({ x: p.x / ratio, y: p.y / ratio }));
  const cx = full.reduce((s, p) => s + p.x, 0) / 4, cy = full.reduce((s, p) => s + p.y, 0) / 4;
  const corners = full.map((p) => ({ x: cx + (p.x - cx) * 0.99, y: cy + (p.y - cy) * 0.99 }));
  return { corners, found: true };
}

/* ---- 2. straighten ---- */

function solveLinear(a, b) {
  // Gaussian elimination with partial pivoting (8 x 8 here)
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) sum -= a[r][c] * x[c];
    x[r] = sum / a[r][r];
  }
  return x;
}

function straighten(source, corners) {
  const [tl, tr, br, bl] = corners;
  let width = Math.round(Math.max(Math.hypot(br.x - bl.x, br.y - bl.y), Math.hypot(tr.x - tl.x, tr.y - tl.y)));
  let height = Math.round(Math.max(Math.hypot(tr.x - br.x, tr.y - br.y), Math.hypot(tl.x - bl.x, tl.y - bl.y)));
  const shrink = Math.min(1, MAX_OUTPUT / Math.max(width, height));
  width = Math.max(1, Math.round(width * shrink));
  height = Math.max(1, Math.round(height * shrink));

  // for every pixel of the flat page, find where it comes from in the photo
  const dest = [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]];
  const rows = [], rhs = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dest[i];
    const { x, y } = corners[i];
    rows.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); rhs.push(x);
    rows.push([0, 0, 0, u, v, 1, -u * y, -v * y]); rhs.push(y);
  }
  const m = solveLinear(rows, rhs);

  const out = new ImageData(width, height);
  const src = source.data.data, sw = source.w, sh = source.h;
  for (let v = 0; v < height; v++) {
    for (let u = 0; u < width; u++) {
      const den = m[6] * u + m[7] * v + 1;
      const x = (m[0] * u + m[1] * v + m[2]) / den;
      const y = (m[3] * u + m[4] * v + m[5]) / den;
      const x0 = Math.max(0, Math.min(sw - 2, Math.floor(x)));
      const y0 = Math.max(0, Math.min(sh - 2, Math.floor(y)));
      const fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (v * width + u) * 4;
      for (let c = 0; c < 3; c++) {
        out.data[o + c] =
          src[i00 + c] * (1 - fx) * (1 - fy) + src[i10 + c] * fx * (1 - fy) +
          src[i01 + c] * (1 - fx) * fy + src[i11 + c] * fx * fy;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/* ---- 3. clean up ---- */

function maxFilter(src, w, h, radius) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = 0;
      for (let k = Math.max(0, x - radius); k <= Math.min(w - 1, x + radius); k++) best = Math.max(best, src[y * w + k]);
      tmp[y * w + x] = best;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = 0;
      for (let k = Math.max(0, y - radius); k <= Math.min(h - 1, y + radius); k++) best = Math.max(best, tmp[k * w + x]);
      out[y * w + x] = best;
    }
  }
  return out;
}

function removeShadows(channel, w, h) {
  // Estimate the paper's brightness everywhere (ignoring the ink), then divide it out.
  const f = Math.max(2, Math.round(Math.max(w, h) / 300));          // block size
  const bw = Math.ceil(w / f), bh = Math.ceil(h / f);
  let bg = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let best = 0;
      for (let y = by * f; y < Math.min(h, by * f + f); y++) {
        for (let x = bx * f; x < Math.min(w, bx * f + f); x++) best = Math.max(best, channel[y * w + x]);
      }
      bg[by * bw + bx] = best;                                         // brightest pixel in the block = paper
    }
  }
  bg = maxFilter(bg, bw, bh, 2);                                       // swallow big letters and boxes
  bg = boxBlur(boxBlur(bg, bw, bh, 3), bw, bh, 3);                     // smooth it out

  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gy = Math.max(0, Math.min(bh - 1, (y + 0.5) / f - 0.5));
    const y0 = Math.min(bh - 2 < 0 ? 0 : bh - 2, Math.floor(gy)), fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.max(0, Math.min(bw - 1, (x + 0.5) / f - 0.5));
      const x0 = Math.min(bw - 2 < 0 ? 0 : bw - 2, Math.floor(gx)), fx = gx - x0;
      const x1 = Math.min(bw - 1, x0 + 1), y1 = Math.min(bh - 1, y0 + 1);
      const b =
        bg[y0 * bw + x0] * (1 - fx) * (1 - fy) + bg[y0 * bw + x1] * fx * (1 - fy) +
        bg[y1 * bw + x0] * (1 - fx) * fy + bg[y1 * bw + x1] * fx * fy;
      out[y * w + x] = Math.min(255, (channel[y * w + x] * 255) / Math.max(b, 1));
    }
  }
  return out;
}

function boost(v) {
  return Math.max(0, Math.min(255, 1.15 * v - 25));   // black point up, paper to pure white
}

function cleanUp(imageData, mode) {
  const { width: w, height: h, data } = imageData;
  const n = w * h;
  const out = new ImageData(w, h);

  if (mode === 'color') {
    const flat = [0, 1, 2].map((c) => {
      const channel = new Float32Array(n);
      for (let i = 0; i < n; i++) channel[i] = data[i * 4 + c];
      return removeShadows(channel, w, h);
    });
    for (let i = 0; i < n; i++) {
      out.data[i * 4] = boost(flat[0][i]);
      out.data[i * 4 + 1] = boost(flat[1][i]);
      out.data[i * 4 + 2] = boost(flat[2][i]);
      out.data[i * 4 + 3] = 255;
    }
    return out;
  }

  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  const flat = removeShadows(gray, w, h);

  if (mode === 'gray') {
    for (let i = 0; i < n; i++) {
      const v = boost(flat[i]);
      out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
      out.data[i * 4 + 3] = 255;
    }
    return out;
  }

  // black and white: ink is black, paper is white
  const smooth = boxBlur(flat, w, h, 1);
  const t = otsuThreshold(smooth);
  for (let i = 0; i < n; i++) {
    const v = smooth[i] > t ? 255 : 0;
    out.data[i * 4] = out.data[i * 4 + 1] = out.data[i * 4 + 2] = v;
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

/* ---- whole pipeline ---- */

function currentStyle() {
  return document.querySelector('input[name="style"]:checked').value;
}

function scanNow() {
  if (!state.source) return;
  setStatus('Scanning…');
  // let the browser paint the message before the heavy work starts
  setTimeout(() => {
    const started = performance.now();
    let flat;
    let straightened = false;
    if (els.straighten.checked) {
      flat = straighten(state.source, state.corners);
      straightened = true;
    } else {
      const ratio = Math.min(1, MAX_OUTPUT / Math.max(state.source.w, state.source.h));
      const w = Math.round(state.source.w * ratio), h = Math.round(state.source.h * ratio);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(state.source.canvas, 0, 0, w, h);
      flat = ctx.getImageData(0, 0, w, h);
    }
    const result = cleanUp(flat, currentStyle());
    showResult(result);

    const secs = ((performance.now() - started) / 1000).toFixed(1);
    if (!straightened) setStatus(`Cleaned up in ${secs} s (straightening is switched off).`);
    else if (state.found) setStatus(`Page straightened and cleaned up in ${secs} s. Save it with PNG, JPG or PDF.`);
    else setStatus(`Cleaned up in ${secs} s. The page edges were not found, so check the corner dots.`);
  }, 30);
}

/* ============================================================== OUTPUT ===== */

function setStatus(text) {
  els.status.textContent = text;
}

function showResult(imageData) {
  els.result.width = imageData.width;
  els.result.height = imageData.height;
  els.result.getContext('2d').putImageData(imageData, 0, 0);
  els.result.classList.add('visible');
  els.phResult.classList.add('hidden');
  state.hasResult = true;
  [els.savePng, els.saveJpg, els.savePdf].forEach((b) => (b.disabled = false));
}

function clearResult() {
  els.result.classList.remove('visible');
  els.phResult.classList.remove('hidden');
  state.hasResult = false;
  [els.savePng, els.saveJpg, els.savePdf].forEach((b) => (b.disabled = true));
}

/* ---- the original photo, with draggable corner dots ---- */

const DISPLAY_WIDTH = 700;

function drawOriginal() {
  const { source, corners } = state;
  const canvas = els.original;
  const scale = Math.min(1, DISPLAY_WIDTH / source.w);
  canvas.width = Math.round(source.w * scale);
  canvas.height = Math.round(source.h * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source.canvas, 0, 0, canvas.width, canvas.height);

  const pts = corners.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#fff';
  ctx.stroke();

  pts.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.stroke();
  });

  canvas.classList.add('visible');
  els.phOriginal.classList.add('hidden');
}

function pointerToPhoto(event) {
  const rect = els.original.getBoundingClientRect();
  const scale = els.original.width / rect.width;                       // screen px -> canvas px
  const photoScale = state.source.w / els.original.width;              // canvas px -> photo px
  return {
    x: (event.clientX - rect.left) * scale * photoScale,
    y: (event.clientY - rect.top) * scale * photoScale,
    reach: 22 * scale * photoScale,                                    // how close counts as "on the dot"
  };
}

els.original.addEventListener('pointerdown', (event) => {
  if (!state.source) return;
  const p = pointerToPhoto(event);
  let nearest = -1, bestDist = p.reach;
  state.corners.forEach((c, i) => {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bestDist) { bestDist = d; nearest = i; }
  });
  if (nearest >= 0) {
    state.drag = nearest;
    els.original.setPointerCapture(event.pointerId);
  }
});

els.original.addEventListener('pointermove', (event) => {
  if (state.drag < 0) return;
  const p = pointerToPhoto(event);
  state.corners[state.drag] = {
    x: Math.max(0, Math.min(state.source.w - 1, p.x)),
    y: Math.max(0, Math.min(state.source.h - 1, p.y)),
  };
  state.found = true;
  drawOriginal();
});

function endDrag() {
  if (state.drag < 0) return;
  state.drag = -1;
  setStatus('Corners moved. Click Scan to straighten again.');
  if (state.hasResult) scanNow();
}
els.original.addEventListener('pointerup', endDrag);
els.original.addEventListener('pointercancel', endDrag);

/* ---- saving ---- */

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function canvasBlob(type, quality) {
  return new Promise((resolve) => els.result.toBlob(resolve, type, quality));
}

function makePdf(jpegBytes, width, height) {
  // A one-page PDF that holds the scan as a JPEG picture (150 dots per inch).
  const pageW = (width * 72 / 150).toFixed(2), pageH = (height * 72 / 150).toFixed(2);
  const enc = new TextEncoder();
  const parts = [], offsets = [];
  let length = 0;
  const push = (data) => {
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    parts.push(bytes);
    length += bytes.length;
  };
  const begin = (n) => { offsets[n] = length; push(`${n} 0 obj\n`); };

  push('%PDF-1.4\n');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2); push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  begin(3); push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
  begin(4);
  push(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpegBytes.length} >>\nstream\n`);
  push(jpegBytes);
  push('\nendstream\nendobj\n');
  const content = `q ${pageW} 0 0 ${pageH} 0 0 cm /Im0 Do Q`;
  begin(5); push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

  const xref = length;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let n = 1; n <= 5; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let pos = 0;
  parts.forEach((p) => { out.set(p, pos); pos += p.length; });
  return new Blob([out], { type: 'application/pdf' });
}

els.savePng.addEventListener('click', async () => {
  download(await canvasBlob('image/png'), `${state.fileName}-scan.png`);
});
els.saveJpg.addEventListener('click', async () => {
  download(await canvasBlob('image/jpeg', 0.92), `${state.fileName}-scan.jpg`);
});
els.savePdf.addEventListener('click', async () => {
  const jpeg = new Uint8Array(await (await canvasBlob('image/jpeg', 0.92)).arrayBuffer());
  download(makePdf(jpeg, els.result.width, els.result.height), `${state.fileName}-scan.pdf`);
});

/* ---- buttons, drop zone ---- */

els.file.addEventListener('change', () => {
  if (els.file.files[0]) loadFile(els.file.files[0]);
  els.file.value = '';      // lets you choose the same photo again
});
els.scan.addEventListener('click', scanNow);
document.querySelectorAll('input[name="style"]').forEach((r) =>
  r.addEventListener('change', () => { if (state.hasResult) scanNow(); }));
els.straighten.addEventListener('change', () => { if (state.hasResult) scanNow(); });

['dragenter', 'dragover'].forEach((type) =>
  els.dropzone.addEventListener(type, (e) => { e.preventDefault(); els.dropzone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((type) =>
  els.dropzone.addEventListener(type, (e) => { e.preventDefault(); els.dropzone.classList.remove('dragging'); }));
els.dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});