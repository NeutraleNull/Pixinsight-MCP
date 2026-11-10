---
title: Preprocess with WBPP, unattended
summary: One call of start_preprocessing runs WBPP without its dialog, in an instance of its own. For frames that WBPP can match to their calibration frames by itself.
status: experimental
evidence: Runs with WBPP 3.2.0 on PixInsight 1.9.6 on Linux. A stack of 317 lights and 180 flats of a mono camera in seven filters over four nights, with a finished master bias, whose masters matched those of a run through the dialog. Generated frames with bias, darks and flats in folders for two nights. Not tried with a color camera, or on Windows and macOS.
---

`start_preprocessing` starts WBPP in its automation mode. The run asks nothing, and uses a PixInsight instance of its own. PixInsight has to be running when the run is started, because the server asks it where WBPP is installed. After that the user's PixInsight is free, and the frames and settings that the user's WBPP has stored stay as they are.

WBPP matches calibration frames to lights by itself, with its default settings. Nothing in this mode assigns a master by hand, and nothing shows the groups before the run: `groups` in the result says what each group got. Lights that need other calibration frames than WBPP gives them are run by themselves: see step 3. `methods/preprocessing/wbpp-dialog` is for what neither does.

## Steps

1. Check the frames first, as `stages/preprocessing` describes, and ask the user for an output folder outside the folders with the frames. Each light is written twice more, as large files, so ask for a disk with room.
2. Name the folders with the frames in `inputs`. WBPP reads a folder with everything below it, and tells bias, darks, flats and lights apart by `IMAGETYP` in the header. Where the header does not say it, the folder name or the file name did: `BIAS`, `bias_0.fits`. Compare the frame counts in `groups` with what the user took.
   - A finished master goes in as a file: `masterBias_offset.xisf` among the inputs was used as the master bias, and none was built. Use this when the raw calibration frames do not fit the lights and the user has a master that does.
   - Folders hold what must not go in, such as flats that the check before the run ruled out. Then name the files that go in, one by one, up to 500.
3. Decide whether frames must be kept apart: nights with their own flats, two cameras, a camera that was turned. If so, name a keyword in `keywords`.
   - WBPP takes the value of a keyword from the path of each frame: folders `session_1` and `night_2` gave `SESSION: 1` and `NIGHT: 2`. No other form of a folder name was tried, and neither was a keyword in the header. If the user's folders are named otherwise, ask the user. Never rename or move frames yourself.
   - A keyword alone keeps the calibration apart, and still integrates the lights of all its values into one master per filter.
   - With `post` behind it, as `NIGHT post`, the calibration is shared, and each value is registered and integrated by itself. `prepost` was not tried.
   - Calibration frames whose path has no value serve the lights of every value: bias, darks and flats did, in one run each. Those with a value serve only the lights of that value, and are preferred there: of two sets of Hα flats, the night that had its own got its own, and three other nights got the set without a value. So lights whose value has no flat, and no flat without a value either, get no flat: in one run, the lights of a night without flats were calibrated with the bias alone.
   - Lights that need the calibration frames of another value cannot get them by a keyword. Run them by themselves, after the others: without the keyword, with exactly those calibration frames among the inputs, into an output folder of their own. Pass the first entry of `registrationReferences` of the first run as the option `referenceImage`, together with `bestFrameReferenceMethod: 0`. Without that, the masters of the two runs do not lie on one another: 30 and 51 pixels apart in one run, and 0.03 pixels with it.
4. Pass `options: { "platesolve": false }`, and no other option unless the user names one. In the instance of a run the astrometric solution failed, because that instance has settings of its own, without the star catalogs of the user's PixInsight. Solve the masters afterwards, in the user's PixInsight.
5. Call `start_preprocessing`. It comes back with a job id while WBPP works. Wait with `get_job` and the longest `waitMs` it takes, again and again: `step` says what WBPP is at. Twelve frames of 26 megapixels took 36 seconds. 174 lights with 160 flats took 9 minutes and ten calls of `get_job`, 143 lights with 20 flats took 5 minutes.
6. Read the result before anything else is done with the masters: see below.

## Check the result

- `summary` says how many operations completed and failed, each failed one with its reason, and how many frames were left out.
- `groups` says what each group was calibrated with, and how many frames it has. Lights that have a master dark show `masterBias: none`, because the dark holds the bias: that is no fault. `masterFlat: none` for a group of lights means that it was not flat-fielded, and the hint of the result says so. If the user has flats for these lights, WBPP did not match them: correct the inputs or the keyword, and run again into a new folder. If there are none, say what that costs, as `stages/preprocessing` describes.
- A result without `groups` means that the report of WBPP could not be read. Then nothing is known about the calibration: say so, and do not assume that it went well.
- `problems` holds what WBPP found before it started, such as cosmetic correction that needs a master dark.
- `registrationReferences` names the frame that the lights were registered to. All masters of one run lie on one another. A later run lies on them only if it is given that frame: see step 3.
- `masters` lists the masters of this run. Each master light comes twice: as it is, and with `_autocrop` in its name, cut to what all its frames cover: 6220 by 4164 against 6224 by 4168 pixels in one run. Go on with the cropped one unless the user wants the whole field. Check them as `stages/preprocessing` describes.
- If `summary` calls frames excluded, compare with the frame count of the group and with `numberOfImages` in `log`. Once, a run over small generated frames listed all its lights as excluded with a remark on drizzle data, and had integrated all of them.
- A run that WBPP did not start comes back as the error `not_started`, with the reason: no frames, or a value of an option that it cannot read.

## Limits

- **No assignment by hand within a run,** and no look at the groups before the run. Step 3 has the way around the first.
- **Options are not checked.** WBPP ignores a name it does not know without a word, and only refuses a value it cannot read. Only `platesolve` was tried. Options that make WBPP run code are refused: those that name a script file, and the custom formula of its frame selection.
- **A name with a character that means something on a command line is refused** with `invalid_path`: a comma, a bracket, a quote and the like. That includes the files that WBPP itself names with `(1)`. Tell the user which name it is: the tool cannot take it in any spelling.
- **A second run into the same folder** replaces nothing and adds `(1)` to the names of its files. Nothing of the first run is reused, so it takes as long. A new folder keeps the runs apart.
- **A run goes on if the assistant's session ends.** It ends by itself, and its log in the folder `logs` of the output folder says how. `cancel_job` stops it, and keeps the files it has written. `get_status` shows a run that is under way, with its job id. A later session does not know that id: read the log instead.
- **One run at a time** per session.
