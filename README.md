# TapScribe

[![ci](https://github.com/amantibrewal310/tapscribe/actions/workflows/ci.yml/badge.svg)](https://github.com/amantibrewal310/tapscribe/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Write and debug Android UI tests without leaving VS Code. TapScribe puts three things in one editor tab: your test script, a live view of the device screen, and logcat.

The part that saves real time: the screen is interactive, and it can write your script for you. Turn on Record, use your app by clicking and dragging on the screen view, and every gesture is appended to the script as a step. Hit Run to play the whole thing back.

```
+------------------------------------+---------------------+
|  Test script                       |  Device screen      |
|                                    |                     |
|  launch com.my.app                 |   [live emulator    |
|  wait 1s                           |    screen: click    |
|  tap 540 1200                      |    to tap, drag     |
|  press enter          + run output |    to swipe, hold   |
+------------------------------------+    to long-press]   |
|  Logcat                            |                     |
|                                    |                     |
|  I/MyApp: started                  |                     |
|  D/Auth: token ok                  |                     |
|  E/Net: timeout   + filter, levels |                     |
+------------------------------------+---------------------+
```

## Requirements

- [adb](https://developer.android.com/tools/adb) from the Android platform tools, on your PATH (or point `tapscribe.adbPath` at it)
- A running emulator or a device with USB debugging enabled
- VS Code 1.98 or newer

TapScribe talks to the device only through adb, so anything adb can reach works: local emulators, physical phones, remote devices over `adb connect`.

## Getting started

1. Install the extension and start an emulator (or plug in a phone).
2. Open the command palette and run **TapScribe: Open Test Lab**.
3. Pick a device in the middle panel if you have more than one.
4. Click around on the screen view. Clicks tap, drags swipe, holding clicks long-presses. The bar under the screen has Back, Home and Recents.
5. Turn on **Record**, walk through the flow you want to test, and watch the steps appear in the editor.
6. Press **Run** to play the script back. Step results show up under the editor; app logs stream on the right.

Scripts save to `.taps` files, which get syntax highlighting.

## The script language

One step per line. Lines starting with `#` or `//` are comments. Case does not matter for keywords.

| Step | Examples |
| --- | --- |
| Tap | `tap 540 1200`, `tap on 540, 1200` |
| Long press | `long press 540 1200`, `long press 540 1200 for 800ms` |
| Swipe by direction | `swipe up`, `swipe left in 500ms` |
| Swipe by coordinates | `swipe from 100 200 to 100 800 in 300ms`, `swipe 100 200 100 800` |
| Type text | `type "hello world"`, `type hello` |
| Press a key | `press back`, `press home`, `press enter`, `press volume up`, `press KEYCODE_CAMERA` |
| Wait | `wait 2s`, `wait 500ms`, `pause for 1.5 seconds` |
| Launch an app | `launch com.example.app`, `open the app com.example.app` |
| Stop an app | `stop com.example.app`, `close com.example.app` |
| Raw adb | `adb shell pm list packages` |

Anything the language does not cover can be written as a raw `adb` line and it runs as-is. Directional swipes ask the device for its resolution, so the same script works across screen sizes.

If a line does not parse, the run does not start. Every bad line is listed with its line number and a hint, not just the first one.

Known key names for `press`: back, home, enter, tab, space, delete, backspace, escape, menu, search, power, camera, recents, volume up, volume down, up, down, left, right. Raw `KEYCODE_*` names also work.

## Record mode

With Record on, gestures on the screen view still control the device, and each one is appended to the script:

- a click becomes `tap x y`
- holding for half a second becomes `long press x y for ...ms`
- a drag becomes `swipe from x y to x2 y2 in ...ms`, timed by how long the drag took

Coordinates are mapped from the scaled screen image back to real device pixels, so recorded steps replay exactly where you clicked. Typing is not recorded; add `type` and `press` steps by hand where the flow needs them, plus `wait` steps where the app needs time to settle.

## Logcat panel

The right panel streams `adb logcat` for the selected device. You can filter by minimum level (verbose through error) and by substring, clear the device buffer, and toggle follow mode. The buffer is capped (5000 lines by default) so long sessions do not degrade the editor.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `tapscribe.adbPath` | `adb` | Path to the adb executable |
| `tapscribe.screenMode` | `auto` | `video` streams H.264, `screenshots` polls screencap, `auto` picks video when supported |
| `tapscribe.videoBitrateMbps` | `8` | Bitrate of the video stream |
| `tapscribe.screenRefreshMs` | `400` | Screenshot mode only: delay between captures in milliseconds |
| `tapscribe.logBufferLines` | `5000` | Maximum logcat lines kept in the panel |

## How it works

There is no agent to install on the device. The screen view streams H.264 from `adb exec-out screenrecord` (the phone's own hardware encoder), which the extension splits into decoder-ready chunks and the webview decodes with WebCodecs onto a canvas. screenrecord stops itself every three minutes; TapScribe restarts it and the stream resumes on the next keyframe. On devices or editors where video is not available, it falls back to polling `adb exec-out screencap` screenshots. Gestures run through `adb shell input` and logs come from `adb logcat` in both modes.

Every adb invocation goes through `execFile`/`spawn` with argument arrays, never through a shell string, and the webview runs under a strict content security policy with no remote content.

The script language lives in `src/script/parser.ts` as a small, dependency-free module. The runner (`src/script/runner.ts`) executes parsed steps against a driver interface, which is adb in production and a fake in tests. The H.264 stream parsing lives in `src/video/h264.ts`, also pure and unit-tested.

## Development

```bash
npm install
npm run watch     # compile on change
```

Press F5 in VS Code to launch an Extension Development Host. `npm test` runs the suite (it downloads a VS Code build on first run), and `npm run lint` checks the source.

The design is documented in [docs/architecture.md](docs/architecture.md), and the reasoning behind the bigger choices (including the ones reversed after testing on a real emulator) lives in [docs/decisions/](docs/decisions/).

## Troubleshooting

**Typed text loses its first characters** (`battery` arrives as `tery`):
the `type` step fires as soon as the previous step finishes, but Android
needs a moment to focus a text field after you tap it, and keystrokes sent
during that animation are dropped. Put a `wait 2s` between tapping a field
and typing into it.

**The screen view freezes or lags behind the device**: check the status
line under the screen. In video mode it recovers on its own within a
couple of seconds (the stream restarts to get a fresh keyframe); if it
says screenshots, the device could not stream video and updates arrive at
the polling rate instead.

## Limitations

- `input text` handles ASCII only; emoji and non-Latin text will not type correctly
- Rotating the device freezes the video stream until its next restart; toggle `tapscribe.screenMode` or reopen the panel to recover sooner
- DRM-protected and other secure surfaces come out black, in both video and screenshot mode
- Steps target coordinates, not UI elements, so a big layout change means re-recording (selector-based targeting via uiautomator is on the wishlist)

## License

[MIT](LICENSE)
