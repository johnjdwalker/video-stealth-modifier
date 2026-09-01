# Video Stealth Modifier

A web application for subtly modifying videos with AI-powered suggestions. Adjust visual properties, speed, audio, and apply effects to your videos directly in the browser.

## Features

- 🪄 **Sora 2 watermark remover**: dedicated tool for the white logo produced by
  Sora 2 / ChatGPT video. See [Sora watermark removal](#sora-watermark-removal)
  below.
- 🎨 **Visual Adjustments**: Brightness, contrast, saturation, hue rotation
- 🖼️ **Stylistic Filters**: Blur, sepia, grayscale, vignette
- ⚡ **Playback Speed**: Adjust video speed (0.5x - 2.0x) with optional pitch preservation
- 🔊 **Audio Control**: Volume, audio fade-in/fade-out
- ✂️ **Trim**: Choose start and end times to keep a portion of the video
- 🔄 **Effects**: Horizontal flip, rotating lines, pixel noise
- 🎛️ **Presets**: Built-in (subtle, vintage, dramatic, cinematic, energetic, noir, dreamy)
  and your own user-defined presets saved to localStorage
- 🤖 **AI Suggestions**: Get AI-powered settings recommendations via Gemini
- 👀 **Live Preview**: Side-by-side comparison of original vs modified video
- 📥 **Easy Upload**: Click, drag-and-drop, or paste a video from the clipboard
- 💾 **Export**: Download modified videos in WEBM (VP8 / VP9) — or MP4 (H.264) on
  browsers that allow it — with selectable bitrate

## Sora watermark removal

The Sora watermark holds one position for a while, fades, and reappears
somewhere else. The remover models it that way — as a set of **dwells** rather
than one continuously moving path — and works in four steps.

### 1. Detect

Frames are sampled across the clip and scored for the watermark. Detection
keys on two signals:

- **Local contrast (white top-hat).** The watermark is a small bright mark laid
  *on top of* the picture. Subtracting a local mean leaves it standing out
  while the interior of any large bright region — an overcast sky, a wall, a
  white phone screen — collapses to roughly nothing. Plain brightness cannot
  tell those apart; this can.
- **Persistence.** The watermark holds a position for seconds while the content
  behind it changes. Transient bright things fail this and are dropped.

On top of those, Sora-specific priors are applied: the mark is small, much
wider than tall (icon + wordmark), and hugs a frame edge. The icon and the
letters are joined by a horizontal morphological closing before connected
components, so `S o r a` is found as one mark rather than four blobs.

### 2. Correct by clicking (optional)

If the amber tracking box is not on the watermark, turn on **Click-to-fix** and
click the watermark in the video. The click snaps to the mark under the cursor
and overrides the tracked position for that stretch of the clip; the video
pauses so the result can be checked against the frame. Corrections are listed
with their timestamps and can be removed individually.

The timeline strip under the players shows where the watermark sits over the
duration — detected stretches in indigo, your corrections in green — and can be
clicked to seek.

### 3. Choose the fill

| Method | What it does | Best for |
| --- | --- | --- |
| **Auto** | Borrows real pixels when a clean donor frame exists, inpaints otherwise | Default |
| **Borrow from frame** | Takes pixels from a moment when the watermark was elsewhere | Still backgrounds — sharpest result |
| **Inpaint edges** | Rebuilds from the pixels bordering the region | Moving scenes — never ghosts, but softer |

**Preview the fill on the current frame** renders a single before/after crop so
the methods can be compared without waiting for a full re-encode.

### 4. Remove and export

The clip is re-encoded at high bitrate, preferring MP4/H.264 where the browser's
`MediaRecorder` allows it and falling back to WEBM (VP9, then VP8). Where
`requestVideoFrameCallback` is available, the canvas is driven from decoded
frames and each one is pushed explicitly, so the source frame rate is preserved
rather than being resampled to a fixed 30fps.

Note that this path re-encodes through a canvas, so it is lossy by nature — the
bitrate is set high to keep the loss small, not to avoid it.

## Browser Requirements

This app requires a modern browser with support for:
- MediaRecorder API
- AudioContext API
- Canvas captureStream API
- ES2020+ JavaScript features

**Recommended browsers:**
- Chrome 94+
- Firefox 90+
- Edge 94+
- Safari 16.4+

## Run Locally

### Prerequisites
- Node.js (v18 or higher recommended)
- A modern web browser (see Browser Requirements above)

### Setup Instructions

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up Gemini API key (Optional - for AI features):**
   
   a. Copy the example environment file:
   ```bash
   cp .env.local.example .env.local
   ```
   
   b. Get your Gemini API key from: https://aistudio.google.com/app/apikey
   
   c. Open `.env.local` and replace `your_gemini_api_key_here` with your actual API key:
   ```
   GEMINI_API_KEY=your_actual_api_key_here
   ```
   
   **Note:** The app works without an API key, but AI suggestions will be disabled.

3. **Run the app:**
   ```bash
   npm run dev
   ```

4. **Open in browser:**
   Navigate to `http://localhost:5173` (or the URL shown in terminal)

## Usage

1. **Upload Video**: Click, drag-and-drop, or paste a video from the clipboard
   (max 500MB)
2. **Adjust Settings**: Use sliders and toggles to tune visuals, audio, effects,
   trim, and output format
3. **Apply a preset**: Click *Presets* to apply a built-in look or save the
   current configuration as your own preset
4. **Preview Changes**: View original and modified video side-by-side
5. **AI Suggestions** (Optional): Describe desired changes and get AI recommendations
6. **Process Video**: Apply modifications and prepare for download
7. **Download**: Save the modified video to your device

### Keyboard Shortcuts

| Action          | Shortcut             |
| --------------- | -------------------- |
| Upload video    | `Ctrl/Cmd + U`       |
| Process video   | `Ctrl/Cmd + P`       |
| Download result | `Ctrl/Cmd + D`       |
| Cancel          | `Esc`                |

Shortcuts are ignored while you are typing in a text field, so they never
interfere with the AI prompt or the preset name input.

## File Limitations

- **Maximum file size**: 500MB
- **Supported input formats**: MP4, WEBM, MOV, AVI, MKV, OGG
- **Output formats**:
  - WEBM (VP8 + Opus) — works in all supported browsers
  - WEBM (VP9 + Opus) — Chrome / Firefox / Edge
  - MP4 (H.264 + AAC) — only when the browser's `MediaRecorder` allows it
    (e.g. recent Safari builds). The selector disables unsupported entries.

## Troubleshooting

### Video won't upload
- Check file size (must be under 500MB)
- Verify file format is a supported video type
- Try a different video file

### Browser compatibility error
- Update your browser to the latest version
- Try a different browser (Chrome/Firefox recommended)
- Check that your browser supports MediaRecorder API

### Processing fails or crashes
- Try a smaller video file
- Close other browser tabs to free up memory
- Disable pixel noise or rotating lines effects
- Clear browser cache and reload

### AI suggestions not working
- Verify `GEMINI_API_KEY` is set in `.env.local`
- Check API key is valid at https://aistudio.google.com
- The app will still work without AI features

## Development

### Tests
```bash
npm test
```
Covers the pure logic behind watermark removal: detection against synthetic
frames that reproduce the known false positives (bright sky, white phone UI,
transient white chips), dwell clustering, correction/timeline resolution, the
letterbox coordinate mapping, and the inpainting fill. These are plain Node
scripts that exit non-zero on failure — no test framework needed.

### Type checking
```bash
npm run typecheck
```
The project uses TypeScript in `strict` mode. `npm run build` runs the type
checker before bundling, so a type error fails the build rather than shipping.

### Build for production
```bash
npm run build
```

### Preview production build
```bash
npm run preview
```

## Security Notes

- API keys are exposed in client-side code (consider using a backend proxy for production)
- All video processing happens locally in the browser
- No video data is uploaded to external servers
- LocalStorage is used to persist settings between sessions

## License

For educational and creative purposes.
