# 10. Keep the testable core free of vscode and adb

Date: 2026-07-05. Status: accepted.

## Context

VS Code extension tests run inside a downloaded editor instance, which
makes every test that touches the `vscode` module slow to bootstrap and
awkward to debug. Tests that touch a real device are worse: they need an
emulator. If most of the logic lives in the panel class, most of the logic
is effectively untested.

## Decision

The interesting logic lives in modules that import neither `vscode` nor
`child_process`:

- `script/parser.ts`: text in, steps or per-line issues out.
- `script/runner.ts`: steps in, calls on a `DeviceDriver` interface out.
  `AdbClient` satisfies the interface structurally in production; tests
  pass a fake that records calls and can fail on command.
- `video/h264.ts`: bytes in, decoder chunks out.

`panel.ts` and `adb.ts` stay as thin glue, and their behavior is validated
by a headless smoke script run against a live emulator before releases
(the compiled modules driven directly by node, no webview involved).

## Consequences

- The suite runs in well under a second of actual test time and covers the
  cases that actually break: parser edge forms, runner stop semantics,
  NAL streams split at every possible byte boundary.
- The glue can still be wrong in device-specific ways, which is exactly
  what the emulator smoke run exists for; it has caught two release
  blockers so far (monkey launch, logcat flood) and one blank-screen bug
  (the h264 flush).
- Contributors can extend the language or the protocol parser without
  owning an Android setup at all.
