# Quick Start Guide - Sora2 Watermark Remover

## Get Started in 3 Minutes

### Step 1: Install & Run (1 minute)

```bash
# Install dependencies
npm install

# Run the application
npm run dev

# Open your browser to http://localhost:5173
```

### Step 2: Upload Your Video (30 seconds)

1. Click the upload area or drag-drop your Sora2 video
2. Wait for preview to load
3. Observe where watermarks appear

### Step 3: Remove Watermark (1 minute)

#### Option A: Use AI (Easiest)

1. Scroll to "AI Suggestions" section
2. Type: "remove watermark from bottom right corner" (or wherever it appears)
3. Click "Suggest Settings with AI"
4. Review the suggested settings
5. Click "Apply Modifications & Prepare Download"

#### Option B: Manual Removal (More Control)

**For Bottom-Right Watermark:**
```
1. Scroll to "🎯 Watermark Removal" section
2. Set Crop Bottom: 8%
3. Set Crop Right: 10%
4. Click "Apply Modifications & Prepare Download"
```

**For Corner Watermarks:**
```
1. Scroll to "🎯 Watermark Removal" section
2. Set Corner Blur Size: 18%
3. Set Blur Bottom-Right: 12px (or whichever corner)
4. Click "Apply Modifications & Prepare Download"
```

**For Stubborn Watermarks (Combine Techniques):**
```
1. Crop Bottom: 5%
2. Crop Right: 5%
3. Zoom Scale: 1.15x
4. Blur Bottom-Right: 10px
5. Corner Blur Size: 20%
6. Click "Apply Modifications & Prepare Download"
```

### Step 4: Download (30 seconds)

1. Wait for processing to complete (progress bar shows status)
2. Click "Download Modified Video" when ready
3. Your watermark-free video downloads as WebM format

## Common Watermark Locations & Solutions

| Watermark Location | Quick Solution |
|-------------------|----------------|
| Bottom-Right | Crop Bottom: 8%, Crop Right: 10% |
| Bottom-Left | Crop Bottom: 8%, Crop Left: 10% |
| Top-Right | Crop Top: 8%, Crop Right: 10% |
| Top-Left | Crop Top: 8%, Crop Left: 10% |
| All Corners | Use Corner Blur: 15px on all corners |
| Bottom Center | Crop Bottom: 10%, Zoom: 1.1x |
| Subtle/Transparent | Brightness: 108%, Pixel Noise: On |

## Pro Tips

💡 **Preview First**: Use the side-by-side preview to see changes before processing

💡 **Start Small**: Begin with 5% crop and increase if needed

💡 **Combine Methods**: Crop + Zoom + Blur = Most effective

💡 **Use AI**: Great starting point, then fine-tune manually

💡 **Settings Saved**: Your last settings are saved automatically

## Troubleshooting

**Q: Blur not showing in preview?**  
A: Blur only appears in final processed video, not live preview

**Q: Too much video cropped?**  
A: Reduce crop percentages or increase zoom to compensate

**Q: Processing takes too long?**  
A: Normal for large videos. Wait for completion or use shorter clip

**Q: Output file won't play?**  
A: WebM format. Use VLC or convert to MP4 if needed

## Example Workflow

```
1. Upload video with watermark in bottom-right
2. Try AI: "remove bottom right watermark"
3. Preview the suggested changes
4. Fine-tune: Increase Crop Right to 12%
5. Process video
6. Download and verify
7. If needed, adjust settings and reprocess
```

## Keyboard Shortcuts

- **Spacebar**: Play/Pause preview videos
- **Tab**: Navigate between controls
- **Arrow Keys**: Adjust slider values when focused

## Next Steps

- Read [README.md](README.md) for complete documentation
- See [WATERMARK_REMOVAL_GUIDE.md](WATERMARK_REMOVAL_GUIDE.md) for advanced techniques
- Check [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) for technical details

## Need Help?

Common issues and solutions are in README.md under "Troubleshooting"

---

**You're ready to remove watermarks! 🎉**

Remember: This tool is for educational and creative purposes. Respect copyright and watermark policies.
