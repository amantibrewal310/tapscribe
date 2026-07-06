# 5. Record mode transcribes live gestures

Date: 2026-07-05. Status: accepted.

## Context

Record-and-replay tools usually have a distinct recording session: arm it,
perform actions, stop, get a file. We also considered making the screen
interactive only while recording.

## Decision

The screen is always interactive: clicks, drags and holds drive the device
whether or not Record is on. Record is a toggle that additionally
transcribes each executed gesture into script text (via the same
`stepToSource` used everywhere) and appends it to the editor.

There is no hidden recorder state: what lands in the editor is the
rendering of the exact step that just ran, and the red outline around the
screen is the only mode indicator needed.

## Consequences

- The user can freely mix driving the app, recording some steps, hand
  editing, and recording more. The editor is the single source of truth.
- Because recorded text goes through the same parser on playback, a
  render-and-reparse round-trip test locks the two directions together;
  record mode cannot drift from the language.
- Timing is not recorded (a deliberate simplification): users add `wait`
  steps where the app needs settle time. Auto-inserting waits from gesture
  gaps was considered and rejected as unpredictable.
- Typed text is not captured either; keyboard capture in a webview is
  messy and half-working input recording is worse than none.
