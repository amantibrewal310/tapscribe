# Changelog

All notable changes to TapScribe are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

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
