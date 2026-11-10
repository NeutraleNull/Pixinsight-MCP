# Preprocess raw frames

In this guide, you let the assistant turn raw frames into masters: it calibrates your lights with bias, dark, and flat frames, registers them, and integrates one master per filter. The work is done by WeightedBatchPreprocessing (WBPP), which the server runs without its dialog.

## Prerequisites

- The frames are on a disk that the computer with PixInsight can read, as your capture program wrote them, with the kind of each frame in its FITS header.
- A folder for the results with plenty of room. WBPP writes every light twice more, as calibrated and as registered files.
- The server runs in [shared mode or worker mode](../concepts.md#shared-mode-and-worker-mode), and PixInsight is running: the server asks it where WBPP is installed.
- No folder or file of the frames has a character in its name that means something on a command line, such as a comma, a bracket, or a quote. A space is fine.

## How a run works

The server starts a PixInsight instance of its own for the run, which ends when the run is over. You can go on working in your PixInsight meanwhile, and the frames and settings that your WBPP has stored stay as they are. On Linux the instance has no window.

WBPP decides by itself which calibration frames belong to which lights, with its default settings. The assistant cannot change that choice in this kind of run. It reads afterwards what WBPP chose, and tells you.

## Start a run

1. Tell the assistant where the frames are and where the results go:

   > Preprocess the frames in /data/NGC7000. Write the results to /data/NGC7000-work.

2. The assistant opens a frame of each kind and compares what the files say: gain, offset, exposure, and filter. It asks you for what the files do not say, and tells you if something does not fit, such as a bias with another offset than the lights.

3. The assistant starts the run with [`start_preprocessing`](../reference/tools.md#start_preprocessing), and tells you how far it is when you ask. A run takes from under a minute for a few frames to hours for many.

4. When the run is over, the assistant reports what each group of frames was calibrated with, which frames WBPP left out, and where the masters are. It then opens the masters and checks them.

> [!IMPORTANT]
> A group of lights for which WBPP found no flat is calibrated without one, and the run still succeeds. The assistant reads this from the result. If its report does not mention flats, ask.

## Keep nights apart

If nights have flats of their own, or the camera was turned between them, their frames must not be calibrated together. WBPP keeps frames apart by a grouping keyword, whose value it takes from the path of each file.

1. Put the frames of each night into a folder named after the keyword and the night, such as `night_1` and `night_2`. Each folder holds the lights and the flats of that night.
2. Tell the assistant to group by that word:

   > Preprocess /data/NGC7000, and keep the nights apart: the folders are night_1 to night_4.

| Keyword | Calibration | Integration |
|---|---|---|
| `NIGHT` | Each night with its own calibration frames | One master per filter, from all nights |
| `NIGHT post` | All nights with the same calibration frames | One master per filter and night |

Calibration frames for all nights, such as a bias, go into a folder without the word in its name. A night without flats of its own, and with none in such a folder, gets none this way.

To calibrate a night with the flats of another night, tell the assistant which flats to use. It then stacks those lights in a run of their own, with exactly these flats, and registers them to the same frame as the first run, so that all masters lie on one another.

## Limits

- **Finished masters.** If your raw bias or dark frames do not fit the lights, name a finished master instead: it goes in as a file, and WBPP uses it as it is.
- **No astrometric solution.** The instance of a run has settings of its own, without your star catalogs, so the assistant turns that step off. It can solve the masters afterwards in your PixInsight, with ImageSolver.
- **No cosmetic correction without darks.** WBPP needs a master dark for it, and says so in its report.
- **One run at a time** per session.
- **A run goes on if you close the assistant.** It ends by itself, and its log in the folder `logs` of the results says how. To stop a run, ask the assistant: the files written so far stay.

## Next steps

- [Process an image](process-an-image.md)
- [Look up the tool](../reference/tools.md#start_preprocessing)
