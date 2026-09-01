/**
 * Region inpainting shared by the corner-watermark and Sora removers.
 *
 * Every pixel inside the region is reconstructed by inverse-distance
 * interpolation between the four *clean* border pixels that bracket it — the
 * row and column immediately outside the region. The interpolation is
 * O(region pixels), allocates nothing per pixel, reproduces flat and gradient
 * backgrounds exactly, and can never pull the watermark's own colour into the
 * fill (it never reads a pixel from inside the region).
 */

/**
 * Inpaints a rectangle inside an RGBA buffer, in place.
 *
 * @param data   RGBA pixel buffer (e.g. `ImageData.data`).
 * @param bufW   Buffer width in pixels.
 * @param bufH   Buffer height in pixels.
 * @param fx/fy  Top-left of the region to fill, in buffer coordinates.
 * @param w/h    Size of the region to fill.
 */
export function inpaintRegion(
  data: Uint8ClampedArray,
  bufW: number,
  bufH: number,
  fx: number,
  fy: number,
  w: number,
  h: number
): void {
  if (w <= 0 || h <= 0) return;

  const leftX = fx - 1;
  const rightX = fx + w;
  const topY = fy - 1;
  const botY = fy + h;
  const hasLeft = leftX >= 0;
  const hasRight = rightX < bufW;
  const hasTop = topY >= 0;
  const hasBottom = botY < bufH;

  // Nothing clean to sample from (the region covers the whole buffer).
  if (!hasLeft && !hasRight && !hasTop && !hasBottom) return;

  const at = (px: number, py: number) => (py * bufW + px) * 4;

  for (let j = 0; j < h; j++) {
    const py = fy + j;
    if (py < 0 || py >= bufH) continue;
    const rowLeft = hasLeft ? at(leftX, py) : -1;
    const rowRight = hasRight ? at(rightX, py) : -1;
    const dTop = j + 1;
    const dBottom = h - j;

    for (let i = 0; i < w; i++) {
      const px = fx + i;
      if (px < 0 || px >= bufW) continue;
      const dLeft = i + 1;
      const dRight = w - i;

      let weight = 0;
      let r = 0, g = 0, b = 0;

      if (rowLeft >= 0) {
        const wt = 1 / dLeft;
        weight += wt;
        r += data[rowLeft] * wt; g += data[rowLeft + 1] * wt; b += data[rowLeft + 2] * wt;
      }
      if (rowRight >= 0) {
        const wt = 1 / dRight;
        weight += wt;
        r += data[rowRight] * wt; g += data[rowRight + 1] * wt; b += data[rowRight + 2] * wt;
      }
      if (hasTop) {
        const idx = at(px, topY);
        const wt = 1 / dTop;
        weight += wt;
        r += data[idx] * wt; g += data[idx + 1] * wt; b += data[idx + 2] * wt;
      }
      if (hasBottom) {
        const idx = at(px, botY);
        const wt = 1 / dBottom;
        weight += wt;
        r += data[idx] * wt; g += data[idx + 1] * wt; b += data[idx + 2] * wt;
      }

      if (weight === 0) continue;
      const target = at(px, py);
      data[target] = r / weight;
      data[target + 1] = g / weight;
      data[target + 2] = b / weight;
      data[target + 3] = 255;
    }
  }
}

/**
 * Inpaints a rectangle of a canvas, reading a one pixel border of clean donor
 * pixels around it. Coordinates are in canvas pixels.
 */
export function inpaintCanvasRegion(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  canvasWidth: number,
  canvasHeight: number
): void {
  const rx = Math.max(0, Math.round(x));
  const ry = Math.max(0, Math.round(y));
  const rw = Math.min(canvasWidth - rx, Math.round(width));
  const rh = Math.min(canvasHeight - ry, Math.round(height));
  if (rw <= 0 || rh <= 0) return;

  // Read the region plus a one pixel border of clean donor pixels.
  const readX = Math.max(0, rx - 1);
  const readY = Math.max(0, ry - 1);
  const readW = Math.min(canvasWidth - readX, rw + (rx - readX) + 1);
  const readH = Math.min(canvasHeight - readY, rh + (ry - readY) + 1);
  if (readW <= 0 || readH <= 0) return;

  const imageData = ctx.getImageData(readX, readY, readW, readH);
  inpaintRegion(imageData.data, readW, readH, rx - readX, ry - readY, rw, rh);
  ctx.putImageData(imageData, readX, readY);
}
