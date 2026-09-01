import { resolveTimeline, boxAtTime } from '../.test-build/sora.mjs';

let pass = true;
const check = (name, cond, detail='') => {
  console.log(`${cond?'PASS':'FAIL'}  ${name.padEnd(52)} ${detail}`);
  pass = cond && pass;
};

const mk = (start, end, x, y) => ({
  startTime: start, endTime: end,
  bbox: { x, y, width: 50, height: 14 },
  samples: [{ time: (start+end)/2, bbox: { x, y, width: 50, height: 14 }, confidence: 80 }],
  confidence: 80, source: 'auto',
});
// Mark sits bottom-left 0-6s, then top-right 6-12s.
const detection = {
  detected: true, videoWidth: 1080, videoHeight: 1920, videoDuration: 12,
  dwells: [mk(0, 6, 40, 1800), mk(6, 12, 900, 60)],
  padding: 10, logoSize: {width:50,height:14}, averageConfidence: 80,
  coverage: 1, samplesAnalyzed: 24,
};

// --- no interpolation across a hop ---
const base = resolveTimeline(detection, [], 12);
const atHop = boxAtTime(base, 5.99, 10, 1080, 1920);
const afterHop = boxAtTime(base, 6.01, 10, 1080, 1920);
check('box holds its dwell right up to the hop', atHop.y > 1700, `y=${atHop.y}`);
check('box snaps to the new position after the hop', afterHop.y < 200, `y=${afterHop.y}`);
// The old lerping model would have put the box mid-frame at the midpoint.
const mid = boxAtTime(base, 6.0, 10, 1080, 1920);
check('never drifts through the middle of the frame', mid.y > 1700 || mid.y < 200, `y=${mid.y}`);

// --- a correction overrides the dwell containing it ---
const corrected = resolveTimeline(detection, [
  { id: 'c1', time: 2, bbox: { x: 500, y: 1000, width: 60, height: 18 } },
], 12);
const inFixed = boxAtTime(corrected, 4.5, 0, 1080, 1920);
const untouched = boxAtTime(corrected, 9, 0, 1080, 1920);
check('correction applies across its whole dwell', inFixed.x === 500 && inFixed.y === 1000, `(${inFixed.x},${inFixed.y})`);
check('the other dwell is left alone', untouched.x === 900 && untouched.y === 60, `(${untouched.x},${untouched.y})`);
check('corrected dwell is marked manual', corrected.find(d => d.source === 'manual') !== undefined);

// --- a correction landing in a gap creates a dwell ---
const gapDet = { ...detection, dwells: [mk(0, 3, 40, 1800), mk(9, 12, 900, 60)] };
const withGap = resolveTimeline(gapDet, [
  { id: 'c2', time: 6, bbox: { x: 300, y: 700, width: 60, height: 18 } },
], 12);
const inGap = boxAtTime(withGap, 6, 0, 1080, 1920);
check('correction in a gap becomes its own dwell', withGap.length === 3 && inGap.x === 300, `dwells=${withGap.length} x=${inGap.x}`);

// --- padding and clamping ---
const edge = boxAtTime(resolveTimeline({...detection, dwells:[mk(0,12,0,0)]}, [], 12), 1, 10, 1080, 1920);
check('padding never escapes the frame', edge.x >= 0 && edge.y >= 0 && edge.x+edge.width <= 1080, JSON.stringify(edge));

// --- letterbox math: the bug that put the overlay in the black bars ---
function getContentRect(elW, elH, vw, vh) {
  const scale = Math.min(elW / vw, elH / vh);
  const w = vw * scale, h = vh * scale;
  return { left: (elW - w)/2, top: (elH - h)/2, scale };
}
// A 1080x1920 portrait clip inside the old hard-coded 16:9 box (960x540).
const r = getContentRect(960, 540, 1080, 1920);
const markX = 40;                       // watermark 40px from the left of the video
const correct = r.left + markX * r.scale;
const oldBuggy = 0 + markX * (960 / 1080); // what the old code computed
check('letterbox-aware overlay lands on the picture',
  correct > r.left - 1 && correct < r.left + 30,
  `correct=${correct.toFixed(0)}px  old=${oldBuggy.toFixed(0)}px  picture starts at ${r.left.toFixed(0)}px`);
check('old math placed it outside the picture', oldBuggy < r.left, `${oldBuggy.toFixed(0)} < ${r.left.toFixed(0)}`);

console.log(pass ? '\nALL PASS' : '\nSOME FAILED');
process.exit(pass ? 0 : 1);
