# Changelog

All notable changes to TapScribe are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [0.3.0] - 2026-08-05

### Fixed

- The device screen stayed blank in video mode when a device was connected
  after the Test Lab was already open. Refreshing the device list now restarts
  the screen pipeline, which previously only the device picker did.
- Taps and swipes landed in the wrong place on devices with a display size
  override (the Pixel "screen resolution" setting, or `wm size`). Capture
  returns physical pixels while touches use the logical display, and the
  content is letterboxed between the two; gestures are now mapped through the
  input viewport instead of being passed through as bitmap coordinates.
- `screenrecord` kept streaming, and the webview kept decoding, while the Test
  Lab tab was in the background. Video now stops when the panel is hidden and
  resumes with a fresh keyframe when it comes back.
- A stale "adb not reachable" message could sit over the screen after a device
  reappeared.

### Changed

- The webview CSP nonce comes from `crypto.randomBytes` instead of
  `Math.random()`.

### Internal

- `npm test` works again on a fresh clone: `@vscode/test-electron` 2.x looked
  for a macOS `Electron` binary that current VS Code no longer ships.
- Video support is covered end to end, decoding recorded device bytes through
  WebCodecs in a real webview, alongside unit tests for the new coordinate
  mapping. 33 tests to 51.

## [0.2.0] - 2026-07-06

### Added

- Live video for the device screen: H.264 from `screenrecord` decoded with WebCodecs, replacing screenshot polling as the default (#2)
- `tapscribe.screenMode` (auto/video/screenshots) and `tapscribe.videoBitrateMbps` settings
- Automatic fallback to screenshot polling when the device or editor cannot stream

### Changed

- Screenshot polling remains available and is now the explicit fallback path; `tapscribe.screenRefreshMs` applies only to it

## [0.1.0] - 2026-07-05

First real release.

### Added

- Test Lab: script editor, live device screen and logcat in one three-panel tab
- Plain-English script language (tap, long press, swipe, type, press, wait, launch, stop) with raw adb passthrough
- Record mode: gestures on the screen view run on the device and are written into the script as steps
- Interactive screen view: click to tap, hold to long-press, drag to swipe, with Back/Home/Recents buttons below
- Logcat streaming with level filter, text filter, follow mode and a capped buffer
- Device picker for multi-device setups
- `.taps` files with syntax highlighting
- Settings for adb path, screen refresh rate and log buffer size

### Changed

- Rebuilt from the earlier two-panel prototype; adb calls are async and shell-free, and the webview ships a strict CSP

### Removed

- The `showEmulator` command from the prototype; use `TapScribe: Open Test Lab`
