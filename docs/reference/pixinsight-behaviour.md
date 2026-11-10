# PixInsight behaviour reference

This article lists how PixInsight behaves where the server depends on it, as measured on a running PixInsight. Read it before you change how the server talks to PixInsight. For the design that rests on these measurements, see [Architecture](../architecture.md).

All of it was measured on Linux (KDE on Wayland) with PixInsight 1.9.6 build 1713 and V8 14.3. Most rows are pinned by a test in `test/live`, so that an update of PixInsight shows what has changed. Everything has to be measured again on Windows and macOS.

These are observations of the running program, made through its documented command line and scripting interface. Nothing here is taken from PixInsight's source code or documentation.

To add a row, measure the behaviour on an instance of your own, describe it in your own words, and add a live test if the server comes to depend on it.

## Command line and instances

| Behaviour | Measured |
|---|---|
| Instance start, windowless | 3.3 s |
| No-op `-x` round trip | about 0.5 s, visible or windowless |
| `-x` while a script runs | Queued and executed afterwards, even while the script pumps events |
| Concurrent `-x` clients | All arrive, in arbitrary order: serialize in the server |
| `-x` to an empty slot | Exit code 255 with a fatal error message |
| `-e` | Lists slots with PID or `crashed`; a killed instance shows `crashed` briefly on normal exit too |
| `--stop-process`, `--get-process-status` | No effect and always -1 for PixelMath: not usable |
| Path with spaces in `-x` | Works; commas separate arguments |
| `QT_QPA_PLATFORM=offscreen` | Runs without a window, on Linux |
| `-x` to an instance frozen with SIGSTOP | The client returns exit code 0 after 3 s, so delivery does not block |
| `-e` when the reader of its output goes away | The client segfaults in `fprintf` and dumps core: `PixInsight -e \| true` reproduces it. Hence the output goes to a file. The instances are not affected: `--terminate` dumped nothing in four sequences |
| The Linux launcher | Passes its arguments through `eval`, and puts those with a space into double quotes. So a space is safe, while a tab, braces, brackets and the characters of the shell are not |

## Process metadata

| Behaviour | Measured |
|---|---|
| `MetaObject.externalObjects` | 121 processes, 2,451 parameters, 1,382 constants, including third-party modules |
| Type of a parameter | First word of the description: `int32`, `double`, `String`, `Array`, ... |
| Enumerated parameters | Typed as plain `int`: 189 of them, 185 printed symbolically by `toSource` |
| Table columns | Constants named `<table>_<column>`, whose value is the column position. The metadata itself lists them alphabetically |
| Not available in PJSR | Numeric ranges, the link between a parameter and its constants, the `Process` object |

## Errors and results

| Behaviour | Measured |
|---|---|
| Value out of range, wrong type | Clear exception on assignment, with the valid range |
| Unknown parameter | Accepted as a JS property and **silently ignored** |
| Process failure | `executeOn` returns `false` without throwing, reason only in the console |
| Syntax error in a script | Nothing runs and nothing is reported, hence the fixed runner with `eval` |
| `console.beginLog( file )` | The file grows during the run, but holds no percentages |
| 16 parameters | Are BigInt, which `JSON.stringify` refuses without a replacer |
| `toSource` | Rounds small values for display (`0.000597` shows as `0.0006`). Reading the property gives the real value |
| A plugin calling a missing external program | `GraXpert` with an empty `appPath` returned success with `Exit error code 255` in the log, and no change |
| `stdDev` over parallel threads | Not bit-identical between runs on the same pixels, so it cannot detect changes |
| `numberOfChannels: 3` without `colorSpace` | Grayscale plus two alpha channels, and PixelMath `$T` then removes one |

## Enumerated parameters

