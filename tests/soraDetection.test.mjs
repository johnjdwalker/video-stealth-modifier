import { findCandidates, buildDwells } from '../.test-build/soraDetection.mjs';

const W = 270, H = 480; // portrait 9:16 at working resolution

function blank() {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    // Mid-tone textured ground so top-hat has something to work against.
    const v = 70 + ((i * 37) % 23);
    d[i*4] = v; d[i*4+1] = v - 6; d[i*4+2] = v - 14; d[i*4+3] = 255;
  }
  return d;
}
const put = (d, x, y, w, h, r, g, b) => {
  for (let j = Math.max(0,y); j < Math.min(H, y+h); j++)
    for (let i = Math.max(0,x); i < Math.min(W, x+w); i++) {
      const p = (j*W+i)*4; d[p]=r; d[p+1]=g; d[p+2]=b; d[p+3]=255;
    }
};
// A Sora-style mark: rounded icon + four glyph blobs, wide and short.
function drawMark(d, x, y) {
  put(d, x, y, 12, 12, 250, 250, 250);          // icon
  let gx = x + 16;
  for (const wdt of [6, 6, 4, 6]) {              // S o r a
    put(d, gx, y + 3, wdt, 8, 245, 245, 245);
    gx += wdt + 3;
  }
  return { x, y, width: (gx - 3) - x, height: 12 };
}
const img = (d) => ({ data: d, width: W, height: H, colorSpace: 'srgb' });

function report(name, cands, expect) {
  const got = cands.length > 0;
  const ok = got === expect;
  const detail = cands.slice(0,2).map(c =>
    `[${c.bbox.x},${c.bbox.y} ${c.bbox.width}x${c.bbox.height} score=${c.score.toFixed(2)}]`).join(' ');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} candidates=${cands.length} ${detail}`);
  return ok;
}

let pass = true;

// 1. Bright overcast sky filling the top half (screenshot 2).
let d = blank();
put(d, 0, 0, W, Math.round(H*0.45), 214, 216, 220);
pass = report('bright sky, no watermark', findCandidates(img(d), W, H), false) && pass;

// 2. Large white phone UI panel in the middle (screenshot 1).
d = blank();
put(d, 90, 150, 95, 190, 246, 246, 248);
pass = report('white phone screen, no watermark', findCandidates(img(d), W, H), false) && pass;

// 3. A transient white chip/toast (screenshot 3). A single frame legitimately
// looks like a mark; the temporal stage is what must reject it. Chip shows for
// 4 of 24 frames, the real mark is present throughout -> mark must win.
{
  const fs = [];
  for (let i = 0; i < 24; i++) {
    const dd = blank();
    drawMark(dd, 22, 430);                       // real mark, every frame
    if (i >= 8 && i < 12) put(dd, 30, 60, 70, 22, 240, 240, 242); // chip, 4 frames
    fs.push({ time: i * 0.5, index: i, candidates: findCandidates(img(dd), W, H) });
  }
  const { dwells: dw } = buildDwells(fs, W, H);
  const chipRejected = dw.every(x => x.bbox.y > 300);
  console.log(`${chipRejected?'PASS':'FAIL'}  ${'transient chip rejected, mark kept'.padEnd(46)} ` +
    dw.map(x=>`@(${x.bbox.x},${x.bbox.y}) ${x.startTime.toFixed(1)}-${x.endTime.toFixed(1)}s`).join(' '));
  pass = chipRejected && pass;
}

// 4. The real thing, bottom-left corner.
d = blank();
const truth = drawMark(d, 22, 430);
let c = findCandidates(img(d), W, H);
pass = report('sora mark bottom-left', c, true) && pass;
if (c.length) {
  const b = c[0].bbox;
  const near = Math.abs(b.x-truth.x)<=3 && Math.abs(b.y-truth.y)<=3
            && Math.abs(b.width-truth.width)<=4 && Math.abs(b.height-truth.height)<=3;
  console.log(`${near?'PASS':'FAIL'}  ${'  └ box matches ground truth'.padEnd(46)} got [${b.x},${b.y} ${b.width}x${b.height}] want [${truth.x},${truth.y} ${truth.width}x${truth.height}]`);
  pass = near && pass;
}

// 5. The hard case: mark on top of sky AND a phone screen present.
d = blank();
put(d, 0, 0, W, Math.round(H*0.45), 214, 216, 220);
put(d, 90, 150, 95, 190, 246, 246, 248);
const truth2 = drawMark(d, 22, 40); // over the sky
c = findCandidates(img(d), W, H);
const top = c[0];
const hit = top && Math.abs(top.bbox.x-truth2.x)<=3 && Math.abs(top.bbox.y-truth2.y)<=3;
console.log(`${hit?'PASS':'FAIL'}  ${'mark over sky + phone: top candidate is mark'.padEnd(46)} ${top?`[${top.bbox.x},${top.bbox.y} ${top.bbox.width}x${top.bbox.height}]`:'none'}`);
pass = hit && pass;

// 6. Dwell clustering: mark holds bottom-left, hops to top-left.
const frames = [];
for (let i = 0; i < 24; i++) {
  const dd = blank();
  const pos = i < 12 ? { x: 22, y: 430 } : { x: 22, y: 40 };
  drawMark(dd, pos.x, pos.y);
  frames.push({ time: i * 0.5, index: i, candidates: findCandidates(img(dd), W, H) });
}
const { dwells, logoSize } = buildDwells(frames, W, H);
const twoDwells = dwells.length === 2;
console.log(`${twoDwells?'PASS':'FAIL'}  ${'dwell clustering finds 2 positions'.padEnd(46)} got ${dwells.length}: ` +
  dwells.map(dw=>`${dw.startTime.toFixed(1)}-${dw.endTime.toFixed(1)}s @(${dw.bbox.x},${dw.bbox.y}) ${dw.confidence}%`).join('  '));
pass = twoDwells && pass;
console.log(`       median mark size = ${logoSize ? logoSize.width+'x'+logoSize.height : 'null'}`);

console.log(pass ? '\nALL PASS' : '\nSOME FAILED');
process.exit(pass ? 0 : 1);
