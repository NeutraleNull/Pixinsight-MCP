# Run scripts and code

PixInsight's Script menu holds tools that no process offers, such as plate solving with ImageSolver. In this guide, you let the assistant start such a script for you, add scripts from your own folders, and decide whether the assistant may run code that it writes itself.

## Prerequisites

- The server runs in [shared mode](../concepts.md#shared-mode-and-worker-mode), which is the default. A script shows a dialog, so it needs the PixInsight you sit at.
- The image to work on is open.

## How a script differs from a process

A process takes all its settings from the assistant and runs. A script shows its own dialog, and PixInsight offers no way to fill in that dialog from outside. So you share the work:

| Step | Who |
|---|---|
| Choose the script, and bring the right image to the front | The assistant |
| Set and confirm the dialog | You |
| Read what the script changed and reported | The assistant |

A few scripts have no dialog. They act on the active image as soon as the assistant starts them.

## Start a script

1. Ask the assistant for the task:

   > Plate-solve the Hα master.

2. The assistant looks up the script with [`list_scripts`](../reference/tools.md#list_scripts) and starts it with [`start_script`](../reference/tools.md#start_script). The image becomes the active one, and the dialog of the script opens in PixInsight.

3. Set the dialog the way the assistant suggests, and confirm it.

4. When the script has ended, the assistant gets a report: which images are new, closed, or changed, and what the script wrote to the console.

> [!NOTE]
> While the script is open, nothing else gets through to PixInsight. The assistant can neither look at an image nor measure one until you close the dialog or the script has finished.

If you cancel the dialog, the script ends as well. The report then shows that nothing has changed, and the assistant asks you how to go on.

The assistant can start one script at a time. A step that a script adds to the history of an image can be undone like any other. If a script changes pixels without a step in the history, the report says so, because undo cannot take that back.

## Use scripts from your own folders

The assistant can start the scripts that PixInsight ships, including those installed through update repositories. To add scripts you keep elsewhere, list their folders in [`PIXINSIGHT_MCP_SCRIPT_DIRS`](../reference/configuration.md):

```json
{
  "mcpServers": {
    "pixinsight": {
      "command": "node",
      "args": ["/absolute/path/to/PixInsightMCP/dist/index.js"],
      "env": { "PIXINSIGHT_MCP_SCRIPT_DIRS": "/home/you/astro/scripts" }
    }
  }
}
```

Use absolute paths. The server looks for `.js` files with a `#feature-id` directive, in each folder and up to two folders below it. A script in your folder cannot take the place of a shipped one with the same name.

The server reads your folders once, when it starts. After you add or change a script, restart the server, which usually means restarting your assistant. Until then, the assistant does not see an added script, and a changed one is refused with [`script_changed`](../reference/errors.md#requests).

> [!WARNING]
> The assistant can start every featured script in these folders, without asking you first. And whoever can write to such a folder can run code in PixInsight from the next start of the server on. So list only folders whose scripts you trust, and never one that the assistant can write to, such as a project folder you work in together.

## Scripts the assistant cannot start

| Menu | Reason |
|---|---|
| Instrumentation | Controls physical equipment such as cameras and mounts |
| Development | Tools for developers, such as the one for code signing keys |

## Let the assistant run its own code

With code of its own, the assistant can do what no tool offers, such as copying an astrometric solution or arranging windows. The code runs inside PixInsight with its scripting API, on the V8 engine.

> [!WARNING]
> Code can do anything a script in PixInsight can: read, write, and delete files, start programs, use the network, change the settings of PixInsight, and freeze it. None of the checks that protect your work apply to it. Turn this on only if you follow what the assistant does.

This is off by default. To turn it on, set [`PIXINSIGHT_MCP_ALLOW_CODE`](../reference/configuration.md) to `1`:

```json
{
  "mcpServers": {
    "pixinsight": {
      "command": "node",
      "args": ["/absolute/path/to/PixInsightMCP/dist/index.js"],
      "env": { "PIXINSIGHT_MCP_ALLOW_CODE": "1" }
    }
  }
}
```

The assistant then has the tool [`run_code`](../reference/tools.md#run_code), in shared mode and in worker mode. Each response reports which images the code made, closed, or changed. It does not show what the code did to files, settings, or anything else outside the open images. Only the assistant's own code runs this way. A script from the Script menu still needs `start_script`.

## Limits

- **No unattended scripts.** PixInsight refuses to run a script with parameters from another script, so the assistant cannot fill in a dialog for you.
- **No scripts in worker mode.** The own instance has no window, and a dialog there would block it for good.
- **No batch preprocessing yet.** WBPP has an automation mode of its own, which the server does not use yet.

## Next steps

- [Look up the script and code tools](../reference/tools.md#list_scripts)
- [Handle dialogs, long jobs, and crashes](dialogs-jobs-crashes.md)