Assigning an invalid value to an enumerated parameter does not behave consistently, which is why the server has an [enum guard](../architecture.md#the-enum-guard):

| Assignment | Result |
|---|---|
| `PixelMath.newImageColorSpace = 9999` | Clean exception |
| `StarAlignment.mode = 9`, `onError = 8` | Clean exception |
| `StarAlignment.mode = 9999` or `-1`, `ImageIntegration.combination = 9999`, `Debayer.cfaPattern = 9999` | Hangs at 100 % CPU, later crashes |
| `ACDNR.prefilterMethodC = 3` | Crashes, although the value is small |

## The visible window

| Behaviour | Measured |
|---|---|
| Focus on normal commands | Stays with the other application, also for new windows and `bringToFront` |
| Focus on a modal prompt | Moves to PixInsight, so stray keystrokes could answer it |
| Open modal dialog | Holds the queue, including dialogs at startup; queued jobs run by themselves afterwards |
| CPU while waiting or computing | 0-2 % versus 1641 %, which is how `waitingForInput` works |
| Abort button | Works during a native process, after a confirmation; the script gets `Process aborted` |
| `--terminate` with unsaved images | Asks "Exit anyway?" (default No), contrary to `--help` |
| `--terminate` while a script runs | Has no effect until the main thread is free, so a stuck instance needs a kill |
| `--terminate` with modified images in automation mode | Still running after 12 s, presumably answering its own "Exit anyway?" with No. Close the images first |
| A killed instance | Leaves its swap files behind |
| `MessageBox` in automation mode | Answers itself with the default button |
| Process Console | Slides over the workspace on process runs; `console.hide()` had no effect; collapses after a click |

## Window control

For a later tool that arranges windows. Measured, but not used yet.

| Behaviour | Measured |
|---|---|
| `geometry` | Moves and resizes exactly |
| Zoom, then `fitWindow()`, then `position` | Exact grid |
| `zoomToFit`, `zoomToOptimalFit` | Reset the size and push the window into the workspace, so call them first |
| `position` | Not clamped: -500 and 99999 are accepted, and the window is gone |
| Workspace size | No API found; `Control.availableScreenRect` was unusable with two monitors |
| Tile, cascade | No API or console command found: compute layouts in the server |
| Manual drags and clicks | Visible to scripts |
| `visible` | Also false for windows on another workspace; `ImageWindow.windows` spans all workspaces |
| Workspaces | Console commands in an `.scp` file through `-x`: `workspace -c=<id>`, `-s=<id>`; first id `Workspace01` |

## Scripts

Measured in a windowless instance in automation mode.

| Behaviour | Measured |
|---|---|
| `-x=<slot>:<script>,<a>,<b>` with any script, in either engine | Runs it. `jsArguments` is `a`, `b`. `Parameters.isViewTarget` and `isGlobalTarget` are false, so a script with a dialog opens it |
| `Script.filePath`, `parameters` | Read-only in V8. Writable in the classic engine, where `md5sum` then fills itself in |
| `executeOn()` or `executeGlobal()` of a configured `Script` instance, from a script | Returns false, and the console says that a Script instance cannot run recursively. So no script can run another one with parameters |
| A script calls `Dialog.execute()` in a windowless instance | Blocks for good: nobody can close the dialog. Later jobs wait, and the server reports `waitingForInput` |
| Scripts that read `jsArguments` | 3 of the 116 featured scripts of this installation, among them the automation of WBPP |
| Process for plate solving | None among the 121 installed processes: ImageSolver is a script |
| `window.bringToFront()` | Makes the window the active one, also for a classic script started afterwards. `ImageWindow.activeWindow` is read-only |
| `console.beginLog( path )` in one script | Stays on for the scripts that follow, in either engine, until a script calls `endLog()` or `beginLog()` again. It replaces the file, and a second call starts over |
| `coreSrcDirPath` | The `src` folder of the installation, with the scripts in `scripts`: 315 `.js` files of 10 MB here, 116 of them featured, none deeper than two folders, and each `#feature-id` within the first 16 KB |
| Forms of the `#feature-id` directive | `Name : Menu > Item \| Menu > Item`, or only `Menu > Item` in 13 older scripts. Directives can continue on the next line after a backslash |
| `view.beginProcess( UndoFlag.NoSwapFile )` | Changes pixels with no step in the history, and `historyIndex` stays |
| Assigning `window.keywords` | Changes the metadata with no step in the history |

## Image state and metadata

| Behaviour | Measured |
|---|---|
| `isModified` of a new image | `false`, with `filePath` empty and `isNew` true |
| `executeOn( view, false )` | Does not set `isModified`, so `close()` then closes without asking |
| `beginProcess( UndoFlag.NoSwapFile )` on a new window | `isModified` stays `false`, like a new image from PixelMath. With default flags it would be `true`, with an undo step back to an empty image |
| PixelMath `createNewImage` | Drops all FITS keywords and properties, including the astrometric solution |
| `ImageWindow.open( ..., copy = true )` | Keeps the original `filePath`, so it does not protect the source |
| `saveAs` | Changes the path of the window, also to a JPEG |
| `FileFormatInstance` | Writes without touching the window, honors `quality N` and the bit depth of `ImageDescription` |
| Undo with a masked state | `historyIndex` brings back the mask that was active when the state was saved. `maskVisible` is not part of that |
| Mask after undoing a crop | Assigning the old mask throws `Incompatible mask image` |
| `forceClose` of an image in use as a mask | Works. The other image then has no mask, and undo there stays safe |
| `hasMaskReferences` | Stays `true` after `removeMask`, because the history holds a reference, so it does not tell whether a mask is in use |
| Mirror, rotation | Keep all statistics, so only comparing samples at fixed positions reveals them |
| `window.rgbWorkingSpace` | Assignable, and differs per window. A new window has the default |
| ICC profile of a window | Not available in PJSR, so copies cannot keep it |
| `File.move` onto an existing file | Replaces it on Linux. Not verified elsewhere, so the code removes the target first |
| `overwrite*` parameters | False by default, except `CometAlignment`, where both are `true` |
| `Crop` with `noGUIMessages` on an image with previews, a mask, and in use as the mask of another image | Deletes the previews, removes the mask, and removes the image as mask of the other one, each with a console warning. Undo restores the previews and the mask, but **not** the use as a mask elsewhere |
| A view property without the `Permanent` attribute | Dropped as soon as a process changes the image, and back after undo. The marker of a protected copy was lost that way after the first step, and with it the protection of the source file |
| A protected copy after one process and one undo | `isModified` is `false` again, and `canGoForward` is `true`: closing would lose the undone step without a word |
| `ImageWindow.open` of a file that is already open and modified | Opens a second window (`name1`). The first one keeps its changes |
| A boolean parameter assigned `1`, `"true"` or `0` | Throws `Invalid argument type: Boolean value expected` |
| `-x` with a script that does not exist | The client returns 0 after 0.4 s, and an automation mode instance keeps answering. In the GUI not measured |
| `show()` on a new window | Makes it the active window. `createPreview` does not change the active window |
| `saveAs` into a folder that does not exist | Returns `false`. `File.createDirectory( path, true )` creates the folders |
| Parameters named `command` | `APASS` and `Gaia` have `"search"` as default, `MultiscaleGradientCorrection` and `SpectrophotometricFluxCalibration` an empty text. What other values do is not known, so the policy keeps them at their default |
| Each `executeOn` on a preview | Starts again from the main image, also after a direct change to the preview. `historyIndex` stays 1, so there is one undo step |
| A star image from a preview of a plate-solved image | StarXTerminator: `AstrometricMetadata::Write(): Incompatible image dimensions`, modal in the GUI, and the new image gets a wrong solution. On a copy of the region, neither |
| `Crop`, `DynamicCrop`, `FastRotation`, `Rotation`, `Resample`, `IntegerResample` on a spline-based solution | Ask whether to delete it, and automation mode answers No, which cancels the process. With `noGUIMessages: true`: a console warning, properties 101 to 46, and undo and redo restore and delete them |
| `noGUIMessages` default | `false` for those six and `FilterManager`, `true` for the batch processes |
| `writeImageProperty` | Returned `true` 101 times for each format. Read back: JPEG 0, TIFF 1, XISF 90, and FITS takes none but keeps its keywords |
| `file.open` plus `imageProperties` | Reads properties back as `[id, type]` pairs, without dialogs in JPEG, TIFF, FITS and XISF |
| Settings per slot | `SpectrophotometricFluxCalibration` works on slot 1 and fails on slot 200 with `Database files not available for the Gaia DR3/SP catalog`, so own instances lack configured databases, and live tests cannot rely on them |
| Read-only output parameters | Scalars keep their initial value unless the process sets them: `isValid` stayed `false` after a successful flux calibration |
| `rangeClipHigh = 1` | Also leaves out samples equal to 1, contrary to the documentation |
| Automatic stretch of a star layer | Median 4.5e-8 and MAD 2.2e-8 on a real one, so `computeAutoStretch` gives midtones of 1.4e-7: bloated stars and bright patches. Midtones at the level that one pixel in 200 exceeds (0.00026 there, 0.22 on a stretched star image) show clean stars in both |
| `Bitmap.scaledTo( n )` | Always n x n. `scaled( factor )` keeps the aspect ratio |

Real data, a plate-solved master from WBPP: a copy keeps 40 keywords, 102 properties, and the astrometric solution, and they survive an export to XISF. The extra `crop_mask` image opens as a second window.

## A crash that no check can catch

MLDenoise crashed PixInsight during dynamic initialization of `bin/lib/libonnxruntime_providers_cuda.so`, with SIGSEGV and then an abort, before any inference. The enum guard cannot catch that kind of crash.

## Starting the server from a release file

| Behaviour | Measured |
|---|---|
| `npx -y --package <file.tgz> mcp-server-for-pixinsight` | Starts the server from a packed release file, in under a second once npm has it in its cache. `npx -y <file.tgz>` tries to execute the file instead |

## Not measured yet

- What a GUI instance does on `-x` with a missing script.
- Whether `console.beginLog` displaces a log the user has running.
- Whether `ImageIntegration` rewrites existing drizzle files without an overwrite parameter.
- A process started by click while `-x` arrives.
- Prompts when opening RAW files or files with ICC profiles.
- Focus behaviour on X11, Windows and macOS.
- Whether PixInsight asks about a duplicate with `isModified` false when it exits.
