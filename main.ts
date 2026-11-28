// png-squeeze entry: lossless PNG recompression of 1280x720 RGBA screenshots.
// Pipeline per instance (all deterministic, work budgeted by data size, never by the clock):
//   decode -> analyse (colours / grey / opacity / tRNS key) -> candidate forms
//   (palette by count, palette by luminance, grey / grey+alpha / RGB / RGBA / tRNS-keyed)
//   -> filter screen (fixed 0-4, minimum-sum, fewest-pairs; zlib level 6 weighs each)
//   -> winner refined with per-row brute-force filter choice on larger instances
//   -> final deflate: best of several zlib level-9 configurations, raced against
//      a built-in optimal-parse deflate (zopfli-style DP with iterative cost
//      refinement over 128 KiB blocks); the smaller stream wins.
// Only Node built-in modules. Output PNGs use only IHDR/PLTE/tRNS/IDAT/IEND, bit depth 8,
// non-interlaced, one zlib stream in a single IDAT.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';
import { setFlagsFromString } from 'node:v8';

// The sandbox gives this process 512 MiB; cap the heap well under it so the
// collector recycles the compressor's transient buffers instead of letting
// the resident set drift toward the limit.
setFlagsFromString('--max-old-space-size=384');

// ---------------------------------------------------------------- PNG basics
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// ------------------------------------------------------------------- decoder
// Reads exactly the PNG subset the contest accepts and expands to RGBA.
function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let ended = false;
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType: data[9] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') ended = true;
  }
  if (!ended || header === null || idat.length === 0) throw new Error('unreadable input PNG');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('inflated size mismatch');
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = palette[e * 3];
      rgba[d + 1] = palette[e * 3 + 1];
      rgba[d + 2] = palette[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { rgba, width, height };
}

// ------------------------------------------------------------------ analysis
function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many
    ? null
    : [...counts.keys()].map((c) => {
        const b = new Uint8Array(Uint32Array.of(c).buffer);
        return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
      });
  return { opaque, grey, colours };
}

function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const order of ['count', 'luminance']) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, palette: true });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, palette: false });
  return forms;
}

// ----------------------------------------------------------------- filtering
const BRUTE_CONTEXT = 32768;

