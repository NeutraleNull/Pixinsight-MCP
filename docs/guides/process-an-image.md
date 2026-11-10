# Process an image

This article shows how to get reliable results from the tools: how to look at an image, measure it, try settings safely, use masks, and write files. The examples show the tool calls, because they are what the assistant does on your behalf. You usually just describe what you want.

## Prerequisites

- A running server. See the [quickstart](../quickstart.md).
- An open image.

## Open an image

```json
{ "path": "/data/IC1871/master_Ha.xisf", "id": "Ha" }
```

[`open_image`](../reference/tools.md#open_image) opens a copy that keeps the FITS keywords, properties, and astrometric solution of the file, but has no file path. A plain **Save** in PixInsight therefore cannot overwrite your master.

Masters from WeightedBatchPreprocessing can contain extra images such as a crop mask. Only the first image is kept. To keep them all, set `allImages`.

## Tell the assistant about your equipment

Several steps depend on the camera, the telescope, and the filters: a flux calibration needs the bandwidth of a narrowband filter, and a color calibration the curves of the RGB filters. The assistant reads what a file says with [`get_image_metadata`](../reference/tools.md#get_image_metadata), and asks you for the rest before it starts.

```json
{ "view": "Ha", "search": "filt" }
```

A capture program often writes only the name of the filter slot, such as `H`. The make and the bandwidth are then nowhere in the file.

To answer these questions once and for all, write your equipment down as a guide of your own:

1. Create a folder for your guides, with a folder `practices` in it.
2. Save a file `equipment.md` there. The ID `practices/equipment` makes it take the place of the guide that tells the assistant to ask:

   ```markdown
   ---
   title: The equipment of this user
   summary: Camera, telescope and filters of this user. Read this first, and ask only for what it does not say.
   ---

   - Camera: mono, 3.76 µm pixels, cooled to -10 °C, gain 100, offset 50.
   - Telescope: 80 mm refractor, 480 mm focal length.
   - Narrowband filters: Hα, OIII and SII with 3 nm bandwidth.
   - Broadband filters: L, R, G and B.
   - Frames are dithered every third exposure. Flats are taken with a panel after each night.

   Ask for whatever a step needs and this list does not say.
   ```

   Add the maker and the series of each set of filters: a color calibration looks up their curves by that name.

3. Name the folder in [`PIXINSIGHT_MCP_GUIDE_DIRS`](../reference/configuration.md), and restart your assistant. Later changes to the file apply at once.

The format of the file is in the [processing library reference](../reference/processing-library.md).

## Look at an image

[`get_preview`](../reference/tools.md#get_preview) returns a JPEG and leaves the image, its history, and its display in PixInsight untouched.

```json
{ "view": "Ha", "maxSize": 1600 }
```

To inspect details, request a region. A crop that fits into `maxSize` is shown at full resolution:

```json
{ "view": "Ha", "crop": { "x0": 2400, "y0": 1500, "x1": 3200, "y1": 2100 } }
```

### Compare images fairly

By default, each preview gets its own automatic stretch. That makes linear data visible, but two images can then look different even when they are not. Use the same stretch to compare them:

```json
{ "view": "Ha_corrected", "stretchFrom": "Ha" }
```

Each response also returns the stretch it used in `stf`. Pass it back to apply exactly the same one later:

```json
{ "view": "Ha_corrected", "stf": [[0.0013, 0.0197, 1, 0, 1], [0.0013, 0.0197, 1, 0, 1], [0.0013, 0.0197, 1, 0, 1], [0.5, 0, 1, 0, 1]] }
```

> [!TIP]
> For RGB images, set `linked` to compute one stretch for all channels. It keeps the color balance visible, while the default stretches each channel on its own.

### Look at star layers

An image that is almost entirely black, such as a star layer, has no background for the usual automatic stretch to go by. For such an image, `get_preview` chooses the stretch from the brightest pixels instead, and the response says `"stretch": "auto sparse"`. That shows the stars as they are. It hides faint residues, so pass a stronger `stf` to look for those.

## Measure instead of guessing

[`get_image_stats`](../reference/tools.md#get_image_stats) reports minimum, maximum, mean, median, and MAD per channel, and takes no intermediate images. Use a region to measure a patch of empty sky:

```json
{ "view": "SHO", "rect": { "x0": 100, "y0": 900, "x1": 400, "y1": 1200 } }
```

To check for clipping, ask for the fraction of samples beyond a limit:

```json
{ "view": "SHO", "clipping": { "low": 0.001, "high": 0.99 } }
```

Response, shortened to one channel:

```json
{
  "view": "SHO",
  "channels": [
    { "channel": 0, "min": 0.02, "max": 0.87, "mean": 0.14, "median": 0.09, "mad": 0.004, "fractionBelowLow": 0, "fractionAboveHigh": 0.00007 }
  ]
}
```

## Find the right parameters

[`describe_process`](../reference/tools.md#describe_process) lists the parameters of a process with their types and defaults, as your installation reports them.

Parameters with `"enum": true` take the **name** of a constant from the list of the process, never a number. That list covers the whole process, so not every name fits every parameter. The server refuses names that do not.

```json
{ "processId": "AutomaticBackgroundExtractor", "view": "Ha", "params": { "targetCorrection": "Correction_Subtract" } }
```

## Try settings

Trying settings on a small region takes seconds instead of a minute, and leaves the main image untouched. Choose the place by what you want to try.

| You want to try | Use | Because |
|---|---|---|
| One step | A preview | Each run starts again from the main image, so you can compare settings directly |
| A chain of steps | A copy of a region | Steps add up, as they will on the real image |
| A plugin that makes new images, such as a star layer | A copy of a region | On a preview of a plate-solved image, StarXTerminator opens an error dialog in PixInsight |

> [!WARNING]
> Steps on a preview do not add up. Running noise reduction and then sharpening on a preview sharpens the image without noise reduction, so the result says little about the real chain.

### Try one step on a preview

1. Create the preview:

   ```json
   { "view": "Ha", "rect": { "x0": 2400, "y0": 500, "x1": 3400, "y1": 1300 }, "id": "test" }
   ```

2. Run the process on its full ID, `Ha->test`:

   ```json
   { "processId": "NoiseXTerminator", "view": "Ha->test", "params": { "denoise": 0.75, "detail": 0.15 } }
   ```

3. Look at the result, and run it again with other values if you want to.

4. When you are satisfied, run the process on `Ha` and [delete the preview](../reference/tools.md#delete_preview).

### Try a chain on a copy

1. Copy a region:

   ```json
   { "view": "Ha", "rect": { "x0": 2400, "y0": 500, "x1": 3400, "y1": 1300 }, "id": "Ha_try" }
   ```

2. Run each step on `Ha_try`.

3. When you are satisfied, run the steps on `Ha`, and [close the copy](../reference/tools.md#close_image).

## Use a mask

To apply a process through a mask, name the mask image in `mask`. It applies to this run only.

```json
{
  "processId": "LocalHistogramEqualization",
  "view": "SHO",
  "params": { "radius": 128, "slopeLimit": 1.6, "amount": 0.35 },
  "mask": { "view": "nebula_mask" }
}
```

The mask must have the same dimensions as the image. White areas of a mask let the process through. To protect them instead, set `"inverted": true`.

Any mask the image already had is restored after the run.

> [!WARNING]
> PixInsight stores the active mask in the image history and brings it back on undo. The [`undo`](../reference/tools.md#undo) tool prevents that, but the undo button in PixInsight does not. If you undo a masked step there, check whether a mask is still active before you continue.

## Copy an image

Use [`duplicate_image`](../reference/tools.md#duplicate_image) to keep the FITS keywords and the astrometric solution.

```json
{ "view": "Ha", "id": "Ha_backup" }
```

> [!NOTE]
> A copy made with PixelMath (`createNewImage`) loses all of this metadata, and so does every image derived from it. If your final image should stay plate-solved, build it from duplicates.

## Crop an image

Run `Crop` on a duplicate, with negative margins. It keeps every pixel as it is.

```json
{ "processId": "Crop", "view": "SHO_portrait", "params": { "mode": "AbsolutePixels", "leftMargin": -1790, "rightMargin": -797 } }
```

If the image has an astrometric solution that cannot be transformed, the response has `astrometryRemoved: true`. That also applies to `DynamicCrop`, `FastRotation`, `Rotation`, `Resample`, and `IntegerResample`. [Undo](../reference/tools.md#undo) brings the solution back. Keep an uncropped file if you want to stay plate-solved.

## Save and export

These two tools look similar, but they do different things.

| | `save_image` | `export_image` |
|---|---|---|
| Use it for | Your working file | A file for other programs or for sharing |
| Formats | XISF, FITS, TIFF | Everything PixInsight can write |
| Quality and bit depth | Those of the image | You choose |
| Afterwards, the image in PixInsight | Points to the new file and counts as saved | Stays exactly as it was |

To export a final JPEG and a 16-bit TIFF:

```json
{ "view": "SHO_final", "path": "/data/IC1871/final.jpg", "quality": 95 }
```

```json
{ "view": "SHO_final", "path": "/data/IC1871/final.tif", "bitsPerSample": 16 }
```

Both tools refuse to replace an existing file unless you set `overwrite`.

## Next steps

- [Handle dialogs, long jobs, and crashes](dialogs-jobs-crashes.md)
- [Tool reference](../reference/tools.md)
