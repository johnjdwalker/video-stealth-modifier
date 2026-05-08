# Video Stealth Modifier

A web application for subtly modifying videos with AI-powered suggestions. Adjust visual properties, speed, audio, and apply effects to your videos directly in the browser.

## Features

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