function pairsCost(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// choice: filter type 0..4 for all rows, or 'minsum' | 'pairs' | 'brute' per row.
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsCost(trial[t].subarray(1), seen, ++stamp);
      else {
        const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
        cost = deflateSync(trial[t], before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ------------------------------------------------------------------ deflate
const SCREEN_OPTS = { level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY };
const FINAL_OPTS = [
  { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY },
  { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
  { level: 9, memLevel: 9, strategy: constants.Z_FIXED },
];

function bestDeflate(data, optsList) {
  let best = null;
  for (const opts of optsList) {
    const z = deflateSync(data, opts);
    if (best === null || z.length < best.length) best = z;
  }
  return best;
}

// ------------------------------------------------------- optimal-parse deflate
// A zopfli-style compressor: hash-chain match finding (longest match plus the
// nearest match of length >= 3 as a second distance candidate), then per
// 128 KiB block a dynamic-programming optimal parse whose literal/length and
// distance costs are refined iteratively from the previous parse's Huffman
// statistics (with a deterministic convergence stop). Emits standard dynamic
// Huffman blocks; returns a complete zlib stream. Deterministic throughout.
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const LEN_SYM = new Int16Array(259); // length -> symbol 257..285
const LEN_EB = new Uint8Array(259);
for (let c = 0; c < 29; c++) {
  const hi = c < 28 ? LEN_BASE[c + 1] - 1 : 258;
  for (let l = LEN_BASE[c]; l <= hi; l++) { LEN_SYM[l] = 257 + c; LEN_EB[l] = LEN_EXTRA[c]; }
}
const DIST_SYM = new Uint8Array(32769);
const DIST_EB = new Uint8Array(32769);
for (let c = 0; c < 30; c++) {
  const hi = c < 29 ? DIST_BASE[c + 1] - 1 : 32768;
  for (let d = DIST_BASE[c]; d <= hi; d++) { DIST_SYM[d] = c; DIST_EB[d] = DIST_EXTRA[c]; }
}
// candidate lengths to evaluate in the DP for a match: all lengths up to 24,
// then length-code segment starts/ends, then the match length itself.
const CAND = [];
{
  const set = new Set();
  for (let l = 3; l <= 24; l++) set.add(l);
  for (let c = 0; c < 29; c++) { set.add(LEN_BASE[c]); if (LEN_BASE[c] > 3) set.add(LEN_BASE[c] - 1); }
  CAND.push(...[...set].filter((l) => l >= 3 && l <= 258).sort((a, b) => a - b));
}

function huffmanLengths(counts, maxBits) {
  const n = counts.length;
  const lengths = new Int32Array(n);
  const used = [];
  for (let i = 0; i < n; i++) if (counts[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) { lengths[used[0]] = 1; return lengths; }
  // unconstrained Huffman via repeated two-smallest merge (alphabet <= 286)
  const weight = new Float64Array(2 * used.length);
  const parent = new Int32Array(2 * used.length).fill(-1);
  for (let i = 0; i < used.length; i++) weight[i] = counts[used[i]];
  let nodes = used.length;
  const alive = new Set(Array.from({ length: nodes }, (_, i) => i));
  while (alive.size > 1) {
    let a = -1, b = -1;
    for (const i of alive) {
      if (a === -1 || weight[i] < weight[a]) { b = a; a = i; }
      else if (b === -1 || weight[i] < weight[b]) b = i;
    }
    alive.delete(a); alive.delete(b);
    weight[nodes] = weight[a] + weight[b];
    parent[a] = nodes; parent[b] = nodes;
    alive.add(nodes);
    nodes++;
  }
  for (let i = 0; i < used.length; i++) {
    let d = 0, j = i;
    while (parent[j] !== -1) { d++; j = parent[j]; }
    lengths[used[i]] = d;
  }
  let maxLen = 0;
  for (const i of used) if (lengths[i] > maxLen) maxLen = lengths[i];
  if (maxLen <= maxBits) return lengths;
  // Overflow fix on the length histogram (the method zlib's gen_bitlen uses):
  // clamp deep codes to maxBits, then repeatedly split the deepest available
  // shorter code and drop one maxBits code; each step keeps the symbol count
  // and lowers the Kraft sum (units of 2^-maxBits) by exactly 1.
  const blCount = new Int32Array(maxLen + 2);
  for (const i of used) blCount[lengths[i]]++;
  let kraft = 0;
  for (let l = 1; l < maxBits; l++) kraft += blCount[l] * (1 << (maxBits - l));
  let deep = 0;
  for (let l = maxBits; l <= maxLen; l++) deep += blCount[l];
  kraft += deep; // clamped codes contribute 1 unit each
  blCount[maxBits] = deep;
  const target = 1 << maxBits;
  while (kraft > target) {
    let m = maxBits - 1;
    while (blCount[m] === 0) m--;
    blCount[m]--;
    blCount[m + 1] += 2;
    blCount[maxBits]--;
    kraft--;
  }
  // hand the lengths back out: shortest lengths to the largest counts
  const byCountDesc = [...used].sort((x, y) => counts[y] - counts[x] || x - y);
  const out = new Int32Array(n);
  let at = 0;
  for (let l = 1; l <= maxBits; l++) for (let k = 0; k < blCount[l]; k++) out[byCountDesc[at++]] = l;
  return out;
}

function canonicalCodes(lengths) {
  const maxBits = Math.max(...lengths);
  const blCount = new Int32Array(maxBits + 1);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const next = new Int32Array(maxBits + 1);
  let code = 0;
  for (let b = 1; b <= maxBits; b++) { code = (code + blCount[b - 1]) << 1; next[b] = code; }
  const codes = new Int32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) codes[i] = next[lengths[i]]++;
  return codes;
}

const HASH_BITS = 16;
const HASH_SIZE = 1 << HASH_BITS;
function hashAt(data, i) {
  const v = (data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2];
  return (Math.imul(v, 0x9e3779b1) >>> (32 - HASH_BITS)) & (HASH_SIZE - 1);
}

function computeMatches(data, maxChain) {
  const n = data.length;
  const matchLen = new Uint16Array(n);
  const matchDist = new Uint32Array(n);
  const nearLen = new Uint16Array(n);
  const nearDist = new Uint32Array(n);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const maxLen = Math.min(258, n - i);
    if (maxLen >= 3) {
      const limit = i - 32768 > 0 ? i - 32768 : 0;
      let j = head[hashAt(data, i)];
      let bestLen = 2;
      let bestDist = 0;
      let nLen = 0;
      let nDist = 0;
      let chain = maxChain;
      while (j >= limit && chain-- > 0) {
        if (data[j + bestLen] === data[i + bestLen] && data[j] === data[i]) {
          let l = 0;
          while (l < maxLen && data[j + l] === data[i + l]) l++;
          if (l >= 3 && nLen === 0) { nLen = l; nDist = i - j; }
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - j;
            if (l >= maxLen) break;
            if (l >= 64) chain = Math.min(chain, 4);
            else if (l >= 16) chain = Math.min(chain, 16);
          }
        }
        j = prev[j];
      }
      if (bestLen >= 3) { matchLen[i] = bestLen; matchDist[i] = bestDist; }
      if (nLen >= 3) { nearLen[i] = nLen; nearDist[i] = nDist; }
    }
    if (i + 2 < n) {
      const h = hashAt(data, i);
      prev[i] = head[h];
      head[h] = i;
    }
  }
  return { matchLen, matchDist, nearLen, nearDist };
}

// Parses data[start..end); pick/pickDist are filled at absolute positions.
// Matches may reference data before `start` (distances reach across blocks).
function dpParse(data, start, end, M, litCost, lenCost, distCost, pick, pickDist) {
  const { matchLen, matchDist, nearLen, nearDist } = M;
  const n = end - start;
  const cost = new Float64Array(n + 1);
  for (let k = n - 1; k >= 0; k--) {
    const i = start + k;
    let best = litCost[data[i]] + cost[k + 1];
    let bl = 0;
    let bd = 0;
    for (let cand = 0; cand < 2; cand++) {
      const ml = cand === 0 ? matchLen[i] : nearLen[i];
      const md = cand === 0 ? matchDist[i] : nearDist[i];
      if (ml < 3 || (cand === 1 && md === matchDist[i])) continue;
      const dc = distCost[md];
      const cap = ml < n - k ? ml : n - k;
      for (let ci = 0; ci < CAND.length; ci++) {
        const l = CAND[ci];
        if (l > cap) break;
        const c = lenCost[l] + dc + cost[k + l];
        if (c < best) { best = c; bl = l; bd = md; }
      }
      if (cap > 24) {
        const c = lenCost[cap] + dc + cost[k + cap];
        if (c < best) { best = c; bl = cap; bd = md; }
      }
    }
    cost[k] = best;
    pick[i] = bl;
    pickDist[i] = bd;
  }
  return cost[0];
}

function statsOf(data, start, end, pick, pickDist) {
  const litCounts = new Float64Array(288);
  const distCounts = new Float64Array(30);
  let i = start;
  while (i < end) {
    const l = pick[i];
    if (l === 0) { litCounts[data[i]]++; i++; }
    else {
      litCounts[LEN_SYM[l]]++;
      distCounts[DIST_SYM[pickDist[i]]]++;
      i += l;
    }
  }
  litCounts[256] = 1;
  return { litCounts, distCounts };
}

function costsFromLengths(litLen, distLen) {
  const litCost = new Float64Array(288);
  for (let i = 0; i < 288; i++) litCost[i] = litLen[i] === 0 ? 15 : litLen[i];
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = (litLen[LEN_SYM[l]] === 0 ? 15 : litLen[LEN_SYM[l]]) + LEN_EB[l];
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) distCost[d] = (distLen[DIST_SYM[d]] === 0 ? 15 : distLen[DIST_SYM[d]]) + DIST_EB[d];
  return { litCost: litCost.subarray(0, 256), lenCost, distCost };
}

function revBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) { r = (r << 1) | (code & 1); code >>= 1; }
  return r;
}

