---
title: Correct gradients
summary: Remove background gradients from linear data without removing real faint nebulosity.
---

The danger is not a remaining gradient but removing real faint nebulosity. Judge a correction by its **background model**, not by how clean the result looks.

Work on linear data, before any stretch, and on duplicates. Correct each channel on its own, with the method that suits it.

## Choose a method

- **A band with all-sky reference data** (MARS covers Hα and OIII in many fields): use the reference. It can tell real faint signal from gradients.
- **A band without a reference,** such as SII: use a plane, limited to sky brightness, and then check its direction. A plane cannot follow nebula shapes, but it can still remove real signal.
- **No reference data, and a lot of empty sky:** a sample-free or automatic model. Check the model closely.
- **Hand-placed samples** (`DynamicBackgroundExtraction`) are hard through the tools: they need sample positions and values.

In one field, an AI-based model removed real signal and left dark holes in diffuse OIII, and sample-free models followed the nebula. Other fields can differ, so compare when the result matters.

## Judge a correction

1. Keep the background model, if the method can produce one.
2. Look at the model with a fixed stretch. A good model is smooth and low in amplitude. A model that shows nebula shapes has taken signal out of the image.
3. Compare the results under the same stretch (`stretchFrom`), never under separate automatic stretches.
4. Measure the sky afterwards in several empty patches. See `practices/measure`.

A strong drop in MAD compared to other methods is a warning, not an achievement.

## Check the direction of a plane

A plane on a band without a reference can run against the real gradient, and then it removes faint nebulosity on one side.

1. Make a map of what each correction did: `0.5+10000*(corrected-raw)`, and look at it for each channel.
2. Compare directions. Channels corrected against a reference show the real sky gradient.
3. Measure the sky on both sides of the image, in the plane's channel and in the reference channels.

In one run, the SII plane ran against both reference channels and pulled the right side below the left, where Hα and OIII lay above it. Taking back 55 % of the plane brought the share of very dark samples in stretched SII from 0.27 % down to 0.014 %. That share was estimated from the SII/Hα ratio in the image center, so it is an assumption: say so.

## Afterwards

Check that the sky levels of the channels fit together before combining them. Remaining differences belong to the stretch, not to the gradient correction.
