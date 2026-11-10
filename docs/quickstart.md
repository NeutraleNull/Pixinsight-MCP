# Quickstart: Process your first image with an assistant

In this quickstart, you connect the server to PixInsight, open an image, apply a process through the assistant, and undo it again. It takes about five minutes.

## Prerequisites

- PixInsight 1.9.4 or later. The server needs the V8 scripting engine that came with that version.
- Node.js 20 or later.
- An assistant that speaks the Model Context Protocol (MCP), such as Claude Code, opencode, Codex CLI, or Gemini CLI, with a model that can look at images.
- An image file to work with. A linear XISF or FITS master works best.

> [!NOTE]
> PixInsight's standard install location is used by default. If yours differs, set [`PIXINSIGHT_EXECUTABLE`](reference/configuration.md).

## Step 1: Get the server

Download `mcp-server-for-pixinsight-<version>.tgz` from the [latest release](../../../releases/latest), and note where you saved it. There is nothing to install: your assistant starts the server from this file.

To build the server from source instead, see [Build from source](../README.md#build-from-source).

## Step 2: Connect your assistant

**Claude Code:** Run this once, with the full path to the file:

```bash
claude mcp add --scope user pixinsight -- npx -y --package /full/path/to/mcp-server-for-pixinsight-<version>.tgz mcp-server-for-pixinsight
```

**Other assistants:** Follow [Connect an assistant](guides/connect-an-assistant.md), which has the configuration for opencode, Codex CLI, Gemini CLI, and any other MCP client.

## Step 3: Start PixInsight and check the connection

1. Start PixInsight the way you usually do, and close any dialogs it shows.

2. Ask the assistant:

   > Check the connection to PixInsight.

The assistant calls [`get_status`](reference/tools.md#get_status). A healthy response names your instance:

```json
{
  "mode": "shared",
  "instances": [{ "slot": 1, "pid": 1930908, "crashed": false }],
  "target": { "slot": 1, "pid": 1930908 },
  "pixinsight": { "version": "1.9.6", "build": 1713, "instance": 1, "automationMode": false, "processes": 121 },
  "queue": { "queued": 0, "active": null }
}
```

## Step 4: Open an image and look at it

Ask the assistant:

> Open /path/to/master.xisf and show me a preview.

The image appears in PixInsight. It is a copy without a file path, so a plain **Save** in PixInsight cannot overwrite your file.

The assistant sees a stretched JPEG. Your image and its display in PixInsight stay as they are, so linear data still looks dark in the PixInsight window.

## Step 5: Apply a process

Ask the assistant:

> Run Convolution with a sigma of 2 on the image and tell me what changed.

The change appears in PixInsight and in the **History Explorer**. The assistant reads the response of [`run_process`](reference/tools.md#run_process), which includes the values that were applied, whether the pixels changed, the new statistics, and the log of the process.

## Step 6: Undo it

Ask the assistant:

> Undo that.

You can also use the undo button in PixInsight, because both work on the same history.

> [!NOTE]
> If the step ran through a mask, undo it through the assistant. PixInsight's own undo brings the mask back. See [Use a mask](guides/process-an-image.md#use-a-mask).

## Clean up

Close the image in PixInsight, or ask the assistant to. The assistant refuses to close an image with unsaved work unless you agree.

## Next steps

- [Process an image](guides/process-an-image.md): the techniques that give the best results.
- [How the server works](concepts.md): what happens behind each request.
- The processing library gives the assistant workflows and methods from real runs. It reads them with [`get_guide`](reference/tools.md#get_guide). To add a method of your own, see [Add a processing method](guides/add-a-processing-method.md).
- [Tool reference](reference/tools.md): everything the assistant can do.