class BitWriter {
  constructor() { this.bytes = []; this.buf = 0; this.cnt = 0; }
  bits(value, count) {
    this.buf |= value << this.cnt;
    this.cnt += count;
    while (this.cnt >= 8) { this.bytes.push(this.buf & 0xff); this.buf >>>= 8; this.cnt -= 8; }
  }
  // Huffman codes are read by the decoder MSB-first: emit the code
  // bit-reversed through the LSB-first writer.
  huff(code, count) { this.bits(revBits(code, count), count); }
  finish() {
    if (this.cnt > 0) this.bytes.push(this.buf & 0xff);
    return Uint8Array.from(this.bytes);
  }
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitBlock(w, data, start, end, pick, pickDist, litLen, distLen, isFinal) {
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const allLens = [];
  for (let i = 0; i < hlit; i++) allLens.push(litLen[i]);
  for (let i = 0; i < hdist; i++) allLens.push(distLen[i]);
  // run-length encode the code lengths
  const rle = []; // [symbol, extraValue, extraBits]
  let p = 0;
  while (p < allLens.length) {
    const v = allLens[p];
    let run = 1;
    while (p + run < allLens.length && allLens[p + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) { const t = Math.min(left, 138); rle.push([18, t - 11, 7]); left -= t; }
      if (left >= 3) { rle.push([17, left - 3, 3]); left = 0; }
      while (left-- > 0) rle.push([0, 0, 0]);
    } else {
      rle.push([v, 0, 0]);
      let left = run - 1;
      while (left >= 3) { const t = Math.min(left, 6); rle.push([16, t - 3, 2]); left -= t; }
      while (left-- > 0) rle.push([v, 0, 0]);
    }
    p += run;
  }
  const clCounts = new Float64Array(19);
  for (const [s] of rle) clCounts[s]++;
  const clLenFull = huffmanLengths(clCounts, 7);
  let hclen = 19;
  while (hclen > 4 && clLenFull[CL_ORDER[hclen - 1]] === 0) hclen--;
  const clCodesBySym = canonicalCodes(clLenFull);
  // header
  w.bits(isFinal ? 1 : 0, 1);
  w.bits(2, 2); // dynamic Huffman block
  w.bits(hlit - 257, 5);
  w.bits(hdist - 1, 5);
  w.bits(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) w.bits(clLenFull[CL_ORDER[i]], 3);
  for (const [s, ev, eb] of rle) {
    w.huff(clCodesBySym[s], clLenFull[s]);
    if (eb > 0) w.bits(ev, eb);
  }
  // data
  let i = start;
  while (i < end) {
    const l = pick[i];
    if (l === 0) {
      w.huff(litCode[data[i]], litLen[data[i]]);
      i++;
    } else {
      const sym = LEN_SYM[l];
      w.huff(litCode[sym], litLen[sym]);
      if (LEN_EB[l] > 0) w.bits(l - LEN_BASE[sym - 257], LEN_EB[l]);
      const d = pickDist[i];
      const dsym = DIST_SYM[d];
      w.huff(distCode[dsym], distLen[dsym]);
      if (DIST_EB[d] > 0) w.bits(d - DIST_BASE[dsym], DIST_EB[d]);
      i += l;
    }
  }
  w.huff(litCode[256], litLen[256]);
}

function optimalDeflate(data, { iterations = 12, maxChain = 1024, blockSize = 131072 } = {}) {
  const M = computeMatches(data, maxChain);
  const pick = new Uint16Array(data.length);
  const pickDist = new Uint32Array(data.length);
  const w = new BitWriter();
  for (let start = 0; start < data.length; start += blockSize) {
    const end = Math.min(data.length, start + blockSize);
    // seed statistics with a greedy longest-match parse of this block
    {
      let i = start;
      while (i < end) {
        const cap = Math.min(M.matchLen[i], end - i);
        if (cap >= 3) { pick[i] = cap; pickDist[i] = M.matchDist[i]; i += cap; }
        else { pick[i] = 0; i++; }
      }
    }
    let stats = statsOf(data, start, end, pick, pickDist);
    let litLen = huffmanLengths(stats.litCounts, 15);
    let distLen = huffmanLengths(stats.distCounts, 15);
    let prevBits = Infinity;
    let flatRuns = 0;
    for (let it = 0; it < iterations; it++) {
      const { litCost, lenCost, distCost } = costsFromLengths(litLen, distLen);
      const bits = dpParse(data, start, end, M, litCost, lenCost, distCost, pick, pickDist);
      stats = statsOf(data, start, end, pick, pickDist);
      litLen = huffmanLengths(stats.litCounts, 15);
      distLen = huffmanLengths(stats.distCounts, 15);
      // deterministic early stop: this block's estimated cost has converged
      if (it >= 3 && prevBits - bits < prevBits * 0.0002) {
        if (++flatRuns >= 2) break;
      } else flatRuns = 0;
      prevBits = bits;
    }
    emitBlock(w, data, start, end, pick, pickDist, litLen, distLen, end === data.length);
  }
  return w.finish();
}

function zlibWrap(deflateBytes, data) {
  // zlib header 0x78 0xDA + adler32 of the uncompressed data
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  const adler = ((b << 16) | a) >>> 0;
  const out = new Uint8Array(deflateBytes.length + 6);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(deflateBytes, 2);
  const n = deflateBytes.length + 2;
  out[n] = (adler >>> 24) & 0xff;
  out[n + 1] = (adler >>> 16) & 0xff;
  out[n + 2] = (adler >>> 8) & 0xff;
  out[n + 3] = adler & 0xff;
  return out;
}

const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// --------------------------------------------------------------------- main
function squeeze(rgba, width, height) {
  const forms = formsOf(rgba);
  // Screen: cheap filter choices weighed by zlib level 6 (no brute yet).
  let best = null; // {form, data, bytes} bytes counts zlib stream + PLTE/tRNS chunks
  for (const form of forms) {
    const choices = form.palette ? [0, 'minsum'] : [0, 2, 'minsum', 'pairs'];
    const chunks = chunkBytes(form);
    for (const choice of choices) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(data, SCREEN_OPTS);
      const bytes = z.length + chunks;
      if (best === null || bytes < best.bytes) best = { form, data, bytes };
    }
  }
  // Refine the winning form with per-row brute-force filter choice, weighed the
  // same way; keep it only when it actually weighs less.
  {
    const data = filtered(best.form.samples, width, height, best.form.bpp, 'brute');
    const z = deflateSync(data, SCREEN_OPTS);
    const bytes = z.length + chunkBytes(best.form);
    if (bytes < best.bytes) best = { form: best.form, data, bytes };
  }
  // Final: strongest zlib configurations on the winning filtered data, raced
  // against the optimal-parse compressor. When the parser beats the first
  // zlib configuration by more than 1% the remaining configurations (which
  // never differed from it by more than a fraction of a percent in testing)
  // are skipped; otherwise all of them run and the true minimum is kept.
  let idat = bestDeflate(best.data, [FINAL_OPTS[0]]);
  const parsed = best.data.length >= 16
    ? zlibWrap(optimalDeflate(best.data), best.data)
    : null;
  if (parsed !== null && parsed.length < idat.length * 0.99) {
    idat = parsed;
  } else {
    const rest = bestDeflate(best.data, FINAL_OPTS.slice(1));
    if (rest.length < idat.length) idat = rest;
    if (parsed !== null && parsed.length < idat.length) idat = parsed;
  }
  return pngOfForm(width, height, best.form, new Uint8Array(idat.buffer, idat.byteOffset, idat.length));
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
