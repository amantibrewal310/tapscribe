# Architecture

TapScribe is one extension host process plus one webview. Everything the
extension knows about a device comes through the adb binary; nothing is
installed on the device itself.

```
+----------------------- extension host ------------------------+
|                                                                |
|  extension.ts     registers tapscribe.openTestLab              |
|  panel.ts         TestLabPanel: owns everything below          |
|                                                                |
|  adb.ts           AdbClient: execFile/spawn wrappers           |
|  script/parser.ts script text -> steps (pure)                  |
|  script/runner.ts steps -> device calls (pure, driver iface)   |
|  video/h264.ts    annex b bytes -> decoder chunks (pure)       |
|                                                                |
+------------------+---------------------------+-----------------+
                   |  postMessage (JSON+binary)|
+------------------v---------------------------v-----------------+
|  webview (media/main.js, strict CSP, no remote content)        |
|  editor pane | device canvas/img + nav bar | logcat pane       |
+----------------------------------------------------------------+
                   |
              adb binary
                   |
        emulator or physical device
```

## The panes

- **Script editor** (top left): a textarea holding the test script, with the
  run output console below it. Content persists through webview reloads via
  `vscode.setState`.
- **Device screen** (right): live video (H.264 via screenrecord decoded with
  WebCodecs onto a canvas) or polled screenshots as fallback. Clicks, drags
  and holds are mapped from displayed pixels back to device pixels and run
  as adb input commands. Back/Home/Recents buttons sit below.
- **Logcat** (bottom left): a spawned `adb logcat` stream with level and
  substring filtering done client-side over a capped in-memory buffer.

## Data flow for the two headline features

**Run**: editor text goes to the extension, `parseScript` turns it into
steps or a list of per-line errors, `ScriptRunner` executes steps one at a
time against `AdbClient`, and each step start/end is posted back to the
webview console.

**Record**: a gesture on the screen surface is translated to device
coordinates in the webview, executed live through adb, and (when Record is
on) rendered back into script text by `stepToSource` and appended to the
editor. Recording is transcription of what already happened, not a separate
capture mode.

## Message protocol

Webview to extension: `ready` (carries WebCodecs capability), `run`,
`stop`, `gesture`, `navKey`, `selectDevice`, `refreshDevices`, `clearLogs`,
`saveScript`, `loadScript`, `videoError`.

Extension to webview: `devices`, `screenMode`, `video` (binary chunk),
`screen` (screenshot data URI), `screenError`, `screenModeNotice`, `logs`,
`logsCleared`, `runStarted`, `stepStart`, `stepEnd`, `runFinished`,
`parseIssues`, `recordedStep`, `scriptLoaded`, `gestureError`.

## What is deliberately pure

`script/parser.ts`, `script/runner.ts` (behind a `DeviceDriver` interface)
and `video/h264.ts` import nothing from vscode and nothing from adb. That is
what makes the test suite fast and honest: parser and protocol edge cases
are covered by unit tests, and only the thin adb and webview glue needs a
live device to validate.

## Decision records

The reasoning behind the bigger choices lives in [decisions/](decisions/),
one short record per decision, including the ones we reversed after testing
against a real emulator.
