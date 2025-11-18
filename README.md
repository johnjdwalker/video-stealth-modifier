# Sora2 Watermark Remover

A powerful browser-based tool for removing watermarks from Sora2-generated videos using multiple techniques including cropping, zooming, corner blur, and visual adjustments.

## Features

### Watermark Removal Techniques

1. **Edge Cropping** - Remove watermarks from edges by cropping top, bottom, left, or right
2. **Zoom & Scale** - Zoom in to crop out edge watermarks while maintaining video quality
3. **Corner Blur** - Selectively blur corners where watermarks typically appear
4. **Visual Adjustments** - Modify brightness, contrast, and saturation to obscure watermarks
5. **Additional Effects** - Pixel noise, rotating lines, and flip horizontal for further modifications

### AI-Powered Suggestions

Use the built-in Gemini AI to get intelligent suggestions for watermark removal:
- Describe the watermark location (e.g., "watermark in bottom right corner")
- Get automatic settings recommendations
- Combines multiple techniques for optimal results

## Run Locally

**Prerequisites:** Node.js (v14 or higher)

1. Install dependencies:
   ```bash
   npm install
   ```

2. (Optional) Set the `GEMINI_API_KEY` environment variable to enable AI suggestions:
   ```bash
   export GEMINI_API_KEY=your_api_key_here
   ```
   Or create a `.env.local` file with:
   ```
   GEMINI_API_KEY=your_api_key_here
   ```

3. Run the app:
   ```bash
   npm run dev
   ```

4. Open your browser to the URL shown (typically http://localhost:5173)

## Usage Guide

### Basic Watermark Removal

1. **Upload Video** - Click or drag-drop your Sora2 video
2. **Identify Watermark Location** - Look at the preview to see where the watermark appears
3. **Apply Removal Techniques**:
   - For corner watermarks: Use corner blur controls
   - For edge watermarks: Use crop controls or zoom scale
   - For subtle watermarks: Adjust brightness, contrast, or add pixel noise
4. **Preview Changes** - Compare original vs modified in real-time
5. **Process & Download** - Generate the final watermark-free video

### Recommended Settings for Sora2 Watermarks

Sora2 watermarks typically appear in corners or bottom edges. Try these settings:

- **Bottom-right watermark**: 
  - Crop Bottom: 5-10%
  - Crop Right: 5-10%
  - Or: Blur Bottom-Right: 10-15px, Corner Blur Size: 20%

- **Top corners watermark**:
  - Blur Top-Left: 10px, Blur Top-Right: 10px
  - Corner Blur Size: 15-20%

- **Center/distributed watermark**:
  - Enable Pixel Noise
  - Adjust Brightness: 105-110%
  - Contrast: 105-110%

### AI-Powered Removal

1. Click the AI Suggestions section
2. Describe the watermark: "remove watermark from bottom right corner"
3. Click "Suggest Settings with AI"
4. Review and adjust the AI-recommended settings
5. Process the video

## Technical Details

- **Output Format**: WebM (VP8/Opus codec)
- **Processing**: Client-side using Canvas API and MediaRecorder
- **Quality**: Maintains original video resolution
- **Privacy**: All processing happens in your browser - no data uploaded

## Tips for Best Results

1. **Combine Techniques**: Use cropping + blur for stubborn watermarks
2. **Preview Before Processing**: Adjust settings while watching the preview
3. **Subtle Adjustments**: Small changes often work better than extreme values
4. **Multiple Attempts**: Try different combinations if first attempt isn't perfect
5. **AI Assistance**: Use AI suggestions as a starting point, then fine-tune

## Browser Compatibility

- Chrome/Edge: Full support
- Firefox: Full support
- Safari: Supported (may have codec limitations)

## Limitations

- Output is always WebM format (convert if needed for other platforms)
- Very large videos may take time to process
- Corner blur works best for small corner watermarks

## Disclaimer

This tool is for educational and creative purposes. Ensure you have the right to modify any videos you process. Respect copyright and watermark policies.
