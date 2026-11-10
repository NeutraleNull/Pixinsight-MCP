# How the server works

The server connects an assistant to a running PixInsight through PixInsight's documented command line. This article explains how a request travels through the system, which instance it reaches, and what protects your work.

## From a request to a result

```text
Assistant ⇄ (stdio) MCP server
                     │  PixInsight -x=<slot>:runner.js,<jobDir>
                     ▼
           PixInsight instance → writes result.json, console.log, preview.jpg
```

1. The assistant calls a tool, such as `run_process`.
2. The server checks the request and creates a **job**: a folder with a description of the work.
3. The server hands the job to PixInsight with the `-x` command line argument, which takes about half a second.
4. A small script inside PixInsight does the work and writes the result to files in the job folder.
5. The server reads the result and returns it to the assistant.

Nothing keeps running inside PixInsight between jobs. You can keep working in PixInsight as usual.

## Instances

PixInsight can run several times at once, and each running copy is an **instance** on a numbered **slot**. The server deals with up to four kinds:

| Instance | Slot | Purpose | Visible |
|---|---|---|---|
| Yours | Usually 1 | Where the work happens in shared mode | Yes |
| Worker | 200 | Replaces yours in worker mode, for unattended work | No, on Linux |
| Shadow | 250 to 256 | Tries risky settings before they reach your instance | No, on Linux |
| Preprocessing | 240 to 242 | Runs WBPP over raw frames, and ends with the run | No, on Linux |

