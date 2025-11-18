# Watermark Removal Implementation Guide

## Overview

This application provides multiple techniques for removing watermarks from Sora2-generated videos. The implementation uses browser-based Canvas API processing, ensuring all work is done client-side without uploading videos anywhere.

## Implemented Techniques

### 1. Edge Cropping (Most Effective for Edge Watermarks)

**How it works**: Removes pixels from the edges of the video by cropping a percentage from each side.

**Controls**:
- Crop Top (0-50%)
- Crop Bottom (0-50%)
- Crop Left (0-50%)
- Crop Right (0-50%)

**Best for**: Watermarks positioned at the edges or corners of the video.

**Example**: If a watermark appears in the bottom-right corner:
```
Crop Bottom: 8%
Crop Right: 10%
```

### 2. Zoom & Scale (Effective for Small Edge Watermarks)

**How it works**: Scales up the video content after cropping, effectively zooming in to hide edge watermarks while maintaining center focus.

**Controls**:
- Zoom Scale (1.0-2.0x)

**Best for**: Small watermarks near edges that don't take up much space.

**Example**: 
```
Crop Bottom: 5%
Zoom Scale: 1.15x
```

### 3. Corner Blur (Best for Corner Watermarks You Can't Crop)

**How it works**: Applies a Gaussian blur filter to specific corner regions, making watermarks illegible while keeping the main content clear.

**Controls**:
- Corner Blur Size (5-30%) - Size of the area to blur
- Blur Top-Left (0-20px) - Intensity
- Blur Top-Right (0-20px) - Intensity
- Blur Bottom-Left (0-20px) - Intensity
- Blur Bottom-Right (0-20px) - Intensity

**Best for**: Corner watermarks where cropping would remove too much content.

**Example**: For a watermark in bottom-right:
```
Corner Blur Size: 18%
Blur Bottom-Right: 12px
```

### 4. Visual Adjustments (For Semi-Transparent Watermarks)

**How it works**: Modifies brightness, contrast, and saturation to make watermarks less visible.

**Controls**:
- Brightness (0-200%)
- Contrast (0-200%)
- Saturation (0-200%)

**Best for**: Semi-transparent or low-contrast watermarks.

**Example**:
```
Brightness: 110%
Contrast: 115%
```

### 5. Obfuscation Effects (For Distributed Watermarks)

**How it works**: Adds visual noise or patterns to make watermarks harder to detect.

**Controls**:
- Pixel Noise (On/Off) - Adds random pixel variations
- Rotating Lines (On/Off) - Adds animated lines
- Flip Horizontal (On/Off) - Mirrors the video

**Best for**: Watermarks embedded throughout the video or when other techniques aren't enough.

## Combination Strategies

### Strategy 1: Simple Corner Watermark
```
Crop Bottom: 7%
Crop Right: 8%
```

### Strategy 2: Stubborn Corner Watermark
```
Crop Bottom: 5%
Crop Right: 5%
Zoom Scale: 1.2x
Blur Bottom-Right: 10px
Corner Blur Size: 20%
```

### Strategy 3: Semi-Transparent Watermark
```
Brightness: 108%
Contrast: 112%
Pixel Noise: On
Crop Bottom: 3%
```

### Strategy 4: Center or Distributed Watermark
```
Brightness: 105%
Contrast: 110%
Pixel Noise: On
Rotating Lines: On (optional)
```

## AI-Powered Suggestions

The application includes Gemini AI integration that can analyze your description and suggest optimal settings.

**Usage**:
1. Describe the watermark: "watermark in bottom right corner, white text"
2. Click "Suggest Settings with AI"
3. Review suggested settings
4. Fine-tune as needed

**AI prompts examples**:
- "remove watermark from bottom right corner"
- "subtle watermark in top left needs blur"
- "semi-transparent text across bottom"
- "logo in all four corners"

## Technical Implementation

### Video Processing Pipeline

1. **Video Loading**: Original video loaded into HTML5 video element
2. **Canvas Rendering**: Video frames drawn to canvas at 30 FPS
3. **Filter Application**:
   - Crop calculation (removes edge pixels from source)
   - Zoom transform (scales canvas context)
   - Flip transform (horizontal mirror)
   - CSS filters (brightness, contrast, saturation)
   - Pixel noise overlay (random pixel insertion)
   - Rotating lines overlay (animated lines)
   - Corner blur (selective Gaussian blur)
