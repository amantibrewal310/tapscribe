import { ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import * as vscode from "vscode";
import { AdbClient, frameToTouch, InputGeometry, KEY_MAP } from "./adb";
import { parseScript, stepToSource, Step } from "./script/parser";
import { ScriptRunner } from "./script/runner";
import { AnnexBParser } from "./video/h264";

interface GestureMessage {
  type: "gesture";
  gesture: "tap" | "longpress" | "swipe";
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  /** Bitmap the coordinates were measured against, for touch-space mapping. */
  srcWidth?: number;
  srcHeight?: number;
  /** True while record mode is on: the gesture also becomes a script step. */
  record?: boolean;
}

function getNonce(): string {
  return randomBytes(24).toString("base64");
}

/**
 * The Test Lab: one webview with the script editor, the live device screen,
 * and logcat side by side. Owns the adb client, the screenshot loop, the
 * logcat stream, and the script runner for its lifetime.
 */
export class TestLabPanel {
  public static current: TestLabPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly adb: AdbClient;
  private readonly runner: ScriptRunner;
  private readonly disposables: vscode.Disposable[] = [];

  private logcat: ChildProcess | undefined;
  private logQueue: string[] = [];
  private logFlushTimer: NodeJS.Timeout | undefined;
  private screenTimer: NodeJS.Timeout | undefined;
  private capturing = false;
  private screenFailures = 0;

  private screenMode: "video" | "screenshots" = "screenshots";
  private webCodecsAvailable = false;
  private screenrecord: ChildProcess | undefined;
  private videoParser = new AnnexBParser();
  private videoFlushTimer: NodeJS.Timeout | undefined;
  private videoChunksSent = 0;
  private videoFailures = 0;
  private videoStopping = false;
  private lastVideoRestart = 0;
  private geometry: InputGeometry | undefined;

  public static createOrShow(extensionUri: vscode.Uri): void {
    if (TestLabPanel.current) {
      TestLabPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "tapscribe.testLab",
      "TapScribe Test Lab",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    TestLabPanel.current = new TestLabPanel(panel, extensionUri);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.adb = new AdbClient(this.config<string>("adbPath", "adb"));
    this.runner = new ScriptRunner(this.adb);

    this.panel.webview.html = this.renderHtml(extensionUri);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // retainContextWhenHidden keeps the webview alive in the background, so
    // nothing else would stop screenrecord pushing megabits at a tab nobody
    // is looking at. The screenshot loop already gates itself on visibility.
    this.panel.onDidChangeViewState(
      () => {
        if (this.screenMode !== "video") {
          return;
        }
        if (this.panel.visible) {
          if (!this.screenrecord) {
            this.startVideo();
          }
        } else {
          this.stopVideo();
        }
      },
      null,
      this.disposables
    );
    this.panel.webview.onDidReceiveMessage(
      (message) => this.onMessage(message),
      null,
      this.disposables
    );
    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration("tapscribe")) {
          this.videoFailures = 0;
          this.startScreenPipeline();
        }
      },
      null,
      this.disposables
    );
  }

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration("tapscribe").get<T>(key, fallback);
  }

  private post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  // ---- inbound messages -------------------------------------------------

  private async onMessage(message: any): Promise<void> {
    switch (message.type) {
      case "ready":
        this.webCodecsAvailable = Boolean(message.webCodecs);
        await this.refreshDevices();
        this.startScreenPipeline();
        break;
      case "refreshDevices":
        await this.refreshDevices();
        break;
      case "selectDevice":
        this.adb.setDevice(message.serial || undefined);
        this.screenFailures = 0;
        this.videoFailures = 0;
        this.geometry = undefined;
        this.restartLogcat();
        void this.wakeDevice();
        this.startScreenPipeline();
        break;
      case "videoError":
        // The webview decoder gave up; drop to screenshots for this session.
        this.fallbackToScreenshots(String(message.message ?? "decode error"));
        break;
      case "videoRestart":
        // The decoder joined mid-stream and needs a fresh keyframe, which
        // only a new screenrecord provides. Rate-limited against loops.
        if (
          this.screenMode === "video" &&
          Date.now() - this.lastVideoRestart > 5000
        ) {
          this.lastVideoRestart = Date.now();
          this.startVideo();
        }
        break;
      case "run":
        await this.runScript(String(message.script ?? ""));
        break;
      case "stop":
        this.runner.stop();
        break;
      case "gesture":
        await this.onGesture(message as GestureMessage);
        this.captureNow();
        break;
      case "navKey":
        await this.onNavKey(String(message.key), Boolean(message.record));
        break;
      case "clearLogs":
        try {
          await this.adb.clearLogcat();
        } catch {
          // The device buffer may refuse to clear; the view clears anyway.
        }
        this.post({ type: "logsCleared" });
        break;
      case "saveScript":
        await this.saveScript(String(message.text ?? ""));
        break;
      case "loadScript":
        await this.loadScript();
        break;
    }
  }

  private async wakeDevice(): Promise<void> {
    // Emulator and phone displays sleep after a while; a black screenshot
    // reads as a broken panel. Waking is harmless if already awake.
    if (!this.adb.device) {
      return;
    }
    try {
      await this.adb.key("KEYCODE_WAKEUP");
    } catch {
      // Screen capture will surface real device errors; ignore this one.
    }
  }

  private async refreshDevices(): Promise<void> {
    try {
      const devices = (await this.adb.listDevices()).filter(
        (d) => d.state === "device"
      );
      const previous = this.adb.device;
      if (!previous || !devices.some((d) => d.serial === previous)) {
        this.adb.setDevice(devices[0]?.serial);
        this.geometry = undefined;
        this.restartLogcat();
        void this.wakeDevice();
        // The screenshot loop reschedules itself and picks a new device up on
        // its own, but the video pipeline is started once and would otherwise
        // stay dead for a device that appeared after the panel opened.
        if (this.adb.device !== previous) {
          this.screenFailures = 0;
          this.videoFailures = 0;
          this.startScreenPipeline();
        }
      }
      this.post({ type: "devices", devices, selected: this.adb.device });
      if (!this.logcat && this.adb.device) {
        this.restartLogcat();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.post({
        type: "devices",
        devices: [],
        selected: undefined,
        error: `adb not reachable: ${detail}`,
      });
    }
  }

  private async runScript(script: string): Promise<void> {
    if (this.runner.running) {
      return;
    }
    const { steps, issues } = parseScript(script);
    if (issues.length > 0) {
      this.post({ type: "parseIssues", issues });
      return;
    }
    if (steps.length === 0) {
      this.post({ type: "parseIssues", issues: [{ line: 0, source: "", message: "The script has no steps." }] });
      return;
    }
    if (!this.adb.device) {
      this.post({ type: "runFinished", ok: false, ran: 0, total: steps.length, stopped: false, message: "No device connected." });
      return;
    }
    this.post({ type: "runStarted", total: steps.length });
    const summary = await this.runner.run(steps, {
      onStepStart: (step, index, total) =>
        this.post({ type: "stepStart", index, total, line: step.line, source: step.source }),
      onStepEnd: (step, index, ok, detail) => {
        this.post({ type: "stepEnd", index, line: step.line, source: step.source, ok, detail });
        this.captureNow();
      },
    });
    this.post({ type: "runFinished", ...summary });
  }

  /**
   * Resolves a point on the mirrored screen into the coordinate space touches
   * use. Without a usable frame size or geometry the point is passed through,
   * which is correct on every device where capture and touch spaces agree.
   */
  private async toTouch(
    x: number,
    y: number,
    message: GestureMessage
  ): Promise<{ x: number; y: number }> {
    const frame = { width: message.srcWidth ?? 0, height: message.srcHeight ?? 0 };
    if (frame.width <= 0 || frame.height <= 0) {
      return { x, y };
    }
    try {
      this.geometry ??= await this.adb.inputGeometry();
    } catch {
      return { x, y };
    }
    return frameToTouch(x, y, frame, this.geometry);
  }

  private async onGesture(message: GestureMessage): Promise<void> {
    if (!this.adb.device) {
      return;
    }
    const start = await this.toTouch(message.x, message.y, message);
    let step: Step;
    if (message.gesture === "swipe") {
      const end = await this.toTouch(
        message.x2 ?? message.x,
        message.y2 ?? message.y,
        message
      );
      step = {
        kind: "swipeCoords",
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        durationMs: Math.max(50, Math.min(2000, message.durationMs ?? 300)),
      };
    } else if (message.gesture === "longpress") {
      step = {
        kind: "longpress",
        x: start.x,
        y: start.y,
        durationMs: Math.max(400, Math.min(3000, message.durationMs ?? 600)),
      };
    } else {
      step = { kind: "tap", x: start.x, y: start.y };
    }
    try {
      if (step.kind === "tap") {
        await this.adb.tap(step.x, step.y);
      } else if (step.kind === "longpress") {
        await this.adb.longPress(step.x, step.y, step.durationMs);
      } else if (step.kind === "swipeCoords") {
        await this.adb.swipe(step.x1, step.y1, step.x2, step.y2, step.durationMs);
      }
      if (message.record) {
        this.post({ type: "recordedStep", text: stepToSource(step) });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.post({ type: "gestureError", message: detail });
    }
  }

  private async onNavKey(key: string, record: boolean): Promise<void> {
    const keycode = KEY_MAP[key];
    if (!keycode || !this.adb.device) {
      return;
    }
    try {
      await this.adb.key(keycode);
      if (record) {
        this.post({ type: "recordedStep", text: `press ${key}` });
      }
      this.captureNow();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.post({ type: "gestureError", message: detail });
    }
  }

  private async saveScript(text: string): Promise<void> {
    const target = await vscode.window.showSaveDialog({
      filters: { "TapScribe script": ["taps"], "All files": ["*"] },
      defaultUri: vscode.Uri.joinPath(
        vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(process.env.HOME ?? "/"),
        "test.taps"
      ),
    });
    if (target) {
      await vscode.workspace.fs.writeFile(target, Buffer.from(text, "utf8"));
      vscode.window.showInformationMessage(`Saved ${target.fsPath}`);
    }
  }

  private async loadScript(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "TapScribe script": ["taps"], "All files": ["*"] },
    });
    if (picked?.[0]) {
      const bytes = await vscode.workspace.fs.readFile(picked[0]);
      this.post({ type: "scriptLoaded", text: Buffer.from(bytes).toString("utf8") });
    }
  }

  // ---- device screen ----------------------------------------------------

  /**
   * Picks video or screenshot mode from the setting and webview capability,
   * then (re)starts whichever pipeline applies. Safe to call repeatedly.
   */
  private startScreenPipeline(): void {
    const preference = this.config<string>("screenMode", "auto");
    const wantVideo =
      preference === "video" ||
      (preference === "auto" && this.webCodecsAvailable && this.videoFailures < 3);
    this.screenMode = wantVideo ? "video" : "screenshots";
    this.post({ type: "screenMode", mode: this.screenMode });
    if (this.screenMode === "video") {
      this.stopScreenLoop();
      this.startVideo();
    } else {
      this.stopVideo();
      this.restartScreenLoop();
    }
  }

  private fallbackToScreenshots(reason: string): void {
    this.videoFailures = 99;
    this.stopVideo();
    this.screenMode = "screenshots";
    this.post({ type: "screenMode", mode: this.screenMode });
    this.post({
      type: "screenModeNotice",
      text: `Video stream unavailable (${reason}); using screenshots.`,
    });
    this.restartScreenLoop();
  }

  private startVideo(): void {
    this.stopVideo();
    if (!this.adb.device || !this.panel.visible) {
      return;
    }
    this.videoStopping = false;
    this.videoChunksSent = 0;
    this.videoParser.reset();
    const bitrate = this.config<number>("videoBitrateMbps", 8);
    const startedAt = Date.now();
    this.screenrecord = this.adb.streamScreenrecord(
      bitrate,
      (bytes) => {
        this.sendVideoChunks(this.videoParser.push(bytes));
        // screenrecord goes quiet on a static screen; flush the trailing
        // frame once the burst has clearly ended.
        if (this.videoFlushTimer) {
          clearTimeout(this.videoFlushTimer);
        }
        // Long enough that adb stalling mid-frame will not get flushed as
        // a truncated NAL, short enough to feel instant on a static screen.
        this.videoFlushTimer = setTimeout(() => {
          this.sendVideoChunks(this.videoParser.flush());
        }, 250);
      },
      (_code, stderr) => {
        if (this.videoStopping) {
          return;
        }
        const lived = Date.now() - startedAt;
        if (lived < 5000 && this.videoChunksSent === 0) {
          // Died immediately without producing anything: screenrecord or
          // the h264 output format is not usable on this device.
          this.videoFailures++;
          if (this.videoFailures >= 3) {
            this.fallbackToScreenshots(stderr || "screenrecord failed");
            return;
          }
        } else {
          this.videoFailures = 0;
        }
        // Normal three-minute rollover (or transient death): start again.
        setTimeout(() => {
          if (!this.videoStopping && this.screenMode === "video") {
            this.startVideo();
          }
        }, 250);
      }
    );
  }

  private sendVideoChunks(chunks: { data: Buffer; key: boolean }[]): void {
    for (const chunk of chunks) {
      this.videoChunksSent++;
      this.post({
        type: "video",
        key: chunk.key,
        codec: this.videoParser.codec,
        data: chunk.data.buffer.slice(
          chunk.data.byteOffset,
          chunk.data.byteOffset + chunk.data.byteLength
        ),
      });
    }
  }

  private stopVideo(): void {
    this.videoStopping = true;
    if (this.videoFlushTimer) {
      clearTimeout(this.videoFlushTimer);
      this.videoFlushTimer = undefined;
    }
    this.screenrecord?.kill();
    this.screenrecord = undefined;
  }

  private stopScreenLoop(): void {
    if (this.screenTimer) {
      clearTimeout(this.screenTimer);
      this.screenTimer = undefined;
    }
  }

  private restartScreenLoop(): void {
    this.stopScreenLoop();
    this.scheduleCapture(0);
  }

  private scheduleCapture(delayMs: number): void {
    if (this.screenTimer) {
      clearTimeout(this.screenTimer);
    }
    this.screenTimer = setTimeout(() => void this.captureLoopTick(), delayMs);
  }

  /**
   * Self-scheduling capture: the next shot is timed from when the previous
   * one finished, so a slow capture never stacks and a fast one keeps the
   * configured cadence instead of a fixed timer's worst-case latency.
   */
  private async captureLoopTick(): Promise<void> {
    if (this.screenMode !== "screenshots") {
      return;
    }
    const interval = Math.max(150, this.config<number>("screenRefreshMs", 400));
    const started = Date.now();
    await this.captureScreen();
    const elapsed = Date.now() - started;
    this.scheduleCapture(Math.max(50, interval - elapsed));
  }

  /** Captures immediately, used after gestures and steps for fast echo. */
  private captureNow(): void {
    if (this.screenMode === "screenshots") {
      this.scheduleCapture(0);
    }
  }

  private async captureScreen(): Promise<void> {
    if (this.capturing || !this.panel.visible || !this.adb.device) {
      return;
    }
    this.capturing = true;
    try {
      const png = await this.adb.screenshot();
      this.screenFailures = 0;
      this.post({
        type: "screen",
        dataUri: `data:image/png;base64,${png.toString("base64")}`,
      });
    } catch (error) {
      this.screenFailures++;
      if (this.screenFailures === 3) {
        const detail = error instanceof Error ? error.message : String(error);
        this.post({ type: "screenError", message: detail });
        await this.refreshDevices();
      }
    } finally {
      this.capturing = false;
    }
  }

  // ---- logcat -----------------------------------------------------------

  private restartLogcat(): void {
    this.stopLogcat();
    if (!this.adb.device) {
      return;
    }
    this.logcat = this.adb.streamLogcat(
      (lines) => this.queueLogs(lines),
      (message) => this.queueLogs([`[tapscribe] logcat: ${message}`])
    );
  }

  private queueLogs(lines: string[]): void {
    this.logQueue.push(...lines);
    // Throttle postMessage: flush at most every 150 ms, dropping overflow
    // beyond the configured buffer so a chatty device cannot flood the UI.
    const max = Math.max(100, this.config<number>("logBufferLines", 5000));
    if (this.logQueue.length > max) {
      this.logQueue = this.logQueue.slice(-max);
    }
    if (!this.logFlushTimer) {
      this.logFlushTimer = setTimeout(() => {
        this.logFlushTimer = undefined;
        const batch = this.logQueue;
        this.logQueue = [];
        if (batch.length > 0) {
          this.post({ type: "logs", lines: batch });
        }
      }, 150);
    }
  }

  private stopLogcat(): void {
    if (this.logFlushTimer) {
      clearTimeout(this.logFlushTimer);
      this.logFlushTimer = undefined;
    }
    this.logQueue = [];
    this.logcat?.kill();
    this.logcat = undefined;
  }

  // ---- lifecycle ----------------------------------------------------------

  private renderHtml(extensionUri: vscode.Uri): string {
    const webview = this.panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "style.css")
    );
    const nonce = getNonce();
    const logBufferLines = Math.max(100, this.config<number>("logBufferLines", 5000));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>TapScribe Test Lab</title>
