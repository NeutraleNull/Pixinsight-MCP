# Architecture

This article is for contributors. It explains how the server is built, why it is built that way, and which rules follow for anyone who changes it. How PixInsight behaves where the server depends on it is listed in the [PixInsight behaviour reference](reference/pixinsight-behaviour.md). To use the server, start with the [quickstart](quickstart.md).

## Goals

1. Work **together with the user** in the same PixInsight, safely enough to trust with unsaved work.
2. Cover **as many functions as possible** without a hand-written tool per process.
3. Stay **maintainable**: survive PixInsight updates, and keep platform differences in one place.
4. Serve **any assistant**: nothing depends on one client or one model.

## Overview

```text
MCP client          server (Node.js)                         PixInsight
  assistant  <-->   tools -> session -> job queue  -- -x -->  runner.js -> operation
                                  ^                               |
                                  +------- files in the job folder
```

The server talks to its client over standard input and output. It talks to PixInsight only through PixInsight's documented command line: every job is one `-x` command that tells a running instance to execute a script.

### How a job runs

1. A tool turns its arguments into a job and puts it into the queue.
2. When the job heads the queue, the server checks it. For `run_process` that means the process, its parameter names, its enumerated values, and the policy.
3. The server writes `job.json` into a folder of its own for the job, and sends `PixInsight -x=<slot>:runner.js,<jobDir>`.
4. Inside PixInsight, `runner.js` writes `started.json`, loads the operation the job names, runs it, and writes `result.json`. The console output of the run goes to `console.log` in the same folder.
5. The server sees the result file, reads and filters the log, and returns both to the assistant.

Each file appears by atomic rename, so the server never reads half a result. Nothing of the server runs inside PixInsight between two jobs, so the user can keep working normally.

### Source layout

The code is grouped by what it is for. `bridge` reaches PixInsight, `scripts` is about the scripts of the Script menu and their dialogs, and `preprocessing` about runs of WBPP. `test/unit/` has the same folders.

```text
src/index.ts                  stdio entry point
src/tools.ts                  MCP tools: argument schemas and result formatting
src/session.ts                wires everything, and checks requests before they become jobs
src/policy.ts                 processes, settings, scripts and options that must not run through a tool
src/guides.ts                 loads, checks and renders the processing library
src/config.ts                 settings from environment variables
src/home.ts                   the job folder, and the scripts for PixInsight per content hash
src/platform.ts               everything that differs per operating system
src/bridge/cli.ts             the only code that invokes the PixInsight executable
src/bridge/jobs.ts            job queue, result files, liveness and activity tracking
src/bridge/target.ts          which instance jobs go to in shared mode, and announcing changes
src/bridge/instance.ts        instances this server owns (worker, shadow)
src/bridge/lease.ts           which server owns which slot, recorded in a file per slot
src/bridge/enumGuard.ts       tries risky enumerated values in the shadow instance
src/scripts/catalog.ts        finds the scripts of the Script menu by their feature directives
src/scripts/dialogs.ts        the file a script is started through, and the files to its dialogs
src/preprocessing/request.ts  checks a request, and makes the arguments of WBPP from it
src/preprocessing/runs.ts     runs of WBPP in an instance of their own, and what they report
pjsr/runner.js                fixed entry point inside PixInsight, always leaves a result
pjsr/lib.js                   helpers shared by the operations
pjsr/ops/*.js                 one file per operation
pjsr/begin_log.js             starts a console log for a script that is sent ahead of a job
pjsr/end_log.js               ends it again if that job cannot follow
pjsr/dialogs/hook.js          runs inside a started script, on either engine, and serves its dialogs
pjsr/dialogs/unhook.js        puts back what the hook changed in the classic engine
processing/                   what the assistant knows about processing, one small file per method
skills/                       one entry skill for Claude Code, which points to the library
.claude-plugin/               bundles the server and the skill for Claude Code
```

## Design decisions

### The command line is the only channel

| Option | Verdict |
|---|---|
| **`-x` per command** | **Chosen.** Documented, no install step, leaves the user interface free, about 0.5 s per command |
| A watcher script in a loop | Occupies the single script thread, needs a stay-alive trick, and polls files |
| A native PCL module with a server | Must be signed, needs a C++ build per platform, and links PCL code |