4. **Audio Processing**: Web Audio API for volume control and pitch preservation
5. **Recording**: MediaRecorder API captures processed stream
6. **Output**: WebM file with VP8 video and Opus audio codecs

### Corner Blur Algorithm

```typescript
// 1. Calculate blur region size
const blurSize = (cornerBlurSize / 100) * min(width, height)

// 2. For each corner with blur > 0:
//    a. Extract corner region to temporary canvas
//    b. Apply blur filter
//    c. Draw blurred region back to main canvas
```

This approach ensures the blur only affects the corner regions while maintaining performance.

### Crop and Zoom Algorithm

```typescript
// 1. Calculate crop pixels
const cropLeftPx = (cropLeft / 100) * videoWidth
const cropRightPx = (cropRight / 100) * videoWidth
const cropTopPx = (cropTop / 100) * videoHeight
const cropBottomPx = (cropBottom / 100) * videoHeight

// 2. Calculate remaining video area
const sourceWidth = videoWidth - cropLeftPx - cropRightPx
const sourceHeight = videoHeight - cropTopPx - cropBottomPx

// 3. Apply zoom transform
ctx.scale(zoomScale, zoomScale)
ctx.translate(offsetX, offsetY)

// 4. Draw cropped region scaled to full canvas
ctx.drawImage(video, 
  cropLeftPx, cropTopPx, sourceWidth, sourceHeight,
  0, 0, canvasWidth, canvasHeight
)
```

## Performance Considerations

- **Processing Speed**: Real-time at 30 FPS for videos up to 1920x1080
- **Memory Usage**: Scales with video resolution and duration
- **Browser Compatibility**: Works in all modern browsers (Chrome, Firefox, Edge, Safari)
- **File Size**: Output WebM file size similar to input (varies with compression)

## Limitations

1. **Output Format**: Always WebM (VP8/Opus) - may need conversion for some platforms
2. **Blur Effectiveness**: Corner blur works best for small-to-medium watermarks
3. **Quality Loss**: Cropping reduces effective resolution
4. **Processing Time**: Large/long videos may take several minutes to process
5. **Browser Limits**: Very large videos (>500MB) may cause memory issues

## Tips for Best Results

1. **Start Conservative**: Begin with small crop/blur values and increase as needed
2. **Use Preview**: The side-by-side preview shows real-time effects (except blur/noise)
3. **Combine Techniques**: Multiple small adjustments often work better than one large change
4. **Check Before Processing**: Verify settings in preview before starting the full process
5. **Iterate**: Process, review, adjust, and reprocess if needed
6. **Save Settings**: Your settings are saved in browser localStorage for reuse

## Privacy & Security

- **All processing is local**: Videos never leave your browser
- **No server uploads**: The application runs entirely client-side
- **Settings storage**: Only saved in your browser's localStorage
- **No tracking**: No analytics or user data collection

## Future Enhancements (Potential)

- Content-aware fill for watermark areas
- Custom mask drawing for irregular watermark shapes
- Batch processing for multiple videos
- Additional output formats (MP4, MOV)
- Advanced AI-powered inpainting
- Timeline-based editing (remove watermarks from specific sections)

## Troubleshooting

**Problem**: Blur not visible in preview
**Solution**: Blur effects only apply during final processing, not in live preview

**Problem**: Video quality degraded
**Solution**: Reduce crop percentages and avoid excessive zoom (>1.3x)

**Problem**: Processing fails or freezes
**Solution**: Try a shorter video or lower resolution, ensure browser is up-to-date

**Problem**: Audio out of sync
**Solution**: Ensure "Preserve Audio Pitch" is enabled if changing playback speed

**Problem**: Output file too large
**Solution**: This is a limitation of WebM encoding; use external tools to compress

## Conclusion

This implementation provides a powerful, privacy-focused solution for removing watermarks from Sora2 videos using multiple complementary techniques. The combination of cropping, zooming, blurring, and visual adjustments can handle most watermark scenarios effectively.