</head>
<body data-log-buffer="${logBufferLines}">
  <main class="layout">
    <div class="stack">
    <section class="pane script-pane">
      <header class="pane-header">
        <h2>Test script</h2>
        <div class="toolbar">
          <button id="run" class="primary">Run</button>
          <button id="stopRun" disabled>Stop</button>
          <button id="record" aria-pressed="false" title="While on, taps and swipes on the device screen are appended to the script">Record</button>
          <button id="save">Save</button>
          <button id="load">Load</button>
          <button id="clearConsole" title="Clear the run output below the editor">Clear</button>
        </div>
      </header>
      <textarea id="editor" spellcheck="false"
        placeholder="# One step per line, for example:
launch com.example.app
wait 1s
tap 540 1200
type &quot;hello world&quot;
press enter
swipe up

# Or turn on Record and tap the device screen:
# every gesture lands here as a step."></textarea>
      <div id="console" class="console" aria-live="polite"></div>
    </section>
    <section class="pane log-pane">
      <header class="pane-header">
        <h2>Logcat</h2>
        <div class="toolbar">
          <input id="logFilter" type="text" placeholder="Filter text">
          <select id="logLevel" title="Minimum log level">
            <option value="V">Verbose</option>
            <option value="D">Debug</option>
            <option value="I" selected>Info</option>
            <option value="W">Warn</option>
            <option value="E">Error</option>
          </select>
          <label class="follow"><input id="autoScroll" type="checkbox" checked>Follow</label>
          <button id="clearLogs">Clear</button>
        </div>
      </header>
      <div id="logs" class="logs"></div>
    </section>
    </div>
    <section class="pane device-pane">
      <header class="pane-header">
        <select id="deviceSelect" title="Connected device"></select>
        <button id="refreshDevices">Refresh</button>
      </header>
      <div id="screenWrap" class="screen-wrap">
        <img id="screen" alt="Device screen" draggable="false">
        <canvas id="screenCanvas" aria-label="Device screen"></canvas>
        <div id="screenOverlay" class="screen-overlay">Waiting for a device.
Start an emulator or plug in a phone, then hit Refresh.</div>
      </div>
      <nav class="nav-bar">
        <button class="nav-btn" data-key="back" title="Back">&#9665;</button>
        <button class="nav-btn" data-key="home" title="Home">&#9711;</button>
        <button class="nav-btn" data-key="recents" title="Recent apps">&#9634;</button>
      </nav>
      <footer id="deviceStatus" class="status"></footer>
    </section>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    TestLabPanel.current = undefined;
    this.runner.stop();
    this.stopLogcat();
    this.stopVideo();
    this.stopScreenLoop();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
