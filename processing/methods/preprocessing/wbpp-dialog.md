---
title: Preprocess with WBPP through its dialog
summary: Work the dialog of WBPP step by step, where a master has to be assigned by hand. Needs leave to work script dialogs, and the user's PixInsight for the run.
status: experimental
evidence: One run with WBPP 3.2.0 on PixInsight 1.9.6. A mono camera, seven filters, four nights, bias and flats. Not tried with darks or a color camera.
---

This is the way for what `methods/preprocessing/wbpp-unattended` cannot do: assigning a master to a group by hand, and looking at the groups before the run. WBPP is worked like a user works it, with `start_script` and `use_script_dialog`. Without `use_script_dialog`, tell the user what to set from these steps. The fields are named here as WBPP 3.2.0 labels them. Read the dialog before each step: another version can differ.

## Steps

1. Ask the user first. WBPP opens with the frames and settings of its last use, and stores what it holds when it is left, in place of what was stored. And until the script has ended, no other tool gets through to PixInsight.
2. Ask the user for an output folder that exists, and for the paths of the frames if you cannot list files yourself. In one run, WBPP did not make a missing folder, and said so only in its diagnostics.
3. Start `WeightedBatchPreprocessing`, and set the field below `Output Directory`.
4. Load each kind of frame the user has: bias, darks, flats, lights. On its tab, press `Clear` if frames of an earlier use are listed. Then press the button with its name at the bottom, and answer the file chooser with a list of absolute paths, in several answers if they are many: 120 paths in one answer worked. In one run, a master bias was loaded this way and listed as a master. After lights, a dialog says how many were added: compare that with what you sent, and press `OK`.
5. Decide with the user what must not be mixed. Frames that need calibration frames of their own are told apart by a grouping keyword: nights with their own flats, two cameras, a camera that was turned. Type the keyword into the field below `Grouping Keywords`, and press the button next to it, whose help says that it adds a keyword. In one run the folders were `session_1` to `session_4`, and the keyword `SESSION` took its value from that part of the path. Other layouts were not tried. Without a reason to separate, add none.
6. On the tab `Calibration`, one table per kind lists the groups. Read every table: the groups have to split as meant, each with the filter, exposure and binning you expect. If they do not, ask the user.
7. Check what calibrates each group. Select every row of the tables of flats and of lights by its `row`, then read the fields beside the table, such as `Dark:` and `Flat:`, and the box of warnings. With `Auto`, WBPP chooses, and a group can end up with nothing: in one run, the lights of nights without flats of their own got none. To assign a master, set the field to its entry, by its text. For a color camera, check the `CFA images` settings with the user: that was not tried.
8. The other settings are those of the last use, on the tabs `Lights` and `Post-Calibration`. Tell the user what the run will do, and ask where that does not fit this data. A check box `Interactive` stands for a step in which WBPP asks a person during the run. That was not tried: switch it off, unless the user wants to decide there.
9. Press `Diagnostics`, and read its text in full with `get_script_dialog` and `field`. Remove every cause of a line that starts with `Error`. Tell the user of the warnings that change the result.
10. Press `Run`. If a dialog with messages and the button `Continue` follows, read it, then press `Continue`. The dialog `WBPP Execution Monitor` lists each operation with its status. Wait with `get_script_dialog` and `until: "DONE"`, again while the answer says that the field is not there yet.
11. Press `DONE`, and read the `Smart Report` in full: see below. Leave WBPP with `Exit` only when the report is right. If WBPP then asks whether to purge its cache, answer `no`, unless the user wants it emptied.

## Check the result

- In the `Smart Report`, every group names its `Master bias`, `Master dark` and `Master flat`. `none` where one was meant is a mistake of the setup. Press `DONE`, correct it in the dialog that comes back, and run again before you leave WBPP. In one run, the second and third run took 12 and 4 minutes after 16, because WBPP reused what it had.
- The report and the log say how many frames were excluded, and why. In one run it was 9 of 317. If you can read files, the log is in the folder `logs` of the output folder.
- The masters are in the folder `master`, as `masterLight_…` with filter and exposure in the name.
- Then check as `stages/preprocessing` describes.

## Limits

- **Pictures cannot be read.** The columns `STATUS`, `Bias`, `Dark` and `Flat` of the tables show marks, not text. Read the fields beside the table, or the dialog with `picture`.
- **An assignment by hand can get lost.** In one run, a flat that was assigned by hand did not survive leaving WBPP and starting it again. Assign, check and run without leaving WBPP in between.
- **Entries move.** In one run, the order of the entries of `Flat:` changed when WBPP rebuilt its dialog. Choose by text, never by number, and read the field again afterwards.
- **No darks, no cosmetic correction.** In one run without darks, WBPP warned for every group that cosmetic correction needs a master dark, and skipped it.
- **A second run adds files.** In one run, a second run into the same folder replaced nothing and added `_1` to the names. Read from the report which files belong to the last run.
- **A run is long.** 317 frames of 26 megapixels took 16 minutes. A mistake in the setup costs a whole run, so check before you press `Run`.
- **Not tried:** darks, a color camera, the buttons `Directory`, `Files` and `Add Custom`, the presets, drizzle, and a run with an `Interactive` step.
