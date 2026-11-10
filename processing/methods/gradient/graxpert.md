---
title: Extract the background with GraXpert
summary: The GraXpert process, AI-based or sample-free, when there is no reference data. The user has to allow the program first.
status: experimental
evidence: One comparison on IC 1871. The AI model removed real signal in diffuse OIII, and the sample-free model followed the nebula.
requires: [GraXpert]
parameters: [GraXpert.appPath]
applies_to: [linear]
---

## Steps

1. Ask the user where the GraXpert program is. The `appPath` parameter must point to it. The GraXpert script of PixInsight keeps the path in `~/.local/share/GraXpertScript/GraXpertPath.txt`.
2. The server only runs programs the user has allowed. If `run_process` answers `blocked_parameter`, ask the user to add the path to `PIXINSIGHT_MCP_ALLOWED_PROGRAMS` in the server configuration. Do not try to get around this.
3. Run the process on a duplicate. Look up the settings for the model and for the sample-free mode with `describe_process`: this guide has not verified them.

## Check the result

- With an empty or wrong `appPath` the process fails silently: it reports success in under a second, with `Exit error code 255` in the log, and `pixelsChanged` is `false`.
- Look at the background model, as `stages/gradient` describes. Dark holes where diffuse nebulosity was mean that it removed signal.

## Limits

Not verified with an allowed program through this server: the comparison above ran before programs had to be allowed.
