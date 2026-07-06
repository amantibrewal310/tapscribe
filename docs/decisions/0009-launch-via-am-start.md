# 9. Launch apps with am start, not monkey

Date: 2026-07-05, decided by a failing test on a live emulator. Status: accepted.

## Context

The classic one-liner for launching an app by package name is
`adb shell monkey -p <pkg> -c android.intent.category.LAUNCHER 1`. The
first implementation used it. Running the demo script against an Android
16 (API 36) emulator failed on step one: monkey dumps its argument parsing
to stderr and exits non-zero on recent images, even when asked to do
almost nothing.

## Decision

Resolve the launcher activity first with
`cmd package resolve-activity --brief -c android.intent.category.LAUNCHER <pkg>`
and start the resulting component with `am start -n`. Both commands are
stable from API 24 up. A missing or unlaunchable package surfaces as a
readable error before anything runs.

## Consequences

- `launch` works on current system images and reports failures precisely
  (no launchable activity vs. am errors) instead of monkey's noise.
- Two adb round-trips instead of one per launch; irrelevant at the
  frequency scripts launch apps.
- The lesson recorded here: device-facing behavior gets validated against
  a real device before release. The unit suite could never have caught
  this.
