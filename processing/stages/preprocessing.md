---
title: Preprocess raw frames
summary: From raw lights and calibration frames to linear masters, with the frames checked before the run and the result checked after.
---

Preprocessing calibrates the lights with bias, darks and flats, registers them, rejects outliers, and integrates one linear master per group of lights: per filter and exposure for a mono camera. A color camera also needs its frames debayered, which was not tried here. A run takes minutes to hours, so a mistake in the setup costs a whole run. Check before you start one.

## Before the run

1. Find out what the user has: read `practices/equipment`, and ask which calibration frames belong to which lights if the folders do not say it.
2. Open one frame of each kind, filter and night with `open_image`, compare them with `get_image_metadata`, and close them again:
   - **Gain and offset** of bias, darks and flats against the lights. A bias with another offset shifts every calibrated frame by the difference. In one run a new bias had offset 256 and the lights 400, on narrowband frames whose sky lay only 8 to 60 ADU above the pedestal.
   - **Exposure, temperature, gain and offset** of darks against the lights.
   - **The filter** of each flat against the name of its file and folder, for a camera with filters.
3. Check the flats of each series with `get_image_stats` on a few of its frames: no frame near saturation, and no jump within the series. In one run, flats taken at dawn rose by 3 % per frame up to saturation, and their master showed arcs of stray light.
4. Flats belong to the optical train as it was: filter, position of the camera, focus. Where lights have no flats of their own, propose a set, say why, and ask the user.
5. Say what is missing, and what that costs. Without darks, hot pixels leave only where the frames were dithered or the pointing changed between nights. Without flats, dust and vignetting stay.

## The run

Start with `methods/preprocessing/wbpp-unattended`. WBPP then matches the calibration frames to the lights by itself, without its dialog, and the result says what it matched. PixInsight has to be running when the run is started.

Lights that need the calibration frames of another night are run by themselves, as that guide describes. Use `methods/preprocessing/wbpp-dialog` only for what the unattended way does not take, such as a setting that has to be made in the dialog.

## After the run

- Read the report of the run for every group: which master bias, dark and flat it got. In one run, two groups of lights were left without a flat, and only the report said so.
- Count the frames per master against what went in, and read why frames were excluded.
- Open each master, and look at the corners and at one dust shadow under a strong stretch with `get_preview`: a bright or dark ring means that the flat did not fit.
- Then check the masters as `stages/inputs` describes.
