# Run scripts and code

PixInsight's Script menu holds tools that no process offers, such as plate solving with ImageSolver. In this guide, you let the assistant start such a script and read its dialog, decide whether it may also work that dialog, add scripts from your own folders, and decide whether the assistant may run code that it writes itself.

## Prerequisites

- The server runs in [shared mode](../concepts.md#shared-mode-and-worker-mode), which is the default. A script shows a dialog, so it runs in the PixInsight you sit at.
- The image to work on is open.

## How a script differs from a process

A process takes all its settings from the assistant and runs. A script shows its own dialog, and acts on what is set and pressed there. The assistant reads that dialog: every field with its value, and what the script shows in it afterwards, such as a table of results. You set the dialog and press its buttons, unless you [let the assistant do that](#let-the-assistant-work-the-dialog).

| Step | Who |
|---|---|
| Choose the script, and bring the right image to the front | The assistant |
| Read the dialog, and say what to set | The assistant |
| Set the dialog, and press its buttons | You, or the assistant if you allow it |
| Enter a password or a license key | You |
| Read what the script shows, changed, and reported | The assistant |

A few scripts have no dialog. They act on the active image as soon as the assistant starts them.

## Start a script

1. Ask the assistant for the task:

   > Measure the star sizes in the Hα master with FWHMEccentricity.

2. The assistant looks up the script with [`list_scripts`](../reference/tools.md#list_scripts) and starts it with [`start_script`](../reference/tools.md#start_script). The image becomes the active one, and the dialog of the script opens in PixInsight.

3. The assistant reads the dialog and tells you what to set. Set it, and press the button that starts the work.

4. The assistant reads the dialog again with [`get_script_dialog`](../reference/tools.md#get_script_dialog), and so gets results that a script shows nowhere else.

5. Close the dialog. When the script has ended, the assistant gets a report: which images are new, closed, or changed, and what the script wrote to the console.

> [!NOTE]
> While the script is open, nothing else gets through to PixInsight. The assistant can neither look at an image nor measure one until the dialog is closed or the script has finished.

If the dialog is cancelled, the script ends as well. The report then shows that nothing has changed.

The assistant can start one script at a time. A step that a script adds to the history of an image can be undone like any other. If a script changes pixels without a step in the history, the report says so, because undo cannot take that back.

The assistant sees a dialog as a list of fields in reading order: labels, text fields, check boxes, lists, numbers, tables, and buttons, each with its value. A table comes with its rows, also those inside other rows, and a long table or a long text can be read in full, one field at a time. The assistant can also ask for a picture of the dialog, for what a list cannot say, such as a preview that the script draws, or a cell of a table that shows a picture. A text field that hides what is typed, as for a password, is the exception: the assistant never gets its content, not in the picture either.

## Let the assistant work the dialog

The assistant can also set the fields and press the buttons itself, the way you would, while the dialog is on your screen. This is off by default.

> [!WARNING]
> An assistant that works a dialog can make a script do anything that you could make it do there: write files, replace them, start a program, or run for hours. No history records that, and the server cannot check it, because only the script knows what its fields and buttons do. Turn this on if you follow what the assistant does.

To turn it on, set [`PIXINSIGHT_MCP_SCRIPT_DIALOGS`](../reference/configuration.md) to `operate`:

```json
{
  "mcpServers": {
    "pixinsight": {
      "command": "node",
      "args": ["/absolute/path/to/PixInsightMCP/dist/index.js"],
      "env": { "PIXINSIGHT_MCP_SCRIPT_DIALOGS": "operate" }
    }
  }
}
```

| Value | The assistant |
|---|---|
| `read` | Reads the dialog and tells you what to set. You work it, and you answer what the script asks. This is the default. |
| `operate` | Reads the dialog and works it with [`use_script_dialog`](../reference/tools.md#use_script_dialog). |
| `off` | Starts the script and waits. It learns nothing about the dialog. |

With `operate`, this is what to expect:

- **Each step shows.** A value appears in the dialog as the assistant sets it, and the Process Console lists every step in a line that starts with `MCP:`. You can take over at any moment.
- **A script keeps what was set.** A script can store its settings when it is left, as WBPP does with its list of frames. What the assistant set there is what you find the next time, in place of what you had.
- **What you could not do, the assistant cannot do either.** A field that is greyed out stays out of reach until the setting that enables it is changed.
- **Questions.** When a script asks something in a message box, the question appears in a window with the same text and buttons, and a line that says the assistant can answer as well. Either of you answers it. A script that runs on the V8 engine of PixInsight asks for files the same way: the assistant answers with a path, or you choose **Browse…** and pick the file as usual.
- **Passwords and license keys.** The assistant cannot fill in a field that hides what is typed. Type such a value into the dialog yourself. A key that a script asks for in an ordinary text field looks like any other text: the assistant is told not to enter keys, but the server cannot tell such a field apart.
- **Files and programs.** The server holds back one thing: when a script asks where to write, it gets a file that already exists only if you agreed. What a script does with a folder, a field, a check box, or the answer to a question, the server cannot know. There, the assistant is told to ask you first.

> [!TIP]
> If a script does not behave as it does from the Script menu, ask the assistant to start it plainly. The script then runs exactly as PixInsight starts it, and the assistant learns nothing about its dialog.

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

- **Windows of PixInsight's own.** A file chooser of a script for the older engine of PixInsight, and any other window that a script opens outside its dialogs, such as a process window, is yours to work.
- **What only a mouse can do.** The assistant sets values and presses buttons. Dragging, and a click into a control that PixInsight draws itself, such as the plot of a curve, are yours.
- **No scripts in worker mode.** The own instance has no window, and you could not see what a script asks there.
- **Batch preprocessing has a way of its own.** WBPP runs without its dialog, in an instance of its own: see [Preprocess raw frames](preprocess-raw-frames.md). The assistant works the dialog of WBPP only where a master has to be assigned by hand.

## Next steps

- [Look up the script and code tools](../reference/tools.md#list_scripts)
- [Handle dialogs, long jobs, and crashes](dialogs-jobs-crashes.md)
