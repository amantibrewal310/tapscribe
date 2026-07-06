# 6. One webview, stacked layout

Date: 2026-07-05, revised 2026-07-05 after first real use. Status: accepted.

## Context

The three panels could have been separate VS Code views (a sidebar tree, a
panel view, an editor) or one webview owning the whole layout. And within
one webview, the first version used three vertical columns: editor,
device, logcat.

## Decision

One webview panel owning all three panes. The three-column layout did not
survive contact with a real session: a portrait phone is tall and narrow,
so giving it a full center column wasted width, and (worse) the column was
sized `auto`, letting the 1080px screenshot inflate it until the logcat
pane's controls crushed. The layout is now a 50/50 vertical stack of
editor and logcat on the left with the device screen in its own
fractionally-sized column on the right, like an editor with a terminal
below and a preview beside it.

## Consequences

- One webview keeps state coordination trivial (one message channel, one
  `setState`) and the whole lab opens with one command. The cost is that
  the panes cannot be individually rearranged by the user; a splitter is
  plausible future work.
- The sizing lesson is recorded in a CSS comment where it happened: never
  let a grid track size itself from a screenshot's natural width.
- A dark screenshot on a dark theme looked like a dead panel, so the
  screen surface has a visible border, and the extension wakes the device
  on attach because a sleeping display screencaps as pure black.
