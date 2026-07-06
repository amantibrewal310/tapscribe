# 1. Talk to devices only through adb

Date: 2026-07-05. Status: accepted.

## Context

The extension needs to see the screen, inject input, read logs and launch
apps. Tools in this space either install an agent on the device (scrcpy
pushes a server jar, Appium installs instrumentation) or drive everything
through adb commands.

## Decision

Everything goes through the adb binary the user already has: screencap and
screenrecord for the screen, `input` for gestures, `logcat` for logs,
`am`/`cmd package` for app control. TapScribe installs nothing on the
device.

## Consequences

- Works unchanged on emulators, USB phones and `adb connect` remotes, and
  there is no agent to keep updated or to trip security review.
- The ceiling is whatever adb exposes. Input injection is fire-and-forget
  (no touch feedback), and screen capture quality depends on what the
  device's screenrecord can do.
- If we ever need lower latency than screenrecord delivers, the named next
  step is scrcpy-server integration, recorded as future work in issue #2
  rather than done preemptively.
