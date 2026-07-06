# Decision records

Short records of the design decisions behind TapScribe: the context we were
in, what we chose, and what it cost us. Records are numbered in the order
the decisions were made and never edited to look smarter in hindsight; when
a decision gets reversed, the record says so and points at the replacement.

1. [Talk to devices only through adb](0001-adb-only.md)
2. [No shell strings, no arbitrary shell execution](0002-no-shell-strings.md)
3. [A small plain-English script language](0003-script-language.md)
4. [Steps target coordinates, not UI elements](0004-coordinates-not-selectors.md)
5. [Record mode transcribes live gestures](0005-record-is-transcription.md)
6. [One webview, stacked layout](0006-layout.md)
7. [Screen mirroring: screenshots first, then video](0007-screen-mirroring.md)
8. [Logcat attaches near the tail](0008-logcat-tail.md)
9. [Launch apps with am start, not monkey](0009-launch-via-am-start.md)
10. [Keep the testable core free of vscode and adb](0010-pure-core.md)
