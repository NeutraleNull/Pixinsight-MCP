# Tool reference

This article lists all tools the server offers to an assistant, with their parameters and responses. For failures, see the [error reference](errors.md).

Most tools that work on an image or a file take an optional `waitMs`, the number of milliseconds to wait for the result, from 0 to 55000, with a default of 20000. If the job takes longer, the response is a [pending job](#pending-jobs).

Any response can end with a `notice`, as a separate text block, if the assistant must know something before trusting the result. For example, that the PixInsight instance has changed.

A tool that returns a list always has the list as its first text block. Console messages about it follow in a block of their own.

- **Connection:** [`get_status`](#get_status)
- **Processes:** [`list_processes`](#list_processes), [`describe_process`](#describe_process), [`run_process`](#run_process)
- **Images:** [`list_images`](#list_images), [`get_image_stats`](#get_image_stats), [`get_preview`](#get_preview), [`duplicate_image`](#duplicate_image)
- **Previews:** [`create_preview`](#create_preview), [`delete_preview`](#delete_preview)
- **History:** [`undo`](#undo), [`redo`](#redo)
- **Files:** [`open_image`](#open_image), [`save_image`](#save_image), [`export_image`](#export_image), [`close_image`](#close_image)
- **Scripts and code:** [`list_scripts`](#list_scripts), [`start_script`](#start_script), [`run_code`](#run_code)
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

Starts a script of the Script menu in your PixInsight. An ordinary script opens a dialog, which you set and confirm. The job ends when the script has, and then reports what is different. Only offered in shared mode. See [Run scripts and code](../guides/run-scripts-and-code.md).

| Parameter | Type | Description |
|---|---|---|
| `script` **required** | string | The name of the script, from `list_scripts`. |
| `view` | string | The main view to make the active image first. A script works on the active image. |
| `waitMs` | integer | How long to wait for the script to end, from 0 to 55000. Default 3000, because a script usually waits for you. |

**Response** while the script is open, which is a [pending job](#pending-jobs) with a hint of its own:

```json
{
  "pending": true,
  "jobId": "1ac11eea-b3a2-4083-9105-f5c009c45661",
  "state": "sent",
  "activity": "unknown",
  "waitingForInput": false,
  "hint": "The script is in PixInsight, where an ordinary script shows a dialog. Tell the user what to set there, and wait. The job ends when the script has, and get_job then reports what changed. Do not start the script again. Other tools wait until it has ended."
}
```

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
| `log` | What the script wrote to the console, shortened like the `log` of [`run_process`](#run_process). What PixInsight notes about the signature of a script is left out. |
| `hint` | Present if nothing is different, which is also what a cancelled dialog looks like. |

While the script is open, every other tool waits, and its pending response says that a script is open. A second `start_script` is refused with [`script_open`](errors.md#requests). To give up on a script, close its dialog in PixInsight.

What a script does to files or to settings of PixInsight does not show in the report.

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

Checks on a job that was still running when its tool returned, and returns its result when it has one.

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

Withdraws a job that has not reached PixInsight yet. To stop a running one, see [Stop a process](../guides/dialogs-jobs-crashes.md#stop-a-process).

| Parameter | Type | Description |
|---|---|---|
| `jobId` **required** | string | The job ID. |
| `abandon` | boolean | For a job already in PixInsight: stops waiting for it, so that the queue moves on. Only if PixInsight crashed or no longer reacts. |

**Response**

```json
{ "cancelled": true }
```

A job that is on its way to PixInsight cannot be withdrawn any more, and neither can a script that [`start_script`](#start_script) has started. Close the dialog of the script in PixInsight instead.

With `abandon`, the job ends with the error [`abandoned`](errors.md#processes), and the response says whether it can still run:

```json
{ "abandoned": true, "stillRuns": false, "message": "PixInsight had not started the job, and it will not run any more." }
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
