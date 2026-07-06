# 7. Screen mirroring: screenshots first, then video

Date: 2026-07-05 (screenshots), 2026-07-06 (video). Status: accepted.

## Context

The screen view is the heart of the tool and went through three designs.
v1 polled `screencap` on a fixed 2s timer. That is simple and universal
but tops out around 3-5 fps with worst-case latency of a full interval, and
users immediately called it laggy.

A WebSocket transport was suggested and evaluated: it does not help,
because there is no network hop to replace. The pipeline is device -> adb
-> extension host -> webview, all local; the cost lives in the capture
step (screencap renders and PNG-encodes a full frame, 100-200ms), not in
how bytes move afterwards.

## Decision

Two modes, picked automatically:

- **Video (default)**: `adb exec-out screenrecord --output-format=h264 -`
  streams from the device's hardware encoder. A pure Annex B parser in the
  extension host splits NAL units, groups SPS/PPS with each IDR into key
  chunks, and derives the codec string from the SPS. Chunks go to the
  webview as binary postMessage and WebCodecs decodes onto a canvas with
  `optimizeForLatency`. screenrecord's designed three-minute exit is
  restarted transparently; the decoder resumes at the next keyframe.
- **Screenshots (fallback)**: the old polling, kept for forced settings,
  missing WebCodecs, or devices whose screenrecord cannot emit h264. It
  was also improved before video landed: captures self-schedule from the
  end of the previous one, and gestures, nav presses and script steps each
  trigger an immediate capture.

We chose screenrecord over bundling scrcpy-server: no third-party jar on
the device, no protocol to track, at the cost of higher latency and no
rotation handling. scrcpy-server remains the named escalation path if
screenrecord's latency ever stops being acceptable (issue #2).

## Consequences

- Motion is smooth in video mode and the code carries no new runtime
  dependencies; the decoder ships with Chromium inside VS Code.
- Live testing found the flush problem: screenrecord goes silent on a
  static screen, and an Annex B NAL only terminates at the next start
  code, so the only frame ever sent sat buffered and the panel opened
  blank. The parser's `flush()`, called after a 120ms quiet gap, emits
  that trailing frame. There is a unit test reproducing it.
- Known limits are documented rather than hidden: rotation freezes the
  stream until the next restart, and secure surfaces are black in both
  modes.