The server stays with the instance it first attached to. If that instance goes away, the server says so instead of moving on quietly. It never treats a worker or shadow instance as yours. See [After a crash](guides/dialogs-jobs-crashes.md#after-a-crash).

### Several servers at once

A client starts one server per session, so several can run at the same time. Each server records which instances it has started, in the folder for [job files](reference/configuration.md#files-the-server-creates), and only ever stops those. An instance on a slot that a server knows nothing about stays untouched, even if it runs without a window.

An instance that a server left behind, because it was killed or because the instance held unsaved work, is taken over by the next server that needs that slot.

Each server has a shadow instance of its own, on the first free slot from 250 up. Two servers in worker mode need different slots, because they would otherwise share their images. The second one gets the error [`no_instance`](reference/errors.md#connection).

### Shared mode and worker mode

| | Shared mode (default) | Worker mode |
|---|---|---|
| Who starts PixInsight | You | The server |
| You see each step | Yes | No |
| Message boxes | Wait for you | Answer themselves with the default choice |
| Stopped by the server | Never | When the server exits, unless it holds unsaved images or is at work. Then it keeps running, and the next server in worker mode takes it over |
| Settings of processes | Yours | Its own. Processes that need configured databases, such as `SpectrophotometricFluxCalibration`, fail until you set them up for that slot |
| Best for | Working together | Unattended batch work |

To switch, set [`PIXINSIGHT_MCP_MODE`](reference/configuration.md).

## Jobs

PixInsight runs one script at a time, so the server hands over one job at a time, in the order they arrived. A job that has to be checked first keeps its place, and is checked when its turn comes.

While the server waits for a job, it keeps telling PixInsight so. A job that PixInsight only gets to later, after you closed a dialog, does not run if the server has given up on it or has exited in the meantime. So no job runs that nobody waits for. The one exception is a [script](guides/run-scripts-and-code.md) that was already started for you: it stays open in PixInsight, and only its report is dropped.

A tool waits up to 20 seconds for its job by default. If the job takes longer, the assistant gets a job ID instead of a result and follows up with [`get_job`](reference/tools.md#get_job). The job keeps running either way.

While a job is unfinished, the server reports what PixInsight appears to be doing. Long processes use a lot of CPU, while an open dialog uses none, which is how the server recognizes that PixInsight is waiting for you.

## Processes

The server reads the list of installed processes and their parameters from your running PixInsight. That covers third-party modules, and it follows PixInsight updates without any change to this server.

A few processes are blocked, because an assistant should not run them unasked:

| Blocked | Reason |
|---|---|
| `Preferences`, `ColorManagementSetup`, `ReadoutOptions`, `FilterManager` | Change global settings |
| `RGBWorkingSpace` in the global context | Changes the default of PixInsight. It works on an image |
| `Script`, `ProcessContainer` | Run arbitrary code or unvetted processes |
| `NetworkService` | Acts on tasks from a network service |
| Everything in the `Instrumentation` category | Controls physical equipment such as cameras and mounts |

Scripts of the Script menu are a case of their own. PixInsight cannot run them with settings from outside, so the assistant starts a script and reads its dialog: the fields, their values, and what the script shows there. You set the dialog and press its buttons. If you turn that on, the assistant does this too, the way you would, on your screen. A script without a dialog acts at once. Code that the assistant writes itself only runs if you turn that on. See [Run scripts and code](guides/run-scripts-and-code.md).

Two kinds of settings need your agreement:

- **Running a program.** A process such as `GraXpert` takes the path of a program to run, in a parameter like `appPath`. The server refuses every program you have not listed in [`PIXINSIGHT_MCP_ALLOWED_PROGRAMS`](reference/configuration.md).
- **Replacing files.** Batch processes such as `ImageCalibration` write files directly, which no history can undo. The server refuses settings like `overwriteExistingFiles` unless the request also has [`allowOverwrite`](reference/tools.md#run_process). This includes `CometAlignment`, which overwrites by default.

## What keeps your work safe

| Risk | What the server does |
|---|---|
| A step makes the image worse | Every process goes into the history, so you can undo it |
| The source file gets overwritten by a Save in PixInsight | Images open as copies without a file path |
| Unsaved work gets closed | Closing refuses, unless you agree to discard it. This includes new images that were never saved, and steps you undid. For several images at once, each one to discard has to be named |
| A file gets replaced by accident | The file an image was opened from is never written to. Other files are only replaced on request, and stay in place until the new file is complete |
| The assistant undoes your step instead of its own | `undo` can check the state of the history, and refuses if it has moved |
| A misspelled parameter is ignored | Unknown parameters are refused. PixInsight itself would ignore them silently |
| A process fails silently | The response reports whether the pixels changed, and includes the log of the process |
| A question from a process holds up your work | `Crop` and similar processes go ahead without a dialog. The response says if the astrometric solution was deleted, and undo brings it back |
| An invalid setting crashes PixInsight | Enumerated values are tried in the shadow instance first, and the verdict is remembered |
| The assistant works on the wrong instance | A change of instance is always announced. Jobs that change an image or a file are refused until then |
| A script or code changes images | The response lists the images that are new, closed, or changed. What a script or code does to files or settings is not shown |
| The assistant runs code of its own | It cannot, unless you have turned that on. Scripts for equipment and for developers are blocked |
| The assistant reads or enters a password in a dialog of a script | It cannot: a field that hides what is typed is never read out, is painted over in pictures, and is never filled in. A key in an ordinary text field is not recognized |
| A script replaces a file because the assistant named it | The server hands an existing file to a script that asks where to write only if the request says that you agreed. What a script does with other settings of its dialog is not checked: see [Let the assistant work the dialog](guides/run-scripts-and-code.md#let-the-assistant-work-the-dialog) |
| The assistant acts on a dialog that has changed since it read it | An action applies to the dialog or question that the assistant was last shown, and is refused if the script shows another one by now |
| A signed script was changed after it was signed | The server asks PixInsight to check the signature before it starts the script, and starts nothing if it does not match |
| The assistant writes a script file and starts it | A script in a folder of yours counts as it was when the server started. A changed or added one is refused until you restart the server |
| A file of the server is changed to run code in PixInsight | Before each job, the server checks that its scripts are the ones it came with, and puts them back if not |
| A server stops an instance that is not its own | A server only stops what it started itself, after checking that it is still that instance |

> [!WARNING]
> These checks cannot catch everything. A plugin can still crash PixInsight during its run, which loses whatever is not saved. Save important intermediate results. See [After a crash](guides/dialogs-jobs-crashes.md#after-a-crash).

## What stays on your computer

The server talks to your client over standard input and output, and opens no network port. Job files stay in a [folder on your computer](reference/configuration.md#files-the-server-creates). Previews and statistics do go to your MCP client, and from there to the AI model it uses, so they leave your computer if that model runs in the cloud. The same holds for what the tools report besides: names of images and files, paths on your computer, which include your user name, what processes and scripts write to the console, and what the dialog of a script shows: its fields with their values, its tooltips, its questions, and pictures of it. The content of a field that hides what is typed is the exception.

## Next steps

- [Process an image](guides/process-an-image.md)
- [Handle dialogs, long jobs, and crashes](guides/dialogs-jobs-crashes.md)
- [Architecture](architecture.md), for the design decisions behind this article
