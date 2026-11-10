# Handle dialogs, long jobs, and crashes

This article explains what to do when PixInsight waits for you, when a process takes a long time, when you want to stop one, and when PixInsight crashes.

## When PixInsight shows a dialog

An open dialog in PixInsight holds back all jobs. This includes the notices PixInsight can show when it starts.

The server recognizes the situation, because PixInsight then uses no CPU while a job does not advance. The assistant gets this response:

```json
{
  "pending": true,
  "jobId": "4b79607a-1cc1-464e-bad1-8935bdbde109",
  "state": "running",
  "activity": "idle",
  "waitingForInput": true,
  "hint": "PixInsight uses no CPU and writes nothing to its console. A dialog is probably open there: please ask the user to look at it. Do not resend the job: it runs by itself once the dialog is closed. A process that waits for another program or a download can look the same, so read logTail. Only if PixInsight has crashed or no longer reacts at all, free the queue with cancel_job and abandon: true."
}
```

**To continue:** Answer or close the dialog in PixInsight. The waiting jobs run by themselves.

> [!NOTE]
> The server knows that PixInsight is waiting, but not what it asks, because the text of a dialog is not available outside PixInsight. Tell the assistant what the dialog says if it matters.

A known cause: a plugin that makes a new image from a preview of a plate-solved image can open the error `AstrometricMetadata::Write(): Incompatible image dimensions`. Nothing is lost, and the job goes on after you close it. A [copy of the region](process-an-image.md#try-a-chain-on-a-copy) avoids it.

> [!WARNING]
> A dialog that opens while you work in another program takes the keyboard focus. Pressing Enter at that moment answers it with its default button. Other commands from the assistant do not take the focus.

## When a process takes a long time

A tool returns after 20 seconds by default, even if its job is not finished. The job keeps running, and the assistant follows up with [`get_job`](../reference/tools.md#get_job):

```json
{
  "pending": true,
  "jobId": "4b79607a-1cc1-464e-bad1-8935bdbde109",
  "state": "running",
  "activity": "computing",
  "waitingForInput": false,
  "logTail": ["TGVDenoise: Processing view: M31", "Processing channel #0:"],
  "hint": "The job is still in progress. Check on it with get_job."
}
```

The percentage of a running process appears only in the Process Console of PixInsight, not in `logTail`.

Other jobs wait behind a running one. `get_status` shows the queue.

## Stop a process

| The job is | What to do |
|---|---|
| Still in the server's queue | Ask the assistant to [cancel it](../reference/tools.md#cancel_job) |
| Running in PixInsight | Press **Pause/Abort** in the Process Console and confirm |
| A [script](run-scripts-and-code.md) with its dialog open | Close the dialog in PixInsight. The job then ends by itself |
| Stuck, with no dialog open, and the queue does not move | Ask the assistant to [abandon it](../reference/tools.md#cancel_job) |

After an abort, the job ends with the error `aborted`, the image stays in its previous state, and PixInsight stays healthy.

Abandoning makes the server stop waiting, so that the next jobs can go out. Use it when PixInsight has crashed without the server noticing, which can happen on Windows, or when it no longer reacts.

- **A job PixInsight has not started** is withdrawn. PixInsight skips it when it gets to it, for example after you close a dialog.
- **A job PixInsight has started** goes on, because nothing can stop it from outside. Its result is not reported, so look at the image before you go on.

The same applies when the server exits while a job waits behind a dialog: the job does not run later.

> [!NOTE]
> The assistant cannot stop a running process itself. PixInsight's command line has no way to interrupt one.

## After a crash

If PixInsight crashes during a job, the assistant gets this error:

```json
{
  "error": "instance_lost",
  "message": "PixInsight on slot 1 crashed before the job finished. Unsaved work in that instance is gone. When the server last looked, 12 s ago, these images held unsaved work: O_starless, SHO."
}
```

Everything that was open and not saved is lost. Saved files are not affected.

The message names the images that held unsaved work when a job last ran, so that the assistant knows what to rebuild. It can be out of date: if you saved an image in PixInsight after that job, the image is still listed.

**To continue:**

1. Start PixInsight again.

2. Ask the assistant to continue. The next result contains a notice that the instance has changed:

   ```json
   { "notice": "The PixInsight instance on slot 1 is gone: it crashed or was closed. Now working with slot 1. Images that were open and not saved are lost, so check list_images before going on." }
   ```

   Jobs that were waiting, and the next job that would change an image or a file, end with the error [`instance_changed`](../reference/errors.md#connection) instead of running. An image in the new instance can have the same name as one that is gone.

3. Open the most recent saved state again.

To limit what a crash can cost, save intermediate results, especially before you try a plugin for the first time.

### Clean up after a crash

A crashed instance cannot remove its swap files. If your swap folder is the system temporary folder, on many Linux systems they then keep using memory until the next restart.

To find them, look for files named `~PI~*.swp` in the swap folder. Delete only files older than the current PixInsight session. Newer ones may belong to a running instance.

## When the assistant reports the wrong images

If `list_images` is empty although your images are open, or shows images you do not know, ask the assistant to check [`get_status`](../reference/tools.md#get_status):

- `target` is the instance the server works with.
- `instances` lists all of them. The server's own helpers are marked with `role`.

If you run several instances, set [`PIXINSIGHT_SLOT`](../reference/configuration.md) to choose one.

## Next steps

- [Error reference](../reference/errors.md)
- [How the server works](../concepts.md)
