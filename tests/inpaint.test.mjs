import { inpaintRegion } from '../.test-build/inpaint.mjs';

const readW = 22, readH = 22, fx = 1, fy = 1, W = 20, H = 20;
let pass = true;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(52)} ${detail}`);
  pass = cond && pass;
};

function make(fn) {
  const d = new Uint8ClampedArray(readW * readH * 4);
  for (let y = 0; y < readH; y++) for (let x = 0; x < readW; x++) {
    const i = (y * readW + x) * 4;
    const [r, g, b] = fn(x, y);
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  }
  return d;
}
const inRegion = (x, y) => x >= fx && x < fx + W && y >= fy && y < fy + H;

// Uniform background: the fill must reproduce it exactly.
let d = make((x, y) => inRegion(x, y) ? [255, 255, 255] : [120, 120, 120]);
inpaintRegion(d, readW, readH, fx, fy, W, H);
let min = Infinity, max = -Infinity;
for (let y = fy; y < fy + H; y++) for (let x = fx; x < fx + W; x++) {
  const v = d[(y * readW + x) * 4]; min = Math.min(min, v); max = Math.max(max, v);
}
check('uniform background reproduced exactly', min === 120 && max === 120, `range [${min}, ${max}]`);

// Horizontal gradient: also exactly reproducible by the interpolation.
const grad = (x) => Math.round(40 + x * (160 / (readW - 1)));
d = make((x, y) => inRegion(x, y) ? [255, 255, 255] : [grad(x), grad(x), grad(x)]);
inpaintRegion(d, readW, readH, fx, fy, W, H);
let worst = 0;
for (let y = fy; y < fy + H; y++) for (let x = fx; x < fx + W; x++) {
  worst = Math.max(worst, Math.abs(d[(y * readW + x) * 4] - grad(x)));
}
check('gradient background reproduced', worst <= 1, `max error ${worst}/255`);

// The watermark's own colour must never reach the fill.
d = make((x, y) => inRegion(x, y) ? [255, 255, 255] : [0, 0, 0]);
inpaintRegion(d, readW, readH, fx, fy, W, H);
max = -Infinity;
for (let y = fy; y < fy + H; y++) for (let x = fx; x < fx + W; x++) {
  max = Math.max(max, d[(y * readW + x) * 4]);
}
check('no watermark colour leaks into the fill', max === 0, `max fill value ${max}`);

// A region touching the frame edge still fills from the borders it has.
d = make((x, y) => (x < 10 && y < 10) ? [255, 255, 255] : [90, 90, 90]);
inpaintRegion(d, readW, readH, 0, 0, 10, 10);
let anyWhite = false;
for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
  if (d[(y * readW + x) * 4] > 200) anyWhite = true;
}
check('region on the frame edge is still filled', !anyWhite);

console.log(pass ? '\nALL PASS' : '\nSOME FAILED');
process.exit(pass ? 0 : 1);
