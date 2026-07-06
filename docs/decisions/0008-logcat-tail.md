# 8. Logcat attaches near the tail

Date: 2026-07-05, revised 2026-07-05 after emulator testing. Status: accepted.

## Context

The log pane spawns `adb logcat` per selected device and streams lines to
the webview. The first version ran plain `logcat -v time`, which replays
the device's entire ring buffer before following. On a freshly booted
emulator that was 64,000 lines delivered instantly, flooding the webview
and burying anything recent.

## Decision

Attach with `-T 300`: start from the most recent lines, then follow.
Client-side, lines are batched (a 150ms flush timer in the extension,
plus per-chunk line reassembly), the in-memory buffer is capped
(`logBufferLines`, default 5000), and the DOM never renders more than the
newest 2000 matching lines. Level and substring filtering happen over the
full in-memory buffer so loosening a filter brings older lines back.

## Consequences

- Opening the panel shows recent context immediately instead of a boot
  flood, and a chatty device cannot degrade the editor.
- History beyond the buffer is gone; anyone needing full logs can run
  `adb logcat -d` themselves or raise the cap.
- The 64k-line number is worth keeping in this record because it is the
  kind of thing a design doc would never predict; it was measured, not
  guessed.