Pleiades' [program rules for certified developers](https://pixinsight.com/security/cpd-rules/) point the same way: other programs may control PixInsight only through the documented command line and IPC, and signed code must not act as a loader for code it does not ship. These rules bind signed code. This project ships unsigned scripts and is outside their scope, but the design follows them where it can. The result files are the one grey area if signing ever becomes a goal.

A syntax error in a script that PixInsight is told to execute leaves no trace at all. So the runner is one small, fixed script, and it loads everything else with `eval`, inside a `try` that always writes a result.

The command line itself is called with care, because of what was [measured](reference/pixinsight-behaviour.md#command-line-and-instances) about its clients:

- **One client at a time.** Two clients of PixInsight that run at the same moment can leave a lock of PixInsight behind that nothing releases, and from then on no listing of instances on the machine returns. So the calls of a server wait for one another, and the servers of a user take turns by a lock file in the folder for temporary files. Those who ask for a listing before one has begun share that listing.
- **A client that does not come back is ended after 30 s,** together with what the launcher started: the client runs as the leader of a process group, because ending the launcher alone leaves PixInsight's own process behind. The result is the error `cli_timeout`. After a listing that did not come back, the next one is not tried for 20 s, since each try costs its whole time.
- **Nothing asks for a listing in a loop where a file or a process can answer.** A listing looks at every slot, and each one adds to the chance described above.

### One generic tool covers every process

- **`describe_process` and `run_process` work for every installed process,** from the metadata of the running instance. That includes third-party modules, and it follows PixInsight updates without a change here. The tool schemas stay small: all parameters of all processes as JSON Schema would fill the context of any model.
- **Hand-built tools exist where a generic process call is not enough:** previews, statistics, masks, duplicates, export, undo.
- **Scripts of the Script menu are started for the user,** see [Scripts and code](#scripts-and-code).
- **Code of the assistant's own** is an escape hatch that is off unless the user turns it on.
- **Processing knowledge is separate from the tools,** in the [processing library](#the-processing-library).

`run_process` checks a request before it reaches PixInsight, because PixInsight itself is forgiving in the wrong places: it accepts an unknown parameter as a plain property and ignores it, and a process that fails returns `false` with the reason only in the console. So unknown parameters are refused, the result says whether the pixels changed, and the log of the process is part of the result.

### The queue

PixInsight takes `-x` commands one after the other, but commands from several clients arrive in arbitrary order. So the server hands over one job at a time.

- **`submit` is synchronous, and the check is part of the job.** So `run_process` followed by `save_image` keeps its order however long the check takes, and a caller can stop waiting during a check.
- **A check starts when the job heads the queue,** not at once. Its lookups, such as `describe_process`, then find PixInsight free. Started earlier, they would wait behind a long process, time out, and fail a job that has not even had its turn.
- **Some operations cannot be submitted without their check:** `run_process`, `start_script` and `run_code`. The job manager refuses them, so that a new tool cannot leave the check out by accident.
- **The server keeps telling the runner that it waits,** by writing the time into `awaited` in the job folder every second. PixInsight can get to a job long after it was sent, once the user closes a dialog. If the server has given up on the job by then, has shut down, or was killed, the runner finds no fresh sign and does not start the job. The runner marks its start before it looks for the sign, and the server withdraws before it looks for the mark, so the server can say for sure whether a job still runs.
- **A job that is on its way cannot be cancelled as if it had never left.** Its commands go out one by one, and "never sent" would be a lie in the middle of that. From the first command on, a job can only be abandoned.
- **A process that writes to its console is at work,** even if PixInsight itself uses no CPU, as while it waits for a program it has started. Only silence on both counts is taken for an open dialog.
- **The runner loads only what the server came with.** Before each job, the server compares the content of its scripts folder with the hash in the name of that folder, and puts the scripts back if they differ. What the runner evaluates runs inside PixInsight, so a changed file there would be a way to run code.

### Instances, and who owns them

The server works with up to four kinds of instances:

| Instance | Whose | What for |
|---|---|---|
| The user's | The user's. Never started, stopped or killed by the server | Shared mode: the user and the assistant work in it together |
| Worker | The server's, without a window | Worker mode: the assistant works alone |
| Shadow | The server's, without a window, disposable | Tries enumerated values that could crash PixInsight |
| Preprocessing | The server's, without a window, for one run | Runs WBPP over raw frames, and exits by itself |

A slot says nothing about who an instance belongs to, and a client starts one server per session. So every instance a server starts gets a lease: `leases/slot-<n>.json`, with the pid of the server and of the instance. Reading and changing a lease happens under a lock, a folder made with `mkdir`, so that two servers that find the same stale lease cannot both take it.

- **Stopping and killing** require that the server holds the instance, and that the slot still shows the same pid. Otherwise an exiting server would close the images of whatever else runs on that slot.
- **Taking over** happens only for the leftover of a server that is gone: the lease names the pid on the slot, or the server died while it was starting the instance, and the instance says that it runs in automation mode. Anything else on a slot is left alone.
- **A leftover that gives no answer** is busy or stuck. Its lease stays, so that it can be taken over once it answers. A shadow instance in that state is ended, because it never holds anything.
- **A lease is void** if its server is gone, or if its instance is gone, which also covers a pid reused after a reboot. A server only releases a lease that is still its own.
- **An own instance is looked for again** after three seconds without a job, like the instance of the user. It can have died, and the slot can belong to another server by then.
- **Shadow instances are not shared.** Each server takes the first free slot of seven. Sharing one would mean that another server's idle timer stops it during a check.
- **The scripts for PixInsight are immutable,** in `pjsr/<content hash>/`. A version goes a week after a server last started with it.
- **Stopping has four seconds.** An MCP client closes the input of a server, sends SIGTERM after two seconds, and SIGKILL after two more. So the wait for an exit goes by the pid and not by listing instances, the shadow instance skips closing images, and a stop does not wait for a start that is under way. A server that is killed anyway leaves its lease, and the next server takes the instance over.
- **A worker with unsaved images is not stopped** when the server exits, and neither is one in the middle of a job. Stopping means closing all images without saving, and that would happen at every end of a session. It stays with its lease for the next server.
- **In shared mode, no slot with a lease is a candidate** for "the instance of the user", whatever slot numbers this server itself is configured with.

`kill` and `isRunning` are methods of `PixInsightCli`, not calls to `process` inside `ManagedInstance`, so that a unit test with a made-up pid cannot reach a real process.

### When the instance changes

`JobTarget` is the one interface for "where do jobs go", implemented by `SharedTarget` and `ManagedInstance`. Its `generation` increases when the instance changes: because it crashed, was closed, or was restarted.

- **A change is always announced.** Falling over silently to whatever else is running would make the assistant work on the wrong images while everything looks fine. The tool wrapper hands out a pending notice with the next result, whatever tool that is.
- **Jobs that change something wait for the announcement.** A job that is not safe on any instance is refused if the generation changed since it was submitted, or if the assistant has not received the notice yet.
- **A notice is only handed out with a result that arrives.** The SDK throws the result of a cancelled call away, so the notice stays in place then.
- **The server remembers which images held unsaved work.** The runner adds the open images to every result, and the job manager keeps the last such list. After a crash nothing can be asked any more, so this is the only way to say what was lost. The errors and the notice carry it, with its age, because the user may have saved since.

### The enum guard

Assigning an invalid value to an enumerated parameter can end in a clean exception, in a hang at full CPU, or in a crash, see [Enumerated parameters](reference/pixinsight-behaviour.md#enumerated-parameters). So numbers are never accepted for enumerations, only constant names. PixInsight does not reveal which constants belong to which parameter, so a name can still be wrong. A combination that is not known to be safe is therefore tried in the shadow instance first, where a crash costs nothing. Values equal to the default skip the check.

The verdict is stored per PixInsight build in `enum-checks.json`. It lasts as long as the build, so only clear outcomes are stored:

| Outcome in the shadow instance | Counts as |
|---|---|
| A clean rejection | Unsafe, at once |
| A crash | Unsafe, if it happens again on a fresh instance. It can have other causes, such as someone stopping the shadow instance |
| A hang | Unsafe for this session only, if it happens again. A machine that is busy gives no answer either |
| Anything else, such as a script error or an occupied slot | Nothing. The request is refused with `busy` |

Enumerated values inside table parameters are not checked.

### Scripts and code

A script of the Script menu cannot be run with parameters from another script, see [Scripts](reference/pixinsight-behaviour.md#scripts). So there is no unattended way like `run_process`, and a script is not an operation of the runner. `start_script` is one job that sends three commands in a row, which PixInsight takes in that order. A fourth one follows the script if it runs on the classic engine with access to its dialogs: see [The dialog of a script](#the-dialog-of-a-script).

1. `begin_log.js` starts a console log into `script.log` of the job folder, and brings the image to the front once more.
2. The script. Its dialog opens.
3. The runner with the operation `start_script`, which runs once the script has ended. It compares the images with what `prepare_script` recorded during the check, and its own console log ends the one from step 1.

The job stays `sent` while the script is open. The server shows `script.log` as the output of such a job, reads only its end, and counts its growth as activity.

- **Nothing takes a script back once it is sent.** Abandoning the job only drops the report, and the messages say so. If a command after the first cannot be sent, `end_log.js` ends the log again, and the runner gets one more try, because without it the script would be open with nobody to report on it.
- **The check brings the image to the front,** because a script works on the active image. `prepare_script` runs as a lookup of the check, so no other job of this server gets between it and the script. It does not run for a job that was withdrawn while it waited, or after the instance has changed. A lookup that PixInsight does not answer in time is withdrawn, so that it cannot bring an image to the front much later.
- **One script at a time.** A second `start_script` is refused while one is open or waiting: it would open right after the first, on images the first one has changed.
- **The server finds the scripts itself,** by reading the feature directives at the start of each `.js` file in the `scripts` folder that PixInsight reports, and in the folders of `PIXINSIGHT_MCP_SCRIPT_DIRS`. The assistant names a script and never passes a path, a later folder cannot replace a script of an earlier one, and links are not followed. Two scripts of one origin with the same name are told apart by their menu item.
- **A script file is a way to run code, so its content is pinned.** The server records a hash of each script when it lists it, and for the folders of the user it does that while it starts, before it takes any request. Right before a script goes out, the file has to have that hash, or the start is refused. So an assistant that can write files cannot change or add a script and run it in the same session. Across a restart of the server it can: whoever can write to such a folder can run code, which the user documentation says in a warning.
- **Scripts need the PixInsight the user sits at.** The tools are only registered in shared mode. A script can open windows that nothing but a person can work, and the user has to be able to see what a script asks.
- **`run_code` is only registered if the user has turned it on.** It evaluates the code as a function body in the runner. No check looks at the code: a filter on its text would be easy to get around, and would only look like safety.
- **Both report what changed in the open images,** because neither returns it: new and closed images, and for each other image whether its history, geometry, astrometric solution, previews or metadata differ. Samples from 128 positions per channel show pixels that differ while the history is at the same place, which is usually a change that undo cannot take back. A small local change can escape that, and so does anything outside the images, such as files and settings.

### The dialog of a script

PixInsight has no way to fill in the dialog of a script from outside, and screen control would mean access to the whole desktop, different code per platform, and a model that can see. So the dialog is worked from inside the script, with PixInsight's own scripting API, and the assistant gets it as a list of fields. Every behaviour this rests on is in [Dialogs of scripts](reference/pixinsight-behaviour.md#dialogs-of-scripts).

- **The script is started through a file of the server.** In place of the script, step 2 above sends `start.js` from the job folder: the text of `pjsr/dialogs/hook.js`, called with the job folder, then an `#include` of the script. The script runs unchanged in one scope with the hook, with its own path and its own includes. The file exists only in the job folder of the user, and names the script where it is installed.
- **The server tells the hook its engine.** The file carries `#engine v8` exactly if the script does, in whatever case, as PixInsight reads it. The hook cannot tell by looking: on the classic engine, a script before it can have left anything in the scope.
- **The hook gets hold of the dialogs in the way each engine allows.** On V8 a dialog has its methods on itself, where they cannot be replaced, so the global `Dialog` becomes a proxy that notes every dialog that is made. The classic engine does not survive a replaced constructor, so `Dialog.prototype.execute` is replaced there. With leave to work the dialogs, message boxes get the same treatment, and on V8 file choosers too. On the classic engine one global function is added for the clean-up. Nothing else of PixInsight's objects is changed.
- **A timer per dialog serves it.** While a dialog is open, its timer reads a command from the job folder, carries it out, and writes a reply: describe the fields, render a picture, set a value, press a button, click, close. A timer of its own per dialog, because a button can open a second dialog, and the timer that pressed it stands still until that one is closed.
- **The dialog on top is the one that was opened last,** not the one that was made last: a script can make its dialogs in any order. On V8 nothing says when a dialog opens, so each timer watches its own dialog.
- **Every showing of a dialog has a name, and every action carries one.** The server sends an action only for the showing that the assistant last read, and the hook carries it out only if that showing is still on top. A dialog that is closed and shown again has a new name. The same holds for questions, by their number. So nothing is done to something the assistant has not seen. A command is taken by removing its file, by the hook or by the server, so the server knows whether an action it gave up on was carried out.
- **Fields are found in several ways, because none finds all.** As what the script keeps: on the dialog object, and on the classic engine also on the objects and lists that hang from it, a few steps deep. As what the script was seen to make or to lay out: on V8 the global classes of the fields are proxies that note each new control, held weakly so that it goes with its dialog. The classic engine does not survive a replaced constructor, so there the methods that add a control to a sizer or a page to a tab box are replaced, and put back like `execute`. The area that a scroll box shows, where a script draws a preview, is taken from the scroll box. And on V8 by asking which control lies at each point of a grid over the surface, which finds an area that a script draws itself. That question finds no table and no text box, because PixInsight names nothing at a point inside one. On the classic engine it is never asked: PixInsight went down over it, at a point on the frame of a text box. A click there is matched against the controls that are known: the smallest one at the point that none of its parents cuts off.
- **A field keeps its id,** which is a number per control. A script can keep two controls in one place and show them in turns, as WBPP does with its tables. A table that turns up exactly where a hidden one of the same parent and the same columns was takes over the id of that one, because to a reader it is the same field. If both show at once, each has an id of its own, and the shared one is refused until the dialog is read again. A dialog that the script builds anew has new controls, and so new ids.
- **A table is read as rows with numbers.** The number of a row is its place in the order a reader meets the rows, rows inside rows included, and it is what selects the row. It is given with every row, because a table often counts its rows itself, from 1. The list of a dialog shows the rows as deep as 60 of them reach, and a table that is read by itself shows them all. The same holds for a long text.
- **After an action, the answer is what changed.** The server keeps what it last showed of a dialog, and compares: fields that are new, fields that are gone, and of a field that differs only the details that do. Where a field lies is not compared. A dialog that the assistant has not read comes in full. What was only looked at while waiting, and what a client gave up on, is not what the next answer is compared with. A field that is listed in part is compared in that part, and named. And where an action was carried out and its outcome cannot be shown, the answer says that it was carried out.
- **A value is set, then the script is told, exactly once.** Setting a property tells a script nothing, except where PixInsight does tell it, which differs between the engines. So each handler is watched while the value is set, and called afterwards only if PixInsight did not call it. What the user could not do is refused: a disabled or hidden field, a field of a dialog under another one. A click is carried out only on an area the script draws itself: on a field, it would tell the script of a click that changed nothing.
- **Windows of PixInsight's own are replaced by a window of the hook.** A message box and a file chooser cannot be answered from a script, so the hook shows a dialog of its own in their place, with the same text and buttons, the same default button, and no way to close it without a choice where the message box has none. The user can answer it, and so can the server through a file. A chooser has a button that opens the real one. The classic engine cannot hand a chosen path to a script, so its choosers stay what they are. If anything fails in here, the script gets PixInsight's own window.
- **The classic engine keeps its scope from one script to the next,** so the hook must not outlive the script: the next script in that scope would run with it. `pjsr/dialogs/unhook.js` is sent right after the script and puts both methods back. If it never arrives, the replaced methods do it themselves, the first time they are called while nobody waits for the job. Every timer is stopped when its dialog closes, because on this engine a timer that still runs when a script ends breaks the scripts after it.
- **The hook serves only while the server waits,** which it reads from the heartbeat file of the job, like the runner. At the end of the job that file says so at once.
- **Nothing is done to a dialog in the tick it appears in,** and a close is repeated where the hook can see that it did not end the wait of the dialog. PixInsight may still be bringing the window up.
- **A password is never read out or filled in.** A text field in password mode is reported as secret without its text, setting it is refused, and it is painted over in pictures. It stays secret for the rest of the script, because a script can switch that mode off to show what the field holds.
- **The signature of a script is checked at the server's request.** PixInsight verifies a signed script that it runs, and refuses one that was changed. It does not look at a script that another one includes, so `prepare_script` asks PixInsight for that check before the script is started.
- **The hook writes what it did to the console,** one line per action, before the script is told, so that the user can follow, and so that the log of the job says how its result came about. What the assistant chose is written so that the console takes none of it for markup or for a line of its own.
- **No policy stands behind a dialog.** For processes, the server knows which parameters name programs or overwrite files. A dialog only shows fields and buttons, and what they make a script do is known to the script alone. The server enforces what it can see: an existing file as the answer to a chooser for writing needs `allowOverwrite`. For the rest, the hints tell the assistant to ask first, and the user has the setting below.
- **`PIXINSIGHT_MCP_SCRIPT_DIALOGS` sets how far this goes:** only read the dialogs, also work them, or start scripts as PixInsight does. Reading is the default, because of the point before: working a dialog takes the person out of the one place where a script asks before it acts, and like `run_code`, that is for the user to turn on. With `read`, the server sends no action, the hook would refuse one, and the windows of PixInsight stay what they are. `plain` on `start_script` starts one script as PixInsight does.

### Preprocessing runs

WBPP has an automation mode: started with arguments, it loads frames, runs its pipeline without a dialog, and writes a log. Every behaviour this rests on is in [WBPP in its automation mode](reference/pixinsight-behaviour.md#wbpp-in-its-automation-mode).

- **A run is an instance of its own,** started the way PixInsight documents for scripts that run unattended: `-n=<slot> --automation-mode -r=<script>,<arguments> --force-exit`. It exits when its scripts have ended. So a run needs neither the instance of the user nor the worker, does not wait behind their jobs, and cannot leave a dialog open in them. The frames and settings that the user's WBPP has stored stay as they are, because an instance keeps its settings by its slot.
- **Its slots are its own.** A run takes the first free slot of three, with a lease like every instance of the server, and never one that anything else of the same server uses: a lease of one's own can be claimed again, so a shared slot would let the shadow instance take a run for its leftover. The instance of the user is never looked for among these slots.
- **Three scripts go onto its command line:** the one that starts a console log into the folder of the run, WBPP, and the one that ends the log. WBPP says in the console why it does not start a run, and starts a log of its own once a run begins, in the output folder. PixInsight writes one log at a time, so the first holds the beginning and the second the run.
- **Everything on that command line is checked first,** in `src/preprocessing/request.ts`. The launcher on Linux evaluates its arguments once more, so a path, a keyword, the name of an option and its value are refused if they hold a character that means something there. Each keyword is an argument of its own, because the separator that WBPP offers for several is such a character. Options that make WBPP run code are refused: those that name a script file, and the formula that it compiles to select frames. Paths are compared by where they lead, so that the output folder and a folder with frames cannot lie in one another by a link or by another spelling.
- **Only the name of a log is taken from the output of the instance.** The log is read from the folder `logs` of the output folder, whatever path the output names.
- **The outcome is read from what WBPP wrote.** A run is complete if its log holds the summary of the execution, was not started if the console says so, and broke off otherwise. The frame that the lights were registered to is read from the log as well, because a second run needs it to produce masters that lie on those of the first. The result gives the lines of that summary as they are, and what each group was calibrated with from the report of WBPP, by the headings and labels of that report. If the report reads otherwise in a later version, that part is left out and the rest stands.
- **Progress comes from the log,** which is found while the run lasts as the one that was not in the output folder before: the instance says where its log is in its output, and that output only reaches its file when the instance ends. The masters of a run are found the same way, by their names and not by the times of their files.
- **Cancelling ends the process that the server started for the run,** with the group it leads, and only while that process has not ended. Nothing is ended by what a slot holds: by the time PixInsight lists an instance there, it could be another one. That is allowed here and nowhere else for an instance at work, because this one holds nothing but the run.
- **A run outlives its server.** It is started detached and ends by itself, so closing a session does not throw hours of work away. Its lease names the process that was started, and a slot with such a process that lives is left alone by every server, also after the server of the run is gone.

### The processing library

Processing knowledge is data, not code: `processing/` holds workflows, stages, methods and practices as small Markdown files, and `get_guide` hands them out. The aim is that someone can contribute a method with one file and no knowledge of this code. The format is in the [processing library reference](reference/processing-library.md).

- **The place of a file says what it is.** Nothing is registered: no list in the code, no index file. A method in `methods/stretch/` shows up in the stage `stretch`, and so in every workflow that uses it.
- **Three levels keep the context small.** A workflow names stages, a stage lists methods with one line each, and the assistant reads a method when it gets there.
- **A guide is checked against the installation when it is handed out.** `requires` marks methods whose processes are missing. `parameters` lists the names a guide uses, and a name the installed version lacks gives a warning: plugins change parameter names between versions, and PixInsight ignores a wrong one without a word.
- **A method must say how to check its result.** The validator insists on the heading, because a process can report success and do nothing.
- **Loading is tolerant, the tests are strict.** At run time a file with a mistake is left out and listed in the catalog, so one bad file cannot take the library down. `npm test` fails on any problem in `processing/`, and `npm run test:live` checks every name in `parameters` against the installed processes.
- **Files are read on every call,** which costs a few milliseconds and lets a contributor edit and ask again.
- **Users can add folders** with `PIXINSIGHT_MCP_GUIDE_DIRS`. Their guides replace those of the server by ID, and are marked as added by the user, because a guide is an instruction to the assistant.
- **The front matter parser takes `key: text` and `key: [a, b]` only,** and refuses the rest. A YAML library would accept forms that this code would then have to handle, and a misread value would be worse than a refused file.

The library is a tool and not a set of skills, so that every client has it. In Claude Code, the plugin in `.claude-plugin/` adds one skill whose only job is to send the assistant to `get_guide`. The plugin declares the server in `plugin.json`, while `.mcp.json` stays relative for working in this repository: a plugin only expands the exact form `${CLAUDE_PLUGIN_ROOT}`.

### Any client, any model

Three things differ between clients, and each has a fallback that needs no configuration:

| Difference | Fallback |
|---|---|
| Not every client passes the instructions of a server on to its model | The catalog of `get_guide` opens with the same rules, and the description of `get_guide` says to start there |
| Not every client hands a picture from a tool to its model | Every preview also names its JPEG as `file`, which the model can open with a tool of its client |
| Providers accept different subsets of JSON Schema for a tool | The schemas use plain keywords only: no `$ref`, `oneOf`, `const`, `propertyNames` or formats. A unit test holds the list |

Skills and the plugin manifest are packaging for Claude Code. They add nothing a tool does not offer.

## Rules for working in the user's instance

These follow from the [measured behaviour](reference/pixinsight-behaviour.md). Breaking them loses user data or blocks the queue.

- Never send `--terminate` to an instance the server does not hold a lease for, and never kill it.
- Never use `executeOn( view, false )`: without a swap file the image does not count as modified.
- Never call `ImageWindow.close()` or `saveAs()` with default arguments: they open modal dialogs.
- Silent `saveAs` overwrites without asking, so check for existing files first. It also makes the file the path of the window, so use `FileFormatInstance` for anything that is not a working file.
- Render previews from a standalone `Image`, never from a window. Steps on a preview view do not add up, so a chain goes on a copy of the region.
- Leave no way to a modal question, but only where the effect is measured: `noGUIMessages` is set for the six geometric processes, and the result reports each loss. Refuse what undo cannot bring back.
- Never write to the file an image was opened from, and replace any other file only once the new one is complete.
- Trust only what a file holds when read back. `writeImageProperty` returning `true` proves nothing.
- Test for unsaved work with `ctx.isUnsaved`, because `isModified` is `false` for new images.
- Move through the history with `ctx.moveInHistory`, which keeps the active mask from coming back.
- Never pick an instance by "the first one running" without excluding every slot that has a lease.
- Do not change preferences, security settings or anything in the installation directory.
- Avoid `bringToFront`, `iconize` and `hide` unless the task needs it: they change the active window.

## Licensing constraints

PixInsight is commercial software by Pleiades Astrophoto. Its use is governed by Pleiades' own terms: the end user license agreement of PixInsight, the license of the PixInsight Class Library (PCL), which also covers most of the scripts that ship with PixInsight, and the [program rules for certified developers](https://pixinsight.com/security/cpd-rules/). This project follows these terms, and nothing they protect belongs in this repository.

For the code and the documentation here, that means:

- **No PixInsight or PCL material in the repository.** No source code, headers, scripts, documentation or tooltips of PixInsight are copied, included or quoted here, also not as an excerpt in a test or a guide. What the server needs to know about processes and scripts, it reads from the user's own installation at run time.
- **No reverse engineering.** Nothing here comes from taking PixInsight's binaries apart, and tools such as `strings` are not run on them. Behaviour is learned from `PixInsight --help`, from the documentation that comes with the installation, and from observing the running program through its documented interfaces.
- **No PCL-licensed source as material for machine learning.** The PCL license excludes its source code from that use. This is one more reason why none of it is in this repository, where assistants read along.
- **The documented interface only.** The server controls PixInsight through its command line, and installs nothing into it.
- **Local use.** A PixInsight license is personal, so the server talks over standard input and output to a client on the same computer, and is not meant to be hosted for others.

This project is independent. It is not made, certified, or endorsed by Pleiades Astrophoto, and everyone who uses it needs their own PixInsight license.

The project itself is under the GNU General Public License, version 3 or later. Version 3 is needed because the MCP SDK is under the Apache License 2.0, which version 2 of the GPL does not accept. The scripts in `pjsr/` run inside PixInsight as separate, unsigned scripts, and link no PCL code. The one exception to "separate" is `pjsr/dialogs/hook.js`, which runs in one file with a script of the user's installation: that file is written on the user's computer for one job and includes the script from where it is installed, so nothing of the script enters this repository or a release.

## Testing

| Level | Command | Needs PixInsight |
|---|---|---|
| Unit: queue, instances, leases, enum guard, policy, tools, against a fake PixInsight | `npm test` | No. CI runs it on Linux, Windows and macOS |
| Start: the built or packed server as a client sees it, with its tools and library | `node scripts/check-start.mjs [path to dist/index.js]` | No. CI runs it on three systems, and the release workflow on the installed package |
| Live: all measured behaviour plus MCP end to end | `npm run test:live` | Yes, on a developer's machine, because a PixInsight license cannot go into public CI |
| Live, with real data: metadata of a plate-solved master | Set `PIXINSIGHT_TEST_SOLVED_IMAGE` to a file, then `npm run test:live` | Yes, and a file that is not part of this repository |
| Smoke: as an MCP client against a visible instance | `node scripts/smoke.mjs` | Yes, also for checking new platforms |

- **Every PixInsight behaviour the server depends on has a live test,** so that an update of PixInsight shows what has changed.
- **Tests check the real effect,** such as the size stored in a JPEG, and not what a tool reports about itself. Test images are not square, because a square image hides swapped axes.
- **Tests wait for a state, not for a time.** A test that sleeps a fixed time and then looks fails on a slow machine.
- **Live tests use their own windowless instances** on slots 230 to 246, and clean up after themselves. They never touch an instance the developer has open.

## Roadmap

What comes next, roughly in this order:

1. **Platforms.** Run with a real PixInsight on Windows and macOS. So far, only the unit tests and the start of the server are verified there.
2. **Assistants.** A whole workflow with an assistant other than Claude.
3. **More workflows** in the processing library, first of all for broadband color data.
4. **Windows of PixInsight:** arranging them, side-by-side comparison, workspaces.
5. **More safety nets:** trying a new plugin on a small crop in the shadow instance first, and a check of the setup, such as paths of external programs and stale swap files.
6. **Distribution:** an npm package, and a bundle for Claude Desktop.

### Known limits

- **Windows cannot list instances:** `-e` opens a message box there. So an own instance that hangs cannot be ended, a leftover on a slot cannot be told from a free slot, a restart of PixInsight shows only once a job has found no instance, and the enum guard cannot clean up after a hang, so it refuses with `busy` instead of storing a verdict.
- **A script is worked through its dialog, not run with parameters.** PixInsight offers no documented way to run a script of the Script menu with parameters from outside. What only a mouse can do in a control that PixInsight draws itself stays with the user, and so does every window a script opens that is neither one of its dialogs, a message box, nor a file chooser on V8.
- **A preprocessing run cannot assign a master by hand,** and nothing checks the names of its options: WBPP ignores a name it does not know. Its instance has settings of its own, so what needs the catalogs or the settings of the user's PixInsight fails there, as the astrometric solution does.
- **A picture in a cell of a table cannot be read,** such as the marks in the status columns of WBPP: PixInsight hands out an empty picture for it.
- **On the classic engine, a control that a script neither keeps nor lays out with a sizer is not found,** such as one that is placed by its coordinates and held in a local variable only.
- **A classic script that reads `result` of a message box** instead of what `execute()` returns gets 0 after an answer through the window of the hook: that property cannot be written. No script that PixInsight ships here does that.
- **Scripts do not run in worker mode,** although a dialog can be worked without a window: a window that the hook does not replace would block the instance for good.
- **No real script with a license system was tried.** A script that checks how it was started may refuse to run through the file of the server, which is what `plain` is for.
- **What a script or code does outside the open images is not reported:** files, settings, and small local changes to pixels.
- **Enumerated values inside table parameters are not checked** by the enum guard.
