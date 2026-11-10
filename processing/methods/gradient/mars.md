---
title: Correct gradients against MARS reference data
summary: MultiscaleGradientCorrection with the all-sky MARS data, for bands the data covers, such as Hα and OIII.
status: tested
evidence: Two runs on IC 1871 at 752 mm, Hα and OIII, PixInsight 1.9.6.
requires: [MultiscaleGradientCorrection, SpectrophotometricFluxCalibration]
parameters: [SpectrophotometricFluxCalibration.narrowbandMode, SpectrophotometricFluxCalibration.grayFilterWavelength, SpectrophotometricFluxCalibration.grayFilterBandwidth, SpectrophotometricFluxCalibration.generateGraphs, MultiscaleGradientCorrection.gradientScale]
applies_to: [narrowband, mono, linear]
---

## Steps

1. Find the `.xmars` database files. If you do not know where they are, ask the user.
2. Run `SpectrophotometricFluxCalibration` on the image first. Otherwise the correction fails with `The target image lacks flux calibration metadata (PCL:SPFC:ScaleFactors)`. For narrowband data set `narrowbandMode: true`, `generateGraphs: false`, the line in `grayFilterWavelength` (Hα 656.3, OIII 500.7, SII 671.6 nm), and the filter bandwidth in `grayFilterBandwidth`. Ask for the bandwidth before you start, as `practices/equipment` describes. If you have to assume one, say so.
3. Run `MultiscaleGradientCorrection` with its automatic scale factors.
4. Compare `gradientScale` 1024, the default, with 2048. In one field, 2048 gave a smoother Hα model without a nebula-shaped hole, at least as flat a sky, and an amplitude of 2.3e-5 instead of 4.0e-5.

## Check the result

- Read the scale factor and the correlation from `log`. They are not in `outputs`. In two runs they were 1.60 with 0.967 for Hα, and 1.63 with 0.972 for OIII.
- A low correlation means that the reference does not fit this band: a SII image against Hα data gave 0.74, and a model showing Hα structure.
- Look at the model, and measure the sky in several patches, as `stages/gradient` describes.

## Limits

- The flux calibration needs the Gaia DR3/SP database set up in the PixInsight instance that runs it. An instance the server started for itself has its own settings, and failed with `Database files not available`.
- The flux calibration writes only metadata, so `pixelsChanged` is `false` and `metadataChanged` is `true`.
