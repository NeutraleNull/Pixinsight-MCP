# Error reference

When a tool fails, its result has `isError` set and contains a JSON object with a stable `error` code and a `message` for reading. Process failures also include the console output.

```json
{
  "error": "process_failed",
  "message": "PixelMath reported a failure. See the console messages.",
  "console": ["*** Error: Mismatched left parenthesis:", "<* failed *>"],
  "log": ["PixelMath: Processing view: M31", "*** Error: Mismatched left parenthesis:", "nope(", "~~~~^", "<* failed *>"]
}
```

| Field | Type | Description |
|---|---|---|
| `error` | string | The error code. Use it to tell errors apart, as the message can change. |
| `message` | string | What went wrong. |
| `console` | string[] | Errors and warnings from the PixInsight console, if any. |
| `log` | string[] | The console output. For `run_process`, `start_script`, and `run_code`. |

## Connection

| Code | Meaning | What to do |
|---|---|---|
| `instance_not_running` | No PixInsight instance is available, or the configured slot is empty. The server's own helper instances do not count. | Start PixInsight, or check [`PIXINSIGHT_SLOT`](configuration.md). |
| `instance_lost` | PixInsight crashed or closed during the job. Unsaved work in it is gone. The message names the images that held unsaved work when the server last looked. | See [After a crash](../guides/dialogs-jobs-crashes.md#after-a-crash). |
| `instance_changed` | The job was not run, because the instance changed after it was sent, or the assistant has not heard about the change yet. Anything that changes an image or a file could otherwise hit an image there that only has the same name. | Check [`list_images`](tools.md#list_images), then send the job again if it still applies. |
| `no_instance` | The server could not start its own instance: the slot belongs to another server, holds an instance it did not start, or holds one that an earlier server left and that does not answer. Or PixInsight did not start in time. | Read `message`. Choose another slot with [`PIXINSIGHT_MCP_WORKER_SLOT`](configuration.md), or end the instance that is named there. |
| `busy` | PixInsight did not answer in time, usually because of a long job or an open dialog. Or the helper instance that checks a setting could not be used. | Check [`get_status`](tools.md#get_status). See [When PixInsight shows a dialog](../guides/dialogs-jobs-crashes.md#when-pixinsight-shows-a-dialog). Nothing is remembered about the setting, so try again. |
| `cli_failed` | Calling the PixInsight executable failed. | Check [`PIXINSIGHT_EXECUTABLE`](configuration.md). |
| `cli_timeout` | PixInsight did not answer a call of its command line within 30 seconds, and the server ended the call. | If it happens once, try again. If every call ends this way, see [When PixInsight no longer lists its instances](../guides/dialogs-jobs-crashes.md#when-pixinsight-no-longer-lists-its-instances). |

## Requests

| Code | Meaning | What to do |
|---|---|---|
| `unknown_process` | No installed process has this name. | Look it up with [`list_processes`](tools.md#list_processes). |
| `blocked_process` | This process cannot run through the server, or not in the global context. | See [Processes](../concepts.md#processes). Run it in PixInsight yourself. |
| `blocked_parameter` | A setting would run a program you have not allowed, or replace existing files. | Allow the program with [`PIXINSIGHT_MCP_ALLOWED_PROGRAMS`](configuration.md), or pass [`allowOverwrite`](tools.md#run_process) once you are sure. |
| `invalid_target` | `run_process` needs either `view` or `global`, and a mask needs a view. | Set exactly one target. |
| `unknown_parameter` | The process has no parameter with this name. PixInsight would have ignored it silently. | Check the spelling with [`describe_process`](tools.md#describe_process). |
| `read_only_parameter` | This parameter is an output of the process. | Remove it from `params`. |
| `invalid_enum` | An enumerated parameter got a number, or a name the process does not have. | Pass a name from the `constants` of [`describe_process`](tools.md#describe_process). |
| `invalid_parameter_value` | PixInsight rejected the value: out of range, wrong type, or a constant that belongs to another parameter. The message names the valid range, if any. | Correct the value. |
| `unknown_view` | No open image or preview has this ID. | Look it up with [`list_images`](tools.md#list_images). Previews use the full ID, `image->preview`. |
| `invalid_region` | The region does not overlap the image. | Check the coordinates against the image size. |
| `invalid_mask` | The mask is a preview, has other dimensions than the image, is the image itself, or the process cannot run through a mask. | Use a main view of the same size. |
| `unknown_script` | No script of the Script menu has this name. The message names similar ones, also for a misspelled name. | Look it up with [`list_scripts`](tools.md#list_scripts). A script in a folder of your own needs [`PIXINSIGHT_MCP_SCRIPT_DIRS`](configuration.md). |
| `blocked_script` | The script is in a menu the assistant must not start from, or the path of its file has a character that PixInsight's command line does not take. | See [Scripts the assistant cannot start](../guides/run-scripts-and-code.md#scripts-the-assistant-cannot-start). Start it yourself from the Script menu. |
| `script_changed` | The file of the script has changed since the server started, or since it listed the script. It was not started, because a changed file could hold anything. | If the change is yours, restart the server. |
| `bad_signature` | The signature of a signed script is not valid for its file: the file was changed after it was signed, or the signature is damaged. PixInsight does not run such a script either. | Install the script again from where you got it. |
| `script_open` | `start_script` was called while another script is still open or waiting. | Finish or close the open script first. The message names its job. |
| `not_active` | PixInsight did not make the image the active one, so the script would have worked on another image. | Bring the image to the front in PixInsight, and start the script again. |
| `unknown_guide` | The processing library has no guide with this ID. The message names similar ones. | Call [`get_guide`](tools.md#get_guide) without a name for the catalog. |
| `unknown_job` | No job has this ID. The server keeps the 100 most recent ones, and forgets them when it restarts. | Look at the result in PixInsight. |
| `cancelled` | The job was withdrawn with [`cancel_job`](tools.md#cancel_job) before it reached PixInsight, or the server shut down first. | None needed. |
| `invalid_arguments` | Arguments that exclude each other, such as `rect` with `rects`, or `discardChanges: true` for a list of images. | Read `message`. |
| `mask_in_use` | A process that changes the geometry got an image that other images use as their mask. | Run it on a duplicate, or remove the mask from those images first. |
| `already_running` | `cancel_job` got a job that is on its way to PixInsight or already there. | See [Stop a process](../guides/dialogs-jobs-crashes.md#stop-a-process). For a script, close its dialog in PixInsight. Where the assistant may work dialogs, [`use_script_dialog`](tools.md#use_script_dialog) with the action `close` does the same. |
| `already_finished` | `cancel_job` got a finished job. | None needed. |

## Dialogs of scripts

From [`get_script_dialog`](tools.md#get_script_dialog) and [`use_script_dialog`](tools.md#use_script_dialog). Where an action is refused, nothing in the dialog has changed, unless the description says otherwise.

| Code | Meaning | What to do |
|---|---|---|
| `no_script` | No script is open, or the script has ended. In the second case the message names the job that holds its report. | Start one with [`start_script`](tools.md#start_script), or read the report with [`get_job`](tools.md#get_job). |
| `no_dialog_access` | The script was started with `plain`, so its dialog cannot be read or worked from outside. | Work the dialog yourself in PixInsight. |
| `no_dialog` | The script shows no dialog of its own right now. It is at work, or it has opened a window of PixInsight that only you can work, such as a file chooser of a script for the older engine. | Look at PixInsight, or wait and call `get_script_dialog` again. |
| `dialog_changed` | The script shows another dialog than the one the assistant last read, or shows the same one anew. | Read the dialog with `get_script_dialog`, then act. |
| `not_taken` | The dialog did not take the action in time, because the script is busy in it. Nothing was done. | Look again with `get_script_dialog`, then try once more. |
| `unknown_field` | The dialog has no field with this `id`, the field is not shown right now, it belongs to a dialog that lies under the one on top, or the script shows two fields at once that took turns under this `id`. | Read the dialog again with `get_script_dialog`. |
| `field_disabled` | The field is greyed out. Another setting of the dialog decides when it can be used. | Change that setting first, as you would. |
| `secret_field` | The field hides what is typed, as for a password or a license key. The assistant does not fill in such a field, and never gets its content. | Type it into the dialog yourself. |
| `not_settable` | The field takes no value, such as a label or a button, or it is read-only. | Press a button with the action `press`. |
| `not_a_button` | `press` got a check box or a radio button. | Use the action `set` with `true` or `false`. |
| `not_clickable` | `click` hit a field that is no button and no drawn area. The message names the field. | Give that field a value with the action `set`. |
| `no_effect` | The script has given the button nothing to do, or nothing at the point of a `click` takes clicks from the script's own code. | Use the fields of the dialog. For what only the mouse can do in a native control, work the dialog yourself. |
| `invalid_value` | The value does not fit: no number, outside the `range` of the field, no option of that text, several options of that text, a row that the table does not have, an answer that is none of the buttons, or an action without the `field`, `value`, `x` or `y` it needs. The message says what fits. | Read `message`. |
| `question_open` | The script asks something and waits, so nothing else can be done in its dialog. | Answer with the action `answer`, or answer in PixInsight. |
| `question_changed` | The script asks another question than the one the assistant last read. Nothing was answered. The message holds the new question. | Answer the new question, if that is meant. |
| `no_question` | `answer` was sent while the script asks nothing, or after you answered the question in PixInsight. | Read what the script shows now with `get_script_dialog`. |
| `invalid_path` | The path given as an answer is not absolute, names a folder where a file is asked for, or holds a backslash on Linux or macOS. | Pass the full path. |
| `no_such_file` | The path given as an answer does not exist: a file to open, a folder, or the folder of a file to write. | Check the path. |
| `file_exists` | The file given as the answer to a chooser for writing exists, and the script would replace it. | If you agree, the assistant sends the answer again with `allowOverwrite`. |
| `script_error` | The script's own code failed while it handled the action. The value was set before that, and the script goes on. | Read `message`, and read the dialog again. |
| `read_only` | [`PIXINSIGHT_MCP_SCRIPT_DIALOGS`](configuration.md) is `read`. No tool sends this, because the tool that works a dialog is not offered then. A script reports it if something else tells it to act. | Work the dialog yourself, or change the setting. |

## Preprocessing

From [`start_preprocessing`](tools.md#start_preprocessing), and from [`get_job`](tools.md#get_job) for a run.

| Code | Meaning | What to do |
|---|---|---|
| `invalid_path` | A path is not absolute, the output is a file, or the output folder and a folder with frames lie in one another, where a run would read its own files as frames. Or a name has a character that means something on the command line of PixInsight, such as `,`, `(`, or `'`: the message names it. | Pass absolute paths, and an output folder outside the inputs. A name with such a character has to be changed: the tool cannot take it. |
| `no_such_file` | An input does not exist. | Check the path. |
| `invalid_value` | A keyword or an option is not what the command line of PixInsight can take: a keyword that is no name, an option with a character such as `,` or `;` in its value, or more single files than fit. | Read `message`. Name folders instead of many files. |
| `blocked_parameter` | The option makes WBPP run code, as a script file or as a formula, or the tool sets it itself. | Leave it out. |
| `busy` | A preprocessing run of this session is under way. The message names its job. | Wait for it with `get_job`, or stop it with `cancel_job`. |
| `no_instance` | None of the slots for preprocessing runs is free. | Wait for the runs of other sessions, or set [`PIXINSIGHT_MCP_PREPROCESS_SLOT`](configuration.md). |
| `cli_failed` | PixInsight could not be started for the run, or the run could not be stopped. | Read `message`. |
| `not_started` | WBPP checked the frames and the options, and did not start: no frames, or a value it cannot read. The message holds its reason. | Correct the inputs or the option, and start again. |
| `run_failed` | PixInsight ended before WBPP had finished: it crashed, was ended from outside, or WBPP stopped with an error. The message holds the last lines of its console. | Read `message`. The output folder holds what was written, and the log. |
| `cancelled` | The run was stopped with `cancel_job`. | The files written so far are in the output folder. Start again into a new folder. |

The script of WBPP is looked up like any other, in the PixInsight the session works with. So [`instance_not_running`](#connection) applies if no PixInsight is running, and [`unknown_script` and `script_changed`](#requests) apply too. A run is known to the session that started it: in a later one, `get_job` answers `unknown_job`, and the log in the output folder says how the run ended.

## Processes

| Code | Meaning | What to do |
|---|---|---|
| `process_failed` | The process reported a failure. | Read `console` and `log`. |
| `process_error` | PixInsight refused to run the process with these settings, or on this view. | Read `message`. For example, some processes need a color image or an astrometric solution. |
| `aborted` | The process was aborted in PixInsight. | Run it again if needed. |
| `code_error` | Code from [`run_code`](tools.md#run_code) does not compile, threw an error, or returned something that is no JSON value or is longer than 60,000 characters. The message names the line, and the images the code had made or changed by then. | Correct the code. Check the images the message names before you run it again. |
| `abandoned` | The server stopped waiting for this job after [`cancel_job`](tools.md#cancel_job) with `abandon`. The message says whether PixInsight had started it. If so, it goes on there, and its result is not reported. | Check the image with [`list_images`](tools.md#list_images) before going on. |

> [!IMPORTANT]
> Some processes report success without doing anything, for example when a plugin cannot find its external program. Then there is no error, but the response has `pixelsChanged: false` and a `hint`. Read the `log` in that case. Processes that only measure or only write metadata also report `false`, which is fine for them.

## History and images

| Code | Meaning | What to do |
|---|---|---|
| `nothing_to_undo`, `nothing_to_redo` | The view has no earlier or later state. | None needed. |
| `unsaved_changes` | An image holds unsaved work, is new and was never saved, or has steps that were undone and could be redone. With a list of images, none was closed. | Save it, or name it in `discardChanges` once you are sure. |
| `history_changed` | `undo` or `redo` got a `historyIndex`, and the history is in another state: something else has changed the image since. | Look at the image, and decide again. |
| `not_a_preview` | `delete_preview` got a main view. | Use [`close_image`](tools.md#close_image) for images. |
| `not_supported` | `save_image`, `close_image`, and `start_script` work on main views only. | Use `export_image` or `delete_preview` for previews. Start a script on the main view. |

## Files

| Code | Meaning | What to do |
|---|---|---|
| `file_not_found` | The file does not exist. | Check the path. |
| `open_failed` | PixInsight could not read the file. | Read `console`. |
| `file_exists` | The target file exists. | Choose another path. Set `overwrite` only if this file is meant to be replaced. |
| `protected_source` | The target is the file that an open image was opened from. | Choose another path. To change the file itself, open it with `editOriginal`. |
| `invalid_path` | The path is not absolute. | Pass the full path. |
| `use_export` | `save_image` only writes working files. | Use [`export_image`](tools.md#export_image) for JPEG and similar formats. |
| `invalid_format` | PixInsight cannot write this format, or the format cannot store this bit depth. | Choose another extension or `bitsPerSample`. |
| `save_failed`, `export_failed` | PixInsight could not write the file. | Read `console`. Check the folder and free disk space. |

## Internal

These point to a problem in the server itself. Please report them.

| Code | Meaning |
|---|---|
| `script_error` | An unexpected error in a script inside PixInsight, or a result file that could not be read. |
| `withdrawn` | PixInsight got to a job that the server no longer waited for, and did not run it. An assistant should never see this. |
| `unserializable_result` | A result could not be converted to JSON. |
| `job_setup_failed` | The job folder could not be written. Check `PIXINSIGHT_MCP_HOME`. |
| `internal_error` | An unexpected error in the server. |
