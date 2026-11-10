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
| What a listing with `-e` costs | 0.25 to 1 s, and about 250 files that come and go in the folder for temporary files: with two instances running, the number of the next new file there rose by 252 per listing, in five of five |
| `--stop-process`, `--get-process-status` | No effect and always -1 for PixelMath: not usable |
| Path with spaces in `-x` | Works; commas separate arguments |
| `QT_QPA_PLATFORM=offscreen` | Runs without a window, on Linux |
| `-x` to an instance frozen with SIGSTOP | The client returns exit code 0 after 3 s, so delivery does not block |
| `-e` when the reader of its output goes away | The client segfaults in `fprintf` and dumps core: `PixInsight -e \| true` reproduces it. Hence the output goes to a file. The instances are not affected: `--terminate` dumped nothing in four sequences |
| The Linux launcher | Passes its arguments through `eval`, and puts those with a space into double quotes. So a space is safe, while a tab, braces, brackets, a backslash and the characters of the shell are not |
| The Linux launcher and its process | The launcher stays the parent of PixInsight and lives as long as it. Ending the launcher alone leaves PixInsight running: after 30 s timeouts that ended only the launcher, 27 clients of `-e` were still there. The two are one process group if the launcher is started as the leader of one |
| `-e` that never returns | A client of `-e` waits on a System V semaphore. Once, all of them waited without end on one that had the value 0 and that no process had ever operated on: 28 clients over 12 minutes, each until it was ended. Instances were not affected, and neither was the user's work in one |
| How that semaphore came to be | It was created in the second in which one `-e` client started, during a test run in which two servers listed instances at the same time and a third one worked in another session. That client waited on it from then on, alone, for 36 minutes. Then PixInsight created a key file in the folder for temporary files whose number in the file system ended in the same 16 bits as the key of the semaphore, and from that moment every `-e` waited on it. With 252 files per listing, those 16 bits come round after some 260 listings. So clients of PixInsight are called one at a time, also among servers |
| Getting out of it without a restart | After the waiting clients were ended (`pkill -KILL -fx "<path>/PixInsight -e"`, which matches no instance) and the semaphore was removed (`ipcrm -s <id>`), the next `-e` returned in 0.2 s with every instance. The semaphore is the one whose `ipcs -s -i <id>` shows the value 0 while no client runs, and whose key ends in the same four digits as the number of a file `qipc_systemsem_PIXINSIGHTINSTANCE…` in the folder for temporary files |

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
| A script calls `Dialog.execute()` in a windowless instance | Blocks until something closes the dialog, which only code of the same script can do, see [Dialogs of scripts](#dialogs-of-scripts). Later jobs wait, and the server reports `waitingForInput` |
| Scripts that read `jsArguments` | 3 of the 116 featured scripts of this installation, among them the automation of WBPP |
| Process for plate solving | None among the 121 installed processes: ImageSolver is a script |
| `window.bringToFront()` | Makes the window the active one, also for a classic script started afterwards. `ImageWindow.activeWindow` is read-only |
| `console.beginLog( path )` in one script | Stays on for the scripts that follow, in either engine, until a script calls `endLog()` or `beginLog()` again. It replaces the file, and a second call starts over |
| `coreSrcDirPath` | The `src` folder of the installation, with the scripts in `scripts`: 315 `.js` files of 10 MB here, 116 of them featured, none deeper than two folders, and each `#feature-id` within the first 16 KB |
| Forms of the `#feature-id` directive | `Name : Menu > Item \| Menu > Item`, or only `Menu > Item` in 13 older scripts. Directives can continue on the next line after a backslash |
| Two featured scripts with one name | `NoiseEvaluation` exists twice in this installation, with the menu items `NoiseEvaluation` and `NoiseEvaluation (CFA Bayer)`. So the name alone does not identify a script |
| A signed script | PixInsight writes four lines to the console before the script runs: that the signature was verified, the script, the developer and the time of signing |
| A script that shows its result in its dialog only | FWHMEccentricity writes the number of stars to the console, but its measurements appear only in a table of its dialog |
| A signed script whose file was changed | PixInsight does not run it: `Signature verification failed`, `Invalid code signature`. A script without a signature runs |
| `Security.getScriptSignature( path )` | `valid` true for a shipped script. False for a changed copy with its signature file, and for a script without one, which has an empty `developerId` |
| A signed script that another file includes | Runs without the four lines, and also if it was changed after it was signed: PixInsight checks only the file it is asked to run |
| ImageSolver on a crop whose keywords give the center of the whole image | Several error lines about the initial alignment, then it solves blindly and succeeds. The step is in the history, and undo takes the solution away again |
| `view.beginProcess( UndoFlag.NoSwapFile )` | Changes pixels with no step in the history, and `historyIndex` stays |
| Assigning `window.keywords` | Changes the metadata with no step in the history |
| `FITSKeyword.isNumeric`, `numericValue`, `isBoolean` and `strippedValue` | Tell a number and `T` or `F` from a text, and give a text without its quotes, also after the keywords went through an XISF file. `view.propertyValue()` gives a number, a text, or an object for a property that holds more than one value |

## Dialogs of scripts

Measured in a windowless instance in automation mode, and once in a visible one: FWHMEccentricity on a crop gave the same numbers through the hook as its dialog shows.

**Engines, and a file that includes a script**

| Behaviour | Measured |
|---|---|
| Engines of the shipped scripts | 74 of 315 `.js` files carry the directive for V8, among them ImageSolver, AnnotateImage, FWHMEccentricity and WBPP. The others run on the classic engine |
| Forms of the directive | `#engine v8` and `#engine V8`, which one shipped script uses, both select V8. So does the directive with spaces in front, after a comment, and after code |
| A file that runs code and then includes a script with `#include "<path>"` | The script runs in the same scope, in either engine. Its `#__FILE__` is its own path, its relative includes resolve from its own folder, and it gets the `jsArguments` of the file that includes it |
| `#engine v8` in an included script | Ignored: the engine is that of the file that includes it. A V8 script included by a file without the directive runs on the classic engine |
| Paths with letters outside ASCII and with spaces, in the text of such a file | Read as UTF-8, in either engine: as a string in the code, and in the `#include` directive |
| A new script on V8 | Starts in a fresh scope: nothing a script before it defined or changed is there. A timer of the script before no longer fires |
| A new script on the classic engine | Finds every variable, every function and every changed prototype of the scripts that ran before it in this instance |
| A read of a property that is not there, in the classic engine | A warning in the console for a line such as `x.missing === true`. None for `typeof x.missing` or `"missing" in x`. A function that returns a value on some paths only gets a warning when the script loads |

**Dialogs and timers**

| Behaviour | Measured |
|---|---|
| A `Timer` while `Dialog.execute()` waits | Fires, also in a windowless instance. `dialog.ok()` or `cancel()` from it ends the wait, and `execute()` returns the code |
| A timer whose handler opens a second dialog | Does not fire again until its handler returns, so until that dialog is closed. Another timer does |
| The first tick of a timer that was started before `execute()` | Finds the dialog not visible yet. `dialog.ok()` does nothing then: the dialog still comes up and waits |
| An answer that a timer takes in its first tick with the dialog visible, followed by `ok()` | Seen once, on the classic engine, to leave the script waiting although the answer was taken. Not seen again in over a hundred runs since nothing is done before the second such tick |
| A periodic timer that still runs when a classic script ends | Breaks the scripts after it: their timers no longer fire, and a later script reported the crash signal. On V8 it does no harm |
| `dialog.render()` | A bitmap of the dialog as painted, in its size, also without a window. `save( "x.png" )` writes a PNG. A field in password mode shows one dot per character |
| `new Graphics( bitmap )`, `fillRect()`, `end()` | Paints on the bitmap before it is saved, in either engine |
| `execute` of a dialog on V8 | An own property of every instance that can be neither written nor configured. The same for `MessageBox`. The global `Dialog` can be replaced |
| The constructor of `Dialog` on V8, called without `new` | Refused: `The 'Dialog' class constructor cannot be invoked without 'new'`. So no V8 script builds its dialog in the classic style |
| `Dialog.prototype.execute` and `MessageBox.prototype.execute` on the classic engine | Can be replaced and put back. A dialog then runs through the replacement |
| A replaced global constructor on the classic engine, such as `MessageBox = function ...` | The console reports `Critical signal caught (11): Segmentation violation`, at once or in a later script. From then on, classic scripts of that instance fail the same way until it is restarted |
| `Object.getOwnPropertyDescriptor( OpenFileDialog.prototype, "fileName" )` on the classic engine | The same crash signal |
| `new Sizer( true )` | A vertical sizer in either engine. `VerticalSizer` needs an include in the classic engine |
| `VerticalSizer`, `NumericControl` and `NumericEdit` on V8 | Defined without an include. `VerticalSizer` is no property of `globalThis` |
| `pushButton.defaultButton = true` | Accepted in either engine |

**Controls**

| Behaviour | Measured |
|---|---|
| `control.childByPos( x, y )` | The control at that point, as the same object the script created, with the handlers the script gave it. So are `control.parent` and `control.dialog` |
| `control.childByPos( x, y )` at a point inside a `TreeBox` or a `TextBox` | Null. Such a field is made of parts that PixInsight has no object for, and the part is what lies at that point. On its frame, one or two pixels wide, a table gives itself in either engine, and a text box only on V8. So such a field is not found by its place |
| `dialog.childByPos( x, y )` on the classic engine, at a point on the frame of a text box | PixInsight went down, every time and at the same point, in a dialog with two tables, a tool button and a text box, also from a script of a few lines. A smaller dialog with a text box survived the same question, and V8 survived every dialog that was tried. So the hook never asks this on the classic engine |
| `Sizer.prototype.add`, `Sizer.prototype.insert` and `TabBox.prototype.addPage` on the classic engine | Can be replaced and put back, like `execute`. The replacement sees every control that a script lays out, also through `VerticalSizer` and `HorizontalSizer`, and the parts of a `NumericControl`. Scripts after it run as before |
| The global classes of the fields on V8, such as `TreeBox` and `Label`, each replaced by a `Proxy` that notes what is made | Scripts run unchanged, WBPP among them: `new TreeBox( parent )`, a class of the script that extends `TreeBox`, and `instanceof` with either |
| `WeakRef` on V8 | Available. A control that is held this way goes when its dialog does |
| `Object.getOwnPropertyNames()` of a control on the classic engine | Only what the script has put on it, so the objects a script keeps can be walked from its dialog. `Object.prototype.toString` names the class of an object of PixInsight, such as `[object Timer]` |
| `treeBox.isColumnVisible()`, `node.parent` and setting `node.expanded` | Work as the reference in the installation says, in either engine |
| `treeBox.setNodeIntoView()` | Scrolls to a row. On V8 it writes a warning that it is deprecated, and `setNodeIntoViewport()` does the same without one. The classic engine has only the first |
| `node.icon( column )` of a cell that shows a picture | A bitmap of width 0, in the tables of WBPP. `node.toolTip( column )` is empty there. So a cell with a picture cannot be told from an empty one |
| `node.checkable` | True for every row of the tables of WBPP, which show no box to tick |
| `visible` of a control on a tab page that is not shown | False, and true once the page is selected |
| Setting `checked` of a check box, a radio button, a tool button or a group box, `text`, `editText`, `currentItem`, `currentPageIndex`, `currentView`, `value` of a spin box or a slider, or calling `setValue()` | Calls no handler of the script, in either engine |
| Setting `treeBox.currentNode` | Calls `onCurrentNodeUpdated` and `onNodeSelectionUpdated` at once on V8, and neither on the classic engine |
| A table that is the first control of its dialog | Calls `onCurrentNodeUpdated` once when the dialog opens, in either engine |
| A handler that is replaced by another function while a property is set, and put back afterwards | The replacement is what PixInsight calls meanwhile, which is how the hook sees whether PixInsight told the script |
| `onEditCompleted` of an edit field | Also called when the field loses the focus, and when the dialog closes |
| A view that a `ViewList` does not offer, assigned to `currentView` | Not taken: `currentView` stays what it was |
| `passwordMode` of an edit field | Can be switched off by the script while the dialog is open, and the field then shows its text |

**The dialog of WBPP 3.2.0**

Measured in a windowless instance with a few frames loaded, and in one run in a visible one.

| Behaviour | Measured |
|---|---|
| The tables of its tabs | Kept on objects of the script, not on the dialog. Each table of the Calibration tab exists twice in one place: WBPP shows one of the two, and the other one after it has redrawn the tab, as after a change of `Flat:` |
| Its dialog after `Diagnostics`, and after a run | A new dialog object with new controls, so every field has a new id |
| Leaving it with `Exit` | Stores its frames and settings in place of those stored before. An instance that is ended without that stores nothing |

**Message boxes and file choosers**

| Behaviour | Measured |
|---|---|
| Values of PixInsight's constants | `StdButton`: Ok 1, Cancel 2, Yes 3, No 4, Abort 5, Retry 6, Ignore 7, YesToAll 8, NoToAll 9. `StdIcon`: Question 1, Information 2, Warning 3, Error 4. `MouseButton_Left` 1. `StdDialogCode`: Ok 1, Cancel 0 |
| `firstButton`, `secondButton`, `thirdButton` of a `MessageBox` | The codes it was made with. 1 and 0, 0 for one made with a text only. `defaultButton` is 0 and `escapeButton` is -1 unless they were given |
| `result` of a `MessageBox` | Read-only in either engine |
| `fileName` and `fileNames` of `OpenFileDialog` on the classic engine | Read-only, so a path cannot be handed to a script through them |
| An object that forwards to a real `OpenFileDialog`, `SaveFileDialog` or `GetDirectoryDialog` on V8 | Works as a stand-in: properties and `loadImageFilters()` reach the real one, and `execute`, `fileName`, `fileNames` and `directory` can be answered instead |

## WBPP in its automation mode

Measured with WBPP 3.2.0 in a windowless instance on a slot of its own, on up to twelve frames of 26 megapixels from a mono camera and on generated frames of 480 by 320 pixels. Not measured: a color camera.

| Behaviour | Measured |
|---|---|
| `-n=<slot> --automation-mode -r=<script>,<arguments> --force-exit` | Runs the script after the start, then exits with code 0, whatever the script did. Several `-r` run in their order |
| WBPP with `automationMode=true`, `outputDirectory=`, and `dir=` or `file=` for each input | Loads the frames, runs its pipeline without any dialog, and writes masters, calibrated and registered frames, and its logs into the output folder, which it creates |
| What tells a run that started from one that did not | The exit code is 0 either way. A run that started writes `:LOGFILE:<path>:LOGFILE:` to the output of the instance, and its log holds a block `Execution summary`. One that did not start says so in the console, with the reason |
| The output of the instance | Reaches the file it is sent to only when the instance ends |
| `console.beginLog()` before WBPP | Holds the console until WBPP starts its own log at the beginning of a run. PixInsight writes one log at a time |
| No frames, or a value that WBPP cannot read, as `platesolve=maybe` | The run is not started. The console names the reason. No output folder is made for a wrong value |
| An option that WBPP does not know | Ignored without a word |
| The built-in list of options | Not printed by anything on the command line in this version |
| `keywords=NAME`, once per keyword | Groups by that keyword, which takes its value from the path of a frame: folders `session_1` and `night_2` gave `SESSION: 1` and `NIGHT: 2`. Calibration is kept apart by value, and the lights of all values are integrated together |
| `keywords=NAME post` | One calibration for all values, and registration and integration for each value by itself |
| Lights whose keyword value no flat has | Calibrated without a flat. The report says `Master flat: none` |
| Calibration frames whose path has no value for the keyword | Serve the lights of every value: bias, darks and flats in folders without a value calibrated the lights of two nights |
| Calibration frames with a value | Serve only the lights of that value: darks of night 1 left the lights of night 2 without a dark. Lights of that value get them, and not those without a value: with Hα flats of both kinds among the inputs, night 4 got its own and nights 1 to 3 the others |
| The frame that lights are registered to | One for all groups of a run, which WBPP chooses, so the masters of a run lie on one another. The log names it in a line `Best reference frame for registration - auto selection completed: <path>` |
| `bestFrameReferenceMethod=0` with `referenceImage=<path>` | Registers to that frame, and the log says `Best reference frame, manually selected: <path>`. A master of luminance from a run of its own lay 30 and 51 pixels beside the Hα master of another run, and 0.03 pixels beside it once it was given that run's frame |
| What a slot keeps from one run to the next | Nothing that the next run uses: after a run over six filters, a run on the same slot over one filter had the two groups of its own inputs and no other |
| How WBPP tells bias, darks, flats and lights apart | By `IMAGETYP` in the header, with neutral names in one folder. Without that keyword, by the folder name (`BIAS`, `FLAT`, `LIGHT`), and by the file name (`bias_0.fits`): each of the three alone gave the same groups |
| A finished master among the inputs, as a file `masterBias_….xisf` | Taken as that master: flats and lights were calibrated with it, and no master bias was built |
| Lights that have a master dark | Get no master bias: the report says `Master bias: none` for them, and names the bias for the flats |
| The two master lights of a group | One as integrated, and one with `_autocrop` in its name that is smaller: 6220 by 4164 against 6224 by 4168 pixels, and 473 by 316 against 480 by 320 |
| A summary that calls frames excluded although they went in | Once, for generated frames that a run finished within two seconds: the summary listed all six lights as excluded from the integration, with a remark on drizzle data, while the log said that six images were integrated and their drizzle data updated |
| The astrometric solution in such an instance | Fails for every group, and the run goes on: the instance has settings of its own, without the star catalogs of the user's instance |
| A second run into the same output folder | Replaces nothing: the new files get `(1)` in their names. Nothing of the first run is reused |
| Settings | An instance keeps them in a file per slot, so what WBPP has stored for the user's instance is neither read nor changed |
| A disk that fills up during a run | The operations that could not write are listed as failed in the summary, with the reason, and the run completes |
| Time | 31 to 37 seconds for four bias, four flat and four light frames of 26 megapixels, of which about 4 are the start of the instance. 555 seconds for 174 lights and 160 flats with a finished master bias, 307 seconds for 143 lights and 20 flats |
| Against a run through the dialog over the same frames | The same calibration for each of 16 groups of lights, the same nine frames left out, and masters whose median and noise differed by at most 1.4 %, except the median of one master by 6.6 % at the same noise |

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
- Whether a script with a license system or with obfuscated code runs through a file that includes it.
- Whether a script that the user starts from the menu shares the scope of the classic engine with scripts sent by `-x`.
- Dialogs of scripts on Windows and macOS.
- Which button the Enter and Esc keys press in a `MessageBox`, and in a dialog of a script.
- Whether showing a dialog again and closing it ends a wait that a close did not end, which the hook tries in that case.
- Whether `console.beginLog` displaces a log the user has running.
- Whether `ImageIntegration` rewrites existing drizzle files without an overwrite parameter.
- A process started by click while `-x` arrives.
- Prompts when opening RAW files or files with ICC profiles.
- Focus behaviour on X11, Windows and macOS.
- Whether PixInsight asks about a duplicate with `isModified` false when it exits.
