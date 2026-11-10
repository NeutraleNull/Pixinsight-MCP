# Tool reference

This article lists all tools the server offers to an assistant, with their parameters and responses. For failures, see the [error reference](errors.md).

Most tools that work on an image or a file take an optional `waitMs`, the number of milliseconds to wait for the result, from 0 to 55000, with a default of 20000. If the job takes longer, the response is a [pending job](#pending-jobs).

Any response can end with a `notice`, as a separate text block, if the assistant must know something before trusting the result. For example, that the PixInsight instance has changed.

A tool that returns a list always has the list as its first text block. Console messages about it follow in a block of their own.

- **Connection:** [`get_status`](#get_status)
- **Processes:** [`list_processes`](#list_processes), [`describe_process`](#describe_process), [`run_process`](#run_process)
- **Images:** [`list_images`](#list_images), [`get_image_stats`](#get_image_stats), [`get_image_metadata`](#get_image_metadata), [`get_preview`](#get_preview), [`duplicate_image`](#duplicate_image)
- **Previews:** [`create_preview`](#create_preview), [`delete_preview`](#delete_preview)
- **History:** [`undo`](#undo), [`redo`](#redo)
- **Files:** [`open_image`](#open_image), [`save_image`](#save_image), [`export_image`](#export_image), [`close_image`](#close_image)
- **Preprocessing:** [`start_preprocessing`](#start_preprocessing)
- **Scripts and code:** [`list_scripts`](#list_scripts), [`start_script`](#start_script), [`get_script_dialog`](#get_script_dialog), [`use_script_dialog`](#use_script_dialog), [`run_code`](#run_code)
- **Jobs:** [`get_job`](#get_job), [`cancel_job`](#cancel_job)
- **Processing library:** [`get_guide`](#get_guide)

## Views

Most tools take a `view`: the identifier of an image, such as `M31`, or of a preview, written as `M31->core`.

## Regions

Regions are given in pixels as `{ "x0": 0, "y0": 0, "x1": 200, "y1": 200 }`, with the origin at the top left. They are clipped to the image.

---

## get_status

Shows the connection to PixInsight. It takes no parameters.

**Response**

```json
{
  "mode": "shared",
  "instances": [
    { "slot": 1, "pid": 1930908, "crashed": false },
    { "slot": 250, "pid": 1929686, "crashed": false, "role": "shadow" }
  ],
  "target": { "slot": 1, "pid": 1930908 },
  "pixinsight": { "version": "1.9.6", "revision": 0, "build": 1713, "codename": "Lockhart", "instance": 1, "automationMode": false, "v8": "14.3.127.18", "processes": 121, "scriptsDir": "/opt/PixInsight/src/scripts" },
  "queue": { "queued": 0, "active": null }
}
```

| Field | Description |
|---|---|
| `instances` | All PixInsight instances. `role` marks helper instances of this server and of other servers that use the same folder for job files. `null` on Windows, where they cannot be listed. |
| `target` | The instance jobs go to. |
| `pixinsight` | Details of the instance that answered. |
| `busy`, `waitingForInput` | PixInsight is working on an earlier job, or seems to wait for input in a dialog. |
| `problem` | What is wrong, if anything is. |
| `queue` | The number of waiting jobs, and the active job. |
| `preprocessing` | Present while a [preprocessing run](#start_preprocessing) of this session is under way: its `jobId`, `state`, `elapsedMs`, and the `step` it is at. |

---

## list_processes

Lists the installed processes, including third-party ones.

| Parameter | Type | Description |
|---|---|---|
| `search` | string | Part of the process name, ignoring case. |
| `category` | string | Exact category name, such as `IntensityTransformations`. |

**Response**

```json
[
  { "id": "PixelMath", "categories": ["PixelMath"], "canProcessViews": true, "canProcessGlobal": true, "parameters": 28 }
]
```

Blocked processes also have a `blocked` field with the reason.

---

## describe_process

Shows the parameters of a process, as your installation reports them.

| Parameter | Type | Description |
|---|---|---|
| `processId` **required** | string | The process name. |

**Response**

```json
{
  "id": "HistogramTransformation",
  "categories": ["IntensityTransformations"],
  "canProcessViews": true,
  "canProcessGlobal": true,
  "parameters": [
    {
      "id": "H",
      "type": "Array",
      "readOnly": false,
      "columns": ["c0", "m", "c1", "r0", "r1"],
      "default": [[0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1], [0, 0.5, 1, 0, 1]]
    }
  ],
  "constants": []
}
```

| Field | Description |
|---|---|
| `parameters[].type` | The data type: `int32`, `double`, `Boolean`, `String`, `Array`, and so on. |
| `parameters[].enum` | `true` if the parameter takes the name of a constant. |
| `parameters[].default` | The default value. For an enumeration, usually the name of its constant. |
| `parameters[].columns` | For a table, the columns in their real order. |
| `parameters[].readOnly` | `true` for outputs of the process. |
| `constants` | The names and values of all constants of the process, not per parameter. |

---

## run_process

Runs a process on a view, or globally. A change to an image goes into its history. Files that a batch process writes are not covered by that, so they cannot be undone.

| Parameter | Type | Description |
|---|---|---|
| `processId` **required** | string | The process name. |
| `view` | string | The target view. Either this or `global` is required. |
| `global` | boolean | Runs in the global context, for example to create images. |
| `params` | object | Parameter values. Anything not listed keeps its default. Enumerated parameters take the name of a constant. |
| `description` | string | A note shown in the history of the image. |
| `mask` | object | Applies the process through a mask for this run. See below. |
| `mask.view` **required** | string | A main view with the same dimensions as the target. |
| `mask.inverted` | boolean | Protects the bright areas of the mask instead of the dark ones. |
| `allowOverwrite` | boolean | Accepts that a process with overwrite settings replaces existing files. See [Processes](../concepts.md#processes). |
| `waitMs` | integer | See above. |

**Response**

```json
{
  "process": "PixelMath",
  "target": "M31",
  "seconds": 0.024,
  "applied": { "expression": "0.02+0.3*exp(-((X()-0.5)^2+(Y()-0.5)^2)/0.02)", "useSingleExpression": true, "createNewImage": false },
  "newViews": [],
  "outputs": {},
  "pixelsChanged": true,
  "stats": [{ "channel": 0, "min": 0.02, "max": 0.32, "mean": 0.0388, "median": 0.0201, "mad": 0.0001 }],
  "log": ["PixelMath: Processing view: M31", "Executing PixelMath expression:", "0.02+0.3*exp(...)", "combined RGB/K channels: done", "24.170 ms"]
}
```

| Field | Description |
|---|---|
| `seconds` | The run time of the process. |
| `applied` | The values the process really holds, read back after setting them. |
| `newViews` | Images the process created. |
| `outputs` | Simple output values the process has set. Many processes report computed results only in `log`. |
| `pixelsChanged` | Whether the pixels differ from where the process started, judged by statistics and by samples at fixed positions. Only for runs on a view. |
| `metadataChanged` | Present if FITS keywords or the list of properties changed. |
| `astrometryRemoved` | Present if the process deleted the astrometric solution of the image. Undo brings it back. |
| `previewsRemoved` | The number of previews the process deleted, if any. Undo brings them back. |
| `maskRemoved` | The mask the image had before, if the process removed it. Undo brings it back. |
| `activeMask` | Present if the image had a mask of its own, which was then in effect, with `view` and `inverted`. |
| `historyIndex` | The state of the history after this step. Pass it to [`undo`](#undo) to take back exactly this step. Only for runs on a view. |
| `startedFromMainImage` | Present for a run on a preview. See [`create_preview`](#create_preview). |
| `hint` | Present if nothing changed and there is no new image, because the process may have done nothing. |
| `warning` | Present if the mask of the image could not be restored afterwards. |
| `stats` | Statistics of the target afterwards, one entry per channel. Only for runs on a view. |
| `log` | The output of the process, often the only place for computed results. Of an output with more than 30 lines, the first 6 and the last 23, with a line between them that says how many were left out. |
| `console` | Lines of the log that look like errors or warnings. |

The job takes its place in the queue right away, and the server checks it when its turn comes. So a job sent right after this one runs after it, however long the check takes. A refused job ends with an [error](errors.md#requests). If the check takes longer than `waitMs`, the response is a [pending job](#pending-jobs).

Enumerated values that are new to the server are first tried in the [shadow instance](../concepts.md#instances), which can add a few seconds.

`Crop`, `DynamicCrop`, `FastRotation`, `Rotation`, `Resample`, and `IntegerResample` would ask in a dialog before they delete what a change of geometry invalidates: an astrometric solution, the previews, and the mask. The server sets their `noGUIMessages` parameter to `true`, so they go ahead, and the response says what was lost. Undo brings all of it back. To get the question instead, pass `noGUIMessages: false`.

These six processes are refused with [`mask_in_use`](errors.md#requests) on an image that other images use as their mask, because the mask would be removed there, and undo does not bring that back.

If a process fails after it has created images, the error message names them.

---

## list_images

Lists the open images, on all workspaces. It takes no parameters.

**Response**

```json
[
  {
    "view": "M31",
    "active": true,
    "filePath": "",
    "modified": true,
    "unsaved": true,
    "visible": true,
    "iconic": false,
    "width": 1600,
    "height": 1200,
    "channels": 3,
    "color": true,
    "bitsPerSample": 32,
    "floatSample": true,
    "astrometry": false,
    "previews": ["M31->core"],
    "canUndo": true,
    "canRedo": false
  }
]
```

| Field | Description |
|---|---|
| `filePath` | The file a plain **Save** in PixInsight would write to. Empty for copies and new images. |
| `sourcePath` | The file this copy was opened from, if any. |
| `mask` | The active mask of the image, if any, with `view`, `enabled`, and `inverted`. |
| `unsaved` | Closing this image would lose work. Also `true` for new images that were never saved. |
| `modified` | PixInsight's own flag. It stays `false` for new images, so prefer `unsaved`. |
| `visible` | Also `false` for images on another workspace, so it does not mean hidden. |
| `channels` | Includes alpha channels. |

---

## get_image_stats

Reports statistics per channel, in the normalized range from 0 to 1.

| Parameter | Type | Description |
|---|---|---|
| `view` **required** | string | The view to measure. |
| `rect` | region | A part of the image. |
| `rects` | region[] | Several parts at once, instead of `rect`. The response then has one entry per part in `regions`, each with `rect` and `channels`. |
| `clipping.low` | number | Also reports the fraction of samples below this value. |
| `clipping.high` | number | Also reports the fraction of samples above this value. |
| `waitMs` | integer | See above. |

**Response**

```json
{
  "view": "M31",
  "width": 1600,
  "height": 1200,
  "color": true,
  "rect": { "x0": 0, "y0": 0, "x1": 200, "y1": 200 },
  "channels": [
    { "channel": 0, "min": 0.02, "max": 0.02, "mean": 0.02, "median": 0.02, "mad": 0.0000000037, "fractionBelowLow": 0, "fractionAboveHigh": 0 }
  ]
}
```

---

## get_image_metadata

Reads what the file of an open image says about how it was taken: its FITS keywords, and its properties. This is where the assistant finds the filter, the camera, exposure, gain and offset, the focal length, and the pixel size, if the capture program wrote them. What is not there, the assistant has to ask you.

| Parameter | Type | Description |
|---|---|---|
| `view` **required** | string | A view of the image. |
| `search` | string | A part of a keyword name or a property ID, in any case, such as `filt`. Only entries that match are returned. To read the lines of `HISTORY` and `COMMENT`, search for those names. |
| `waitMs` | integer | See above. |

**Response**

```json
{
  "view": "Ha",
  "keywords": [
    { "name": "BACKGRND", "value": 0.4, "comment": "MeasureBackground" }
  ],
  "properties": []
}
```

| Field | Description |
|---|---|
| `keywords[].name`, `keywords[].comment` | The name of the FITS keyword, and its comment if it has one. |
| `keywords[].value` | A number, `true` or `false`, or a text without its quotes, cut after 300 characters. |
| `properties[]` | The properties of the image that hold a number, a text, `true` or `false`, or a point in time, which comes as a text. Each with `id` and `value`. |
| `textLines` | Present without `search`: how many lines of `HISTORY` and `COMMENT` are left out. |
| `otherProperties` | Present if properties are left out because they hold more than one value, such as the solution of the astrometry. |
| `moreKeywords`, `moreProperties` | Present if more than 300 keywords or properties match: how many are left out. |

---

## get_preview

Returns a JPEG of a view, and leaves the image, its history, and its display untouched.

| Parameter | Type | Description |
|---|---|---|
| `view` **required** | string | The view to show. |
| `maxSize` | integer | The longest side in pixels, from 64 to 2048. Default 1024. |
| `crop` | region | Shows only this part of the view. |
| `stretch` | string | `auto` (default) makes linear data visible. `none` shows the actual pixel values. |
| `linked` | boolean | Computes one automatic stretch for all channels, which keeps the color balance. |
| `stretchFrom` | string | Uses the automatic stretch of this other view, for a fair comparison. |
| `stf` | number[][] | Applies exactly this stretch, as returned earlier in `stf`. |
| `waitMs` | integer | See above. |

Set only one of `stf`, `stretchFrom`, and `stretch`. More than one is refused with [`invalid_arguments`](errors.md#requests).

**Response:** an image block, followed by a text block:

```json
{
  "view": "M31",
  "sourceWidth": 1600,
  "sourceHeight": 1200,
  "crop": null,
  "width": 800,
  "height": 600,
  "stretch": "auto",
  "stf": [[0.00129, 0.01967, 1, 0, 1], [0.00129, 0.01967, 1, 0, 1], [0.00129, 0.01967, 1, 0, 1], [0.5, 0, 1, 0, 1]],
  "file": "/home/you/.local/state/mcp-server-for-pixinsight/jobs/90de5faa-95ee-4b68-9199-19808d34227a/preview.jpg"
}
```

| Field | Description |
|---|---|
| `file` | The same JPEG as a file, for a client that does not hand pictures to its model. The server keeps it until 100 more jobs have finished, or until it exits. |
| `stf` | The stretch that was applied. Pass it back to repeat it. Absent with `stretch: "none"`. |
| `stretch` | The stretch that was used: `auto`, `auto linked`, `auto sparse` for an almost empty image such as a star layer, `from <view>`, `fixed`, or `none`. |
| `note` | Present with `auto sparse`: the stretch follows the brightest pixels, which shows stars and hides faint residues. |

The JPEG has no color management. The colors can look slightly different from PixInsight.

---

## duplicate_image

Copies a view to a new image, with its FITS keywords, properties, RGB working space, and astrometric solution.

| Parameter | Type | Description |
|---|---|---|
| `view` **required** | string | The view to copy. A preview becomes an image of its own. |
| `id` | string | The identifier of the new image. |
| `rect` | region | Copies only this part of the view. Use it to try a chain of steps, or a plugin that makes new images. |
| `waitMs` | integer | See above. |

**Response**

```json
{ "view": "Ha_copy", "source": "Ha", "width": 5743, "height": 3945, "keywords": 40, "properties": 102, "skippedProperties": [], "astrometry": true }
```

The new image becomes the active window in PixInsight.

A preview or a part of an image comes without the astrometric solution and the keywords that describe the position in the sky, because those belong to the whole image. ICC profiles and the history are not copied.

---

## create_preview

Creates a preview: a region of an image, to see what one step does there.

Each run on a preview starts again from the main image, so steps do not add up, and `undo` returns to the state of the main image. To try a chain of steps, or a plugin that makes new images, use [`duplicate_image`](#duplicate_image) with `rect`. See [Try settings](../guides/process-an-image.md#try-settings).

| Parameter | Type | Description |
|---|---|---|
| `view` **required** | string | The image to create the preview in. |
| `rect` **required** | region | The region of the image. |
| `id` | string | The identifier of the preview. |

**Response**

```json
{ "view": "M31->core", "rect": { "x0": 600, "y0": 400, "x1": 1000, "y1": 800 }, "width": 400, "height": 400 }
```

---

## delete_preview

Deletes a preview and its history. The main image stays untouched.

| Parameter | Type | Description |
|---|---|---|
| `view` **required** | string | The full ID of the preview, such as `M31->core`. |

---

## undo

Undoes the last processing steps of an image or preview. An active mask stays as it was, while PixInsight's own undo would restore the mask of the earlier state.

| Parameter | Type | Description |
|---|---|---|
| `view` **required** | string | The image or preview. |
| `count` | integer | The number of steps. Default 1. |
| `historyIndex` | integer | The `historyIndex` that the [`run_process`](#run_process) response of your own step reported. The call is then refused with [`history_changed`](errors.md#history-and-images) if the history has moved since, for example by a step you made in PixInsight. |

**Response**

```json
{ "view": "M31", "historyIndex": 0, "canUndo": false, "canRedo": true }
```

The response has a `warning` if the mask of the image no longer fits, because a crop in the history changed the size of the image. The step has been undone in that case, and the image has no mask. Do not repeat the call.

---

## redo

Redoes processing steps that were undone. Takes the same parameters as [`undo`](#undo), and returns the same response.

---

## open_image

Opens an image file without any format dialogs. By default, it opens a copy with all metadata but without a file path, so that a plain **Save** in PixInsight cannot overwrite the source. Only the first image of a file is kept.

| Parameter | Type | Description |
|---|---|---|
| `path` **required** | string | The absolute path of the file. |
| `id` | string | The identifier of the new image. |
| `allImages` | boolean | Keeps all images of the file. |
| `editOriginal` | boolean | Opens the file itself instead of a copy. A later **Save** overwrites it. |
| `waitMs` | integer | See above. |

**Response**

```json
{
  "views": [{ "view": "Ha", "width": 5743, "height": 3945, "channels": 1, "astrometry": true, "keywords": 40 }],
  "sourcePath": "/data/IC1871/master_Ha.xisf",
  "protectsSource": true,
  "closedExtras": ["Ha_crop_mask"]
}
```

`closedExtras` lists the other images of the file, which were not kept. `skippedProperties` lists properties PixInsight did not allow on the copy. ICC profiles are not carried over to the copy.

---

## save_image

Saves a working image without dialogs, and makes the file the path of the image in PixInsight. It creates the folder if needed.

| Parameter | Type | Description |
|---|---|---|
| `view` **required** | string | A main view. |
| `path` **required** | string | The absolute path of the target. Must end in `.xisf`, `.fits`, `.fit`, `.fts`, `.tif`, or `.tiff`. |
| `overwrite` | boolean | Replaces an existing file. The old file stays in place until the new one is written. |
| `waitMs` | integer | See above. |

The file an image was opened from is never replaced, also not with `overwrite`: the call ends with [`protected_source`](errors.md#files). To change such a file on purpose, open it with `editOriginal`.

**Response**

```json
{ "view": "SHO", "path": "/data/IC1871/sho.xisf", "keywords": 40, "properties": 90, "astrometry": true }
```

| Field | Description |
|---|---|
| `keywords`, `properties`, `astrometry` | What the file really holds, read back after writing it. A FITS file counts its structural keywords too. |
| `previousPath` | The file the image belonged to before, if it was another one. |
| `createdFolder` | The folder, if the tool had to create it. |

---

## export_image

Writes a view to a file in any format PixInsight supports. The image in PixInsight stays exactly as it was. The server writes a temporary file next to the target and replaces the target only when the new file is complete, so a failure keeps the old file.

| Parameter | Type | Description |
|---|---|---|
| `view` **required** | string | The view to write. |
| `path` **required** | string | The absolute path of the target. The extension selects the format. |
| `quality` | integer | The JPEG quality, from 1 to 100. |
| `bitsPerSample` | integer | `8`, `16`, `32`, or `64`. Default: 8 for JPEG, otherwise that of the image. |
| `floatSample` | boolean | Stores floating point samples. Only with 32 or 64 bits. Default: `true` with 64 bits, and with 32 bits what the image has. |
| `overwrite` | boolean | Replaces an existing file. |
| `waitMs` | integer | See above. |

Like `save_image`, it creates the folder if needed, reports it in `createdFolder`, and never replaces the file an image was opened from.

**Response**

```json
{ "view": "M31", "path": "/data/M31.jpg", "bytes": 33146, "bitsPerSample": 8, "floatSample": false, "quality": 95, "keywords": 0, "properties": 0, "astrometry": false, "lossy": true, "filePathOfWindow": "" }
```

| Field | Description |
|---|---|
| `keywords`, `properties`, `astrometry` | What the file really holds, read back after writing it. JPEG and TIFF keep next to nothing. |
| `lossy` | Whether the format lost information. |
| `filePathOfWindow` | The unchanged path of the image in PixInsight. |

---

## close_image

Closes one image or several. It refuses if one of them holds unsaved work, and then closes none.

| Parameter | Type | Description |
|---|---|---|
| `view` **required** | string or string[] | A main view, or a list of them. |
| `discardChanges` | boolean or string[] | Closes an image even with unsaved work, which is then lost for good. `true` for a single image. With a list of images, the IDs of those whose unsaved work may be lost. |

With a list, `true` is not accepted: it would also discard work the assistant knows nothing about, such as a change you made in the meantime.

**Response**

```json
{ "closed": ["M31", "M31_copy"], "discarded": ["M31_copy"], "closedPreviews": 2, "removedAsMaskFrom": ["Ha"] }
```

| Field | Description |
|---|---|
| `closed` | The images that were closed. |
| `discarded` | Those of them that held unsaved work, if any. |
| `closedPreviews` | The number of previews that were closed with the image, if any. |
| `removedAsMaskFrom` | Images that used this one as their mask, and no longer have one, if any. |

---

## start_preprocessing

Runs WeightedBatchPreprocessing (WBPP) over raw frames, without its dialog: it calibrates lights with their bias, dark, and flat frames, registers them, and integrates them into masters. The run uses a PixInsight instance of its own, which ends with the run. See [Preprocess raw frames](../guides/preprocess-raw-frames.md).

| Parameter | Type | Description |
|---|---|---|
| `inputs` **required** | string[] | Absolute paths of folders and files with the frames: lights and calibration frames. A folder is read with everything below it. 1 to 500 paths. |
| `outputDirectory` **required** | string | Absolute path of a folder for the results, outside the inputs. It is created if it is not there, and nothing in it is replaced. |
| `keywords` | string[] | Up to 8 grouping keywords, for frames that must be kept apart. A name such as `NIGHT` keeps the calibration apart, and all its values still go into one master. With `post` behind a space, as `NIGHT post`, the calibration is shared, and each value gets a master of its own. WBPP takes the value from the path of a frame, such as a folder `night_2`. |
| `options` | object | Options of the automation mode of WBPP, by their names there, each with a text, a number, or `true` or `false`. Without options, WBPP uses its defaults. WBPP ignores a name it does not know. An option that makes WBPP run code is refused: one that names a script file, and the custom formula of its frame selection. |
| `waitMs` | integer | See above. A run usually takes longer, and the response is then the one of a run that is under way. |

```json
{
  "inputs": ["/data/NGC7000/frames"],
  "outputDirectory": "/data/NGC7000/work",
  "options": { "platesolve": false }
}
```

**Response** while the run is under way. [`get_job`](#get_job) with `jobId` returns the same, and the result once the run has ended:

```json
{
  "pending": true,
  "jobId": "e0e4dd27-cdfb-415e-a7c1-dab89170ea7c",
  "state": "running",
  "elapsedMs": 16012,
  "step": "registration of light frames",
  "logTail": ["* End registration of light frames"],
  "hint": "WBPP is at work in an instance of its own, which ends with the run. A run takes minutes to hours: wait with get_job and a long waitMs, again and again. The other tools work meanwhile. Do not start the run again."
}
```

**Response** of a run that has ended, here over four bias, four flat, and four light frames:

```json
{
  "outputDirectory": "/data/NGC7000/work",
  "summary": [
    "12 operation(s) completed, 0 failed, 0 canceled or not executed.",
    "No frames have been excluded from the execution."
  ],
  "problems": ["Cosmetic Correction requires a master dark."],
  "groups": [
    { "step": "master bias generation", "frames": "4 Bias frames (4 active)", "keywords": "[]" },
    {
      "step": "master flat generation",
      "frames": "4 Flat frames (4 active)",
      "filter": "H",
      "exposure": "4.07s",
      "keywords": "[]",
      "masterBias": "masterBias_BIN-1_6224x4168.xisf",
      "masterDark": "none"
    },
    {
      "step": "light frames calibration",
      "frames": "4 Light frames (4 active)",
      "filter": "H",
      "exposure": "300.00s",
      "keywords": "[]",
      "masterBias": "masterBias_BIN-1_6224x4168.xisf",
      "masterDark": "none",
      "masterFlat": "masterFlat_BIN-1_6224x4168_FILTER-H_mono.xisf"
    }
  ],
  "masters": [
    "/data/NGC7000/work/master/masterBias_BIN-1_6224x4168.xisf",
    "/data/NGC7000/work/master/masterFlat_BIN-1_6224x4168_FILTER-H_mono.xisf",
    "/data/NGC7000/work/master/masterLight_BIN-1_6224x4168_EXPOSURE-300.00s_FILTER-H_mono.xisf",
    "/data/NGC7000/work/master/masterLight_BIN-1_6224x4168_EXPOSURE-300.00s_FILTER-H_mono_autocrop.xisf"
  ],
  "log": "/data/NGC7000/work/logs/20261110190524.log",
  "report": "/data/NGC7000/work/logs/20261110190524_SmartReport.txt",
  "seconds": 36,
  "hint": "Read summary for operations that failed and frames that were left out, and groups for what each group was calibrated with. Then open the masters with open_image and check them."
}
```

| Field | Description |
|---|---|
| `summary` | What WBPP says about the run as a whole: how many operations completed and failed, each failed one with its reason, and the frames it left out. Up to 40 lines. |
| `problems` | Present if WBPP found something before it started. |
| `groups` | What each group of frames was calibrated with, read from the report of WBPP: the file of each master, or `none`. A group of lights with `masterFlat` `none` was not flat-fielded, and `hint` then says so first. Up to 200 groups. Missing if the report could not be read: then `report` is missing too, and `hint` says that the calibration is not known. |
| `moreSummaryLines`, `moreGroups` | Present if `summary` or `groups` leave something out: how many lines or groups. The rest is in `log` and `report`. |
| `masters` | The masters this run wrote. |
| `registrationReferences` | The frame that the lights were registered to, as the log of WBPP names it. A later run whose masters have to lie on these takes it as the option `referenceImage`, with `bestFrameReferenceMethod` `0`. |
| `log`, `report` | The log and the report of WBPP, for whoever can read files. |
| `seconds` | How long the run took. |

A run with failed operations still ends this way, with what failed in `summary`. A run that WBPP did not start, and one that broke off, end as an error: see [Preprocessing](errors.md#preprocessing).

One run at a time per session. [`cancel_job`](#cancel_job) stops a run, and the files it has written stay. A run goes on if the server ends, and ends by itself. While a run is under way, [`get_status`](#get_status) shows it as `preprocessing`, with its `jobId`. A session that starts later does not know that id: the log in the output folder says how the run ended.

PixInsight has to be running when a run is started, because the server asks it where WBPP is installed. A path with a character that has a meaning on the command line of PixInsight, such as a comma or a bracket, is refused with `invalid_path`. That includes the files to which WBPP itself adds `(1)`.

---

## list_scripts

Lists the scripts of the Script menu that [`start_script`](#start_script) can start: those PixInsight ships, and those in the folders of [`PIXINSIGHT_MCP_SCRIPT_DIRS`](configuration.md). Only offered in shared mode.

| Parameter | Type | Description |
|---|---|---|
| `search` | string | Case-insensitive part of the name, the menu, or the description. |

**Response,** for `search: "halve"`, with a script from a folder of the user:

```json
[
  {
    "name": "HalveAndCopy",
    "menus": ["Utilities > HalveAndCopy"],
    "info": "Halves the active image and makes a small new image.",
    "source": "user"
  }
]
```

| Field | Description |
|---|---|
| `name` | The name to pass to `start_script`. If two scripts carry the same name, the second one goes by its menu item, such as `NoiseEvaluation (CFA Bayer)`. |
| `menus` | Where the script sits in the Script menu. A script can sit in several places. |
| `info` | What the script says about itself, as plain text, shortened to 240 characters. |
| `source` | `shipped` for a script of the installation, `user` for one from a folder of yours. |
| `blocked` | Present if the assistant must not start this script, with the reason. |

The server lists the scripts of your folders as they were when it started. A script that has changed since is refused with [`script_changed`](errors.md#requests).

---

## start_script

Starts a script of the Script menu in your PixInsight. If the script opens a dialog, the response describes it. You work the dialog, or the assistant does with [`use_script_dialog`](#use_script_dialog), if you have [turned that on](../guides/run-scripts-and-code.md#let-the-assistant-work-the-dialog). The job ends when the script has, and then reports what is different. Only offered in shared mode. See [Run scripts and code](../guides/run-scripts-and-code.md).

| Parameter | Type | Description |
|---|---|---|
| `script` **required** | string | The name of the script, from `list_scripts`. |
| `view` | string | The main view to make the active image first. A script works on the active image. |
| `plain` | boolean | Start the script exactly as PixInsight does by itself. The assistant then cannot see or work its dialog. For a script that does not work otherwise. |
| `waitMs` | integer | How long to wait for the script to show a dialog or to end, from 0 to 55000. Default 3000. |

**Response** when the script shows a dialog:

```json
{
  "pending": true,
  "jobId": "2236f0a6-5710-4e4b-bff8-f1e706c60bf2",
  "dialog": {
    "title": "MeasureBackground",
    "size": [272, 178],
    "fields": [
      { "id": "f1", "type": "Label", "text": "Image: Ha" },
      { "id": "f2", "type": "Label", "text": "Ignore pixels above:" },
      { "id": "f3", "type": "Edit", "value": "0.8" },
      { "id": "f4", "type": "CheckBox", "text": "Store the result as a keyword", "value": false },
      { "id": "f5", "type": "TreeBox", "columns": ["Measure", "Value"], "rows": [], "value": null },
      { "id": "f6", "type": "PushButton", "text": "Measure" },
      { "id": "f7", "type": "PushButton", "text": "Done" }
    ]
  },
  "hint": "The script shows this dialog, and waits. Work it with use_script_dialog as the user would, who sees it too: set fields by their id, then press a button. A button can write, replace or delete files or start a program, and nothing takes that back: ask the user first, unless the user asked for exactly that. Never enter a password or a license key: ask the user to type it."
}
```

The fields are described under [`get_script_dialog`](#get_script_dialog). A script can also begin with a question: see [Questions of a script](#questions-of-a-script).

**Response** while the script shows no dialog of its own, which is a [pending job](#pending-jobs) with a hint of its own:

```json
{
  "pending": true,
  "jobId": "1ac11eea-b3a2-4083-9105-f5c009c45661",
  "state": "sent",
  "activity": "unknown",
  "waitingForInput": false,
  "hint": "The script is in PixInsight and shows no dialog of its own right now: it is at work, or it shows a window of PixInsight that only the user can work. Look again with get_script_dialog. The job ends when the script has, and get_job then reports what changed. Do not start the script again. Other tools wait until it has ended."
}
```

The hint says which of these it is: no dialog, a dialog whose script is busy and does not answer, or an action that the script is still at work on. For a script that was started with `plain`, it says that only you can work the dialog. [`get_job`](#get_job) on the job of a script returns the same as [`get_script_dialog`](#get_script_dialog).

**Response** when the script has ended, here one that changed the active image in one step and made a new image:

```json
{
  "newViews": ["Ha_copy"],
  "closedViews": [],
  "changedViews": [
    {
      "view": "Ha",
      "changed": ["history"],
      "historyIndex": 1,
      "steps": 1
    }
  ],
  "script": "HalveAndCopy",
  "startedOn": "Ha",
  "activeAfter": "Ha_copy",
  "log": [
    "Halving Ha",
    "PixelMath: Processing view: Ha",
    "Executing PixelMath expression:",
    "$T*0.5",
    "channel #0: done",
    "Truncating to [0,1]: done",
    "22.412 ms",
    "Made Ha_copy"
  ]
}
```

| Field | Description |
|---|---|
| `newViews`, `closedViews` | Images that are there or gone since the script started. |
| `changedViews` | Images that differ, with what differs in `changed`. |
| `changedViews[].changed` | `history`: steps were added or undone. `geometry`: size or number of channels. `astrometry`: a plate solution came or went. `previews`: their number. `metadata`: keywords or properties, such as a new plate solution over an old one. `pixels`: see `note`. |
| `changedViews[].steps` | How many steps the script added to the history. Pass it as `count` to [`undo`](#undo), with `historyIndex`, to take them back. |
| `changedViews[].note` | Present with `pixels`: the pixels differ while the history is at the same place. Usually that is a change with no step in the history, which undo cannot take back. The server compares 128 positions per channel, so a small local change can go unnoticed. |
| `startedOn`, `activeAfter` | The active image when the script started, and afterwards. |
| `log` | What the script wrote to the console, shortened like the `log` of [`run_process`](#run_process). Lines that start with `MCP:` say what the assistant did in a dialog. What PixInsight notes about the signature of a script is left out. |
| `hint` | Present if nothing is different, which is also what a cancelled dialog looks like. |

While the script is open, every other tool waits, and its pending response says that a script is open. A second `start_script` is refused with [`script_open`](errors.md#requests). To give up on a script, close its dialog in PixInsight. Where the assistant may work dialogs, `use_script_dialog` with the action `close` does the same.

What a script does to files or to settings of PixInsight does not show in the report.

---

## get_script_dialog

Reads what the script that `start_script` started shows right now: its dialog, or a question it asks. Offered in shared mode, unless [`PIXINSIGHT_MCP_SCRIPT_DIALOGS`](configuration.md) is `off`.

| Parameter | Type | Description |
|---|---|---|
| `picture` | boolean | Also return a picture of the dialog, as PixInsight paints it, and where each field lies in it. For what fields cannot say, such as a preview or a curve the script draws. |
| `help` | boolean | Also return the tooltip of each field, as `help`. |
| `field` | string | The `id` of one field, to read it by itself and in full: every row of a table, or all of a long text. The dialog must have been read before. |
| `from` | integer | With `field`: the row of the table, or the character of the text, to read from. Default 0. |
| `until` | string | Wait until the dialog shows a field that is not greyed out and whose text or value is exactly this, in any case, such as the button that ends a long run, instead of answering at once. |
| `waitMs` | integer | How long to wait for a dialog to appear, from 1000 to 55000. Default 3000, with `field` 10000, and with `until` 55000. |

**Response** with `picture` and `help`, shortened to two fields. The picture comes as an image block, and `file` is where it lies on disk:

```json
{
  "pending": true,
  "jobId": "2236f0a6-5710-4e4b-bff8-f1e706c60bf2",
  "dialog": {
    "title": "MeasureBackground",
    "size": [272, 178],
    "fields": [
      {
        "id": "f3",
        "type": "Edit",
        "value": "0.7",
        "at": [138, 27, 126, 20],
        "help": "Pixels brighter than this do not count as background."
      },
      { "id": "f7", "type": "PushButton", "text": "Done", "at": [171, 149, 93, 21] }
    ]
  },
  "hint": "The script shows this dialog, and waits. Work it with use_script_dialog as the user would, who sees it too: set fields by their id, then press a button. A button can write, replace or delete files or start a program, and nothing takes that back: ask the user first, unless the user asked for exactly that. Never enter a password or a license key: ask the user to type it.",
  "file": "/home/you/.local/state/mcp-server-for-pixinsight/jobs/2236f0a6-5710-4e4b-bff8-f1e706c60bf2/dialog-1.png"
}
```

Fields come in reading order: by row, then from left to right. Only what is visible is listed, so a field on another tab appears once that tab is selected. A text is cut after 300 characters, with `…` at its end. For a text field and a text box, `more` then says how many characters are left out.

| Field | Description |
|---|---|
| `dialog.title`, `dialog.size` | The title of the window, and its width and height in pixels. |
| `fields[].id` | The name of the field for [`use_script_dialog`](#use_script_dialog). A field keeps it while its dialog lives. A script that builds its dialog anew, as WBPP does after a run, gives every field a new one. |
| `fields[].type` | The kind of control, by its name in PixInsight: see the table below. |
| `fields[].text` | What is written on the field or next to it. Markup is removed. |
| `fields[].value` | What the field holds: see the table below. |
| `fields[].enabled` | Present as `false` if the field is greyed out. It cannot be used then. |
| `fields[].secret` | Present as `true` for a text field that hides what is typed, or did so earlier while the script ran. Its content is never returned, the picture shows a grey bar in its place, and only you can fill it in. A key in an ordinary text field is not recognized as one. |
| `fields[].at` | With `picture`: left, top, width and height of the field in the picture. |
| `fields[].help` | With `help`: the tooltip of the field, up to 600 characters. Without it: the start of the tooltip of a button or a check box that shows no text, because nothing else says what it is for. |
| `fields[].more` | Present if a text is cut: how many characters are left out. Read them with `field`. |
| `dialog.moreFields` | Present if the dialog has more than 250 fields: how many are left out. |
| `notes` | Present if there is something else to know, such as an earlier action that failed in the script after the script had asked something. |

| `type` | `value` | Also returned |
|---|---|---|
| `Label` | | `text` |
| `Edit` | The text. | `readOnly` if it cannot be changed. |
| `TextBox` | The text, up to 1,200 characters. The text boxes of a dialog share 6,000 characters if that gives each of them more: one alone gets them all. | `readOnly` |
| `CheckBox`, `RadioButton` | `true` or `false`. | `text` |
| `ComboBox` | The option that is selected. With `editable`, the text in the field. | `options`, up to 60, and `moreOptions` with the number of those left out. `editable` if a text of your own can be entered. |
| `SpinBox`, `Slider` | A whole number. | `range`: the lowest and highest value. |
| `NumericControl`, `NumericEdit` | A number. | `text`: its label. `range`. |
| `ViewList` | The id of the image or preview that is selected, or `null`. | |
| `GroupBox` | `true` or `false` if the group has a check box in its title. | `text`: its title. |
| `TabBox` | The label of the tab that is selected. | `options`: the labels of all tabs. |
| `TreeBox` | The number of the row that is selected, or `null`. | `columns`, `rows`, and for a selected row its cells as `selected`: see [Tables](#tables). |
| `PushButton` | | `text` |
| `ToolButton` | `true` or `false` for a button that stays pressed. | `text` |
| `Control` | | `drawn`: an area the script draws itself. `clicks` if it takes mouse clicks. |

**Response** if the script shows no dialog of its own right now: a [pending job](#pending-jobs), as under [`start_script`](#start_script). If the script has ended, the response is the report of the job.

### Tables

A table comes as its `columns` and its `rows`. Columns that the script hides are left out, and so is a last column without a heading and without text.

| Field | Description |
|---|---|
| `rows[].row` | The number of the row, which is what [`use_script_dialog`](#use_script_dialog) selects it by. It counts from 0 in the order the rows are read, rows inside other rows included. A table often has a column of its own that counts from 1: that is a cell like any other. |
| `rows[].cells` | The text of each cell, in the order of `columns`. A cell that shows a picture, such as a mark for a status, comes as an empty text. |
| `rows[].level` | Present for a row inside another row: how deep it lies. |
| `rows[].inside` | Present if rows lie inside this one that are not listed: how many, counting only the next level. |
| `rows[].checked` | Present as `true` for a row whose box is ticked. |
| `moreRows` | How many rows are not listed, inside the listed ones and after them. |
| `moreColumns` | How many columns are not listed. |
| `selected` | The cells of the row that is selected. |

The list of a dialog shows up to 60 rows and 16 columns of a table: as many levels of rows inside rows as fit, and of a longer table the first 60 rows. To read all of it, name the table as `field`:

```json
{ "field": "f5", "from": 1 }
```

```json
{
  "pending": true,
  "jobId": "14e150bf-1e06-42e8-98a4-23f4410ed896",
  "dialog": { "title": "MeasureBackground" },
  "field": {
    "id": "f5",
    "type": "TreeBox",
    "columns": ["Measure", "Value"],
    "value": 1,
    "selected": ["Average deviation", "0.0000"],
    "rows": [
      { "row": 1, "cells": ["Average deviation", "0.0000"] }
    ],
    "totalRows": 2,
    "from": 1
  }
}
```

A table read this way lists up to 200 rows of all levels and up to 40 columns, from the row `from` on. `totalRows` is the number of rows of the table, and `moreRows` then counts the rows after the last one listed. A text read this way comes in parts of 20,000 characters, with `more` for what follows. Where there is more, `hint` names the `from` to read on with. `field` goes with neither `picture` nor `until`.

### Wait for a long run

A script that works for minutes keeps its dialog open, often with a list of its steps. With `until`, the response comes when the dialog shows what marks the end:

```json
{ "until": "Done" }
```

Until then, and at the latest after `waitMs`, the response is a [pending job](#pending-jobs) whose hint says that the field is not there yet. Another dialog, a question of the script, and the end of the script are answered at once. The dialog is looked at every two seconds, and the text has to match exactly: after a few waits in vain, read the dialog without `until`.

### Questions of a script

A script asks in a message box, or in a file chooser. Nothing can answer these windows of PixInsight from outside, so the server shows a window of its own in their place: with the same text and buttons, and a line that says the assistant can answer as well. You can answer there as before, and the button that is the default one in the message box is the default one there too. In place of a file chooser the window has the buttons **Browse…**, which opens the chooser of PixInsight, and **Cancel**.

This happens if [`PIXINSIGHT_MCP_SCRIPT_DIALOGS`](configuration.md) is `operate`. With `read`, which is the default, a script shows the windows of PixInsight, and the response while one is open is a pending job.

**Response** while a script waits for an answer:

```json
{
  "pending": true,
  "jobId": "2236f0a6-5710-4e4b-bff8-f1e706c60bf2",
  "question": {
    "kind": "message",
    "text": "Replace the keyword BACKGRND of Ha?",
    "buttons": ["yes", "no"],
    "caption": "MeasureBackground",
    "icon": "question"
  },
  "hint": "The script asks this, and waits. Answer with use_script_dialog and action \"answer\": the name of one of its buttons. If the answer lets the script write, replace or delete something that the user did not ask for, ask the user first. The user sees the question too, and may answer it first."
}
```

| Field | Description |
|---|---|
| `question.kind` | `message`: a message box. `open_file`, `save_file`, `directory`: a chooser for a file to read, a file to write, or a folder. |
| `question.text`, `question.caption` | What the script asks, and the title of its window. |
| `question.buttons` | For a message: the buttons to answer with, from `ok`, `cancel`, `yes`, `no`, `abort`, `retry`, `ignore`, `yes to all` and `no to all`. |
| `question.icon` | For a message: `question`, `information`, `warning` or `error`. |
| `question.multiple` | Present as `true` for a chooser that takes several files. |
| `question.initialPath` | The folder the script suggests. |

Message boxes are passed on for scripts of both engines of PixInsight. File choosers are passed on for scripts that run on its V8 engine. A script for the older engine opens the chooser of PixInsight, which only you can work, and the response then is a pending job.

A message box that has neither a Cancel nor a No button, and more than one button, cannot be closed without a choice: its window comes back until one is made.

---

## use_script_dialog

Does one thing in the dialog of the running script, as you would with the mouse or the keyboard. Offered in shared mode if [`PIXINSIGHT_MCP_SCRIPT_DIALOGS`](configuration.md) is `operate`. It is `read` unless you set it.

| Parameter | Type | Description |
|---|---|---|
| `action` **required** | string | `set`, `press`, `click`, `answer` or `close`: see the table below. |
| `field` | string | For `set` and `press`: the `id` of the field. |
| `value` | string, number, boolean, or list of strings | For `set` and `answer`: see the table below. |
| `x`, `y` | integer | For `click`: a point in the picture of the dialog, in pixels from its left and top edge. |
| `allowOverwrite` | boolean | For `answer`: accept that the script replaces the file that is named. |
| `waitMs` | integer | How long to wait for the script to react, from 1000 to 55000. Default 10000. |

An action applies to what the assistant was last shown. If the script shows another dialog by now, or asks another question, the action is refused with [`dialog_changed`](errors.md#dialogs-of-scripts) or `question_changed`, and nothing is done.

| `action` | What it does |
|---|---|
| `set` | Gives a field its `value`, and tells the script as a change by the user would. A text for `Edit`, and for a `ComboBox` that is `editable`. `true` or `false` for `CheckBox`, `RadioButton` and a `GroupBox` with a check box. The text of an option for `ComboBox` and `TabBox`, or its number from 0 if no option has that text. A number within `range` for `SpinBox`, `Slider`, `NumericControl` and `NumericEdit`. The id of an image for `ViewList`. For a `TreeBox`, the `row` of one of its [rows](#tables), which selects it, opens up the rows it lies inside, and scrolls to it. |
| `press` | Presses a button. |
| `click` | Clicks with the left mouse button at `x`, `y`, into an area the script draws itself. Take the point from the picture and from `at`. On a button, a click presses it. On any other field it is refused, with the field to set instead. |
| `answer` | Answers a [question of the script](#questions-of-a-script). For a message, `value` is the name of one of its buttons. For a chooser it is an absolute path, a list of them where `multiple` is `true`, or `false` to cancel. |
| `close` | Closes the dialog without accepting it, as the close button of its window does. While a chooser is asked for, it cancels the chooser. |

**Response** after a button was pressed. It holds what is different in the dialog since the assistant last read it. Here the script has filled its table:

```json
{
  "pending": true,
  "jobId": "14e150bf-1e06-42e8-98a4-23f4410ed896",
  "dialog": {
    "title": "MeasureBackground",
    "changed": [
      {
        "id": "f5",
        "type": "TreeBox",
        "rows": [
          { "row": 0, "cells": ["Median", "0.4000"] },
          { "row": 1, "cells": ["Average deviation", "0.0000"] }
        ]
      }
    ],
    "unchanged": 6
  },
  "hint": "Only what is different in the dialog since you last read it: of a changed field, the details that differ. get_script_dialog shows all of it."
}
```

| Field | Description |
|---|---|
| `dialog.changed` | The fields that differ, each with its `id`, its `type`, its `text` if it has one, and only the details that differ. A detail that a field no longer has comes as `null`, and `enabled` as `true`. |
| `dialog.added` | Present if fields are new: each in full. |
| `dialog.gone` | Present if fields are no longer shown: their ids. |
| `dialog.unchanged` | How many fields are as they were. |
| `dialog.listedInPart` | Present if fields that count as unchanged are listed only in part, such as a long table: their ids. Only the listed part of them was compared. |

After a row was selected, the response names the row, so that a number that was meant for another row shows at once:

```json
{
  "pending": true,
  "jobId": "14e150bf-1e06-42e8-98a4-23f4410ed896",
  "dialog": {
    "title": "MeasureBackground",
    "changed": [
      { "id": "f5", "type": "TreeBox", "value": 1, "selected": ["Average deviation", "0.0000"] }
    ],
    "unchanged": 6
  },
  "hint": "Only what is different in the dialog since you last read it: of a changed field, the details that differ. get_script_dialog shows all of it."
}
```

If the action opens another dialog, the response describes that one in full, as [`get_script_dialog`](#get_script_dialog) does, and the first dialog comes back when it is closed. If the script asks something, the response is the [question](#questions-of-a-script). If the script is still at work on the action when the wait is over, the response is a [pending job](#pending-jobs) that says so. If the action ends the script, the response is the report of the job:

```json
{
  "newViews": [],
  "closedViews": [],
  "changedViews": [
    { "view": "Ha", "changed": ["metadata"], "historyIndex": 0, "steps": 0 }
  ],
  "script": "MeasureBackground",
  "startedOn": "Ha",
  "activeAfter": "Ha",
  "log": [
    "MCP: set Edit to \"0.7\"",
    "MCP: pressed PushButton \"Measure\"",
    "Background of Ha: 0.4000",
    "MCP: set CheckBox \"Store the result as a keyword\" to true",
    "MCP: pressed PushButton \"Done\"",
    "MCP: answered \"Replace the keyword BACKGRND of Ha?\" with yes"
  ]
}
```

Every action that is carried out is written to the Process Console with `MCP:` in front, so you can read there what was done on your behalf.

What you could not do, the assistant cannot do either. A field that is greyed out, a field of a dialog underneath another one, and a field with `secret` are refused: see [Dialogs of scripts](errors.md#dialogs-of-scripts).

> [!IMPORTANT]
> A script acts on what its dialog says. A button can start hours of work, write or replace files, or start a program, and none of that goes into the history of an image. The server checks one thing: a file that exists is only handed to a script that asks where to write if `allowOverwrite` is `true`. It cannot tell what a field, a check box, a folder, or the answer to a message makes a script do. There, the assistant is told to ask you first, and you can see each step in the dialog and in the console. That is why this tool is only there once you have set [`PIXINSIGHT_MCP_SCRIPT_DIALOGS`](configuration.md) to `operate`.

---

## run_code

Runs JavaScript that the assistant wrote, inside PixInsight, with its scripting API on the V8 engine. Only offered if you have set [`PIXINSIGHT_MCP_ALLOW_CODE`](configuration.md). See [Let the assistant run its own code](../guides/run-scripts-and-code.md#let-the-assistant-run-its-own-code).

| Parameter | Type | Description |
|---|---|---|
| `code` **required** | string | The body of a function, without includes. It returns a value that JSON can hold. |
| `waitMs` | integer | See above. |

**Response,** for code that makes an image, fills it between `beginProcess()` and `endProcess()`, and returns its median:

```json
{
  "newViews": ["flat"],
  "closedViews": [],
  "changedViews": [],
  "value": 0.25,
  "log": ["Filled flat"]
}
```

| Field | Description |
|---|---|
| `value` | What the code returned, or `null`. Big integers come as strings, typed arrays as arrays, and `NaN` and infinite numbers as `null`. |
| `newViews`, `closedViews`, `changedViews` | What the code did to the open images, as for [`start_script`](#start_script). |
| `log` | What the code wrote to the console, shortened like the `log` of [`run_process`](#run_process). |

Code that fails ends with [`code_error`](errors.md#processes):

```json
{
  "error": "code_error",
  "message": "The code threw (line 2): noSuchFunction is not defined"
}
```

The message names the line, and the images the code had made or changed by then. Code that you abort in PixInsight ends with `aborted`, in the same way.

---

## get_job

Checks on a job that was still running when its tool returned, and returns its result when it has one. For the job of a script whose dialog can be read, it returns what [`get_script_dialog`](#get_script_dialog) returns: the dialog or the question as soon as there is one. For a preprocessing run, it returns what [`start_preprocessing`](#start_preprocessing) returns.

| Parameter | Type | Description |
|---|---|---|
| `jobId` **required** | string | The job ID. |
| `waitMs` | integer | See above. |

### Pending jobs

An unfinished job has this response, which is not an error:

```json
{
  "pending": true,
  "jobId": "4b79607a-1cc1-464e-bad1-8935bdbde109",
  "state": "running",
  "activity": "computing",
  "waitingForInput": false,
  "logTail": ["TGVDenoise: Processing view: M31", "Processing channel #0:"],
  "hint": "The job is still in progress. Check on it with get_job."
}
```

| Field | Description |
|---|---|
| `state` | `queued`: waits in the server. `sent`: handed to PixInsight, but not started. `running`: in progress. |
| `activity` | `computing`, `idle`, or `unknown` if the server cannot tell. |
| `waitingForInput` | `true` if PixInsight seems to wait for a dialog. See [When PixInsight shows a dialog](../guides/dialogs-jobs-crashes.md#when-pixinsight-shows-a-dialog). |
| `logTail` | The newest lines of the output. |

When the job is done, `get_job` returns the regular response of the original tool.

---

## cancel_job

Withdraws a job that has not reached PixInsight yet, or stops a [preprocessing run](#start_preprocessing). To stop a job that runs in PixInsight, see [Stop a process](../guides/dialogs-jobs-crashes.md#stop-a-process).

| Parameter | Type | Description |
|---|---|---|
| `jobId` **required** | string | The job ID. |
| `abandon` | boolean | For a job already in PixInsight: stops waiting for it, so that the queue moves on. Only if PixInsight crashed or no longer reacts. |

**Response**

```json
{ "cancelled": true }
```

A job that is on its way to PixInsight cannot be withdrawn any more, and neither can a script that [`start_script`](#start_script) has started. Close the dialog of the script in PixInsight instead.

A preprocessing run is stopped by ending its instance, which is the server's own and holds nothing else. The files that the run has written stay:

```json
{ "cancelled": true, "message": "The run was stopped. What it had written is still there." }
```

The server ends the process that it started for the run. If that takes longer than a few seconds, the message says that the run was told to stop and has not ended yet: check with [`get_job`](#get_job).

With `abandon`, the job ends with the error [`abandoned`](errors.md#processes), and the response says whether it can still run:

```json
{ "abandoned": true, "stillRuns": false, "message": "The server stopped waiting for this job. PixInsight had not started it, and it will not run any more." }
```

A job that PixInsight has already started goes on there, because nothing can stop it from outside. A job it has not started is withdrawn: PixInsight skips it when it gets to it.

---

## get_guide

Returns guides from the processing library: workflows, stages, methods, and practices, matched to the processes installed in the running PixInsight. The response is Markdown text, not JSON.

| Parameter | Type | Description |
|---|---|---|
| `name` | string or string[] | The ID of a guide, such as `workflows/sho-narrowband`, or a list of up to 12 IDs. Without it, the response is the catalog. |

The catalog opens with the rules for working in PixInsight. They are the same as the instructions the server sends when a client connects, which not every client passes on to its model.

**Response,** for `methods/sharpen/blurxterminator`, shortened:

```markdown
# Sharpen with BlurXTerminator

AI deconvolution of a linear channel, with moderate values that held up on narrowband data.

- Stage: `stages/sharpen`
- Needs `BlurXTerminator`.
- Applies to: linear
- Status: tested. Evidence: Two runs on IC 1871 at 752 mm, 3.76 µm pixels, on a CPU.

## Steps
```

A method whose process is not installed says so. If the installed version of a process lacks a parameter the guide names, the guide starts with a warning. See [What the server makes of it](processing-library.md#what-the-server-makes-of-it).

To add guides of your own, see [Add a processing method](../guides/add-a-processing-method.md).
