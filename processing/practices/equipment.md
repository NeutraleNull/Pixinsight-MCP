---
title: Know the equipment
summary: Camera, telescope and filters decide several steps. Read what the files say, and ask the user for the rest before you start.
---

Several steps depend on what took the data, and no image shows it. A wrong guess does not fail: it gives a plausible result that is wrong, and costs a second round once the user sees it.

## Find out before the first step

1. Read `get_image_metadata` of one frame or master per filter. Look for the camera (`INSTRUME`), the filter (`FILTER`), the focal length (`FOCALLEN`), the pixel size (`XPIXSZ`), and exposure, gain, offset and sensor temperature.
2. List what you need and the files do not say. Typical gaps:

   | You need | For |
   |---|---|
   | The make and bandwidth of each narrowband filter | Flux calibration, as in `methods/gradient/mars` |
   | The make of the RGB and luminance filters | A color calibration against filter curves |
   | Color or mono camera, and its sensor | Choosing the workflow, and the curve of the sensor |
   | Focal length and pixel size, if no keyword has them | Plate solving, and judging star sizes |
   | Whether the frames were dithered, and which calibration frames belong to which night | `stages/preprocessing` |

3. Ask the user for all of it in one message, before the long work begins. A user who is asked at the end has to wait for a second run.

A filter name in a keyword is what the capture program was told, often a single letter. It names the slot of the filter wheel, not the make or the bandwidth.

## If nobody can answer

If the user has said to work without questions, or does not answer:

- Choose the step that depends least on the unknown. A calibration against idealized filter curves is a guess, and a neutral background with a visual check is honest.
- Name each assumption with its value at the top of the report, not among the details, and say which result it affects.
- Save the stage before that step with `save_image`, so that a correction means repeating one step and not the whole run.

## Keep the answers

What the user tells you holds for every later session with the same equipment. Offer to write it down as a guide of the user's own with the ID of this one: a file `practices/equipment.md` in a folder of their own guides replaces this text, for every assistant that works with this server. Then this guide lists their equipment. Read it first, and still ask for what it does not say.

In one run on IC 5070, the headers held single letters for the filters and no make. The assistant assumed 6.5 nm for the narrowband filters and idealized curves for RGB, and said so only in its report, when the run was over.
