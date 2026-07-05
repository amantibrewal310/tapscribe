import { ChildProcess } from "child_process";
import * as vscode from "vscode";
import { AdbClient } from "./adb";
import { parseScript, stepToSource, Step } from "./script/parser";
import { ScriptRunner } from "./script/runner";

interface GestureMessage {
  type: "gesture";
  gesture: "tap" | "longpress" | "swipe";
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  /** True while record mode is on: the gesture also becomes a script step. */
  record?: boolean;
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
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
    this.panel.webview.onDidReceiveMessage(
      (message) => this.onMessage(message),
      null,
      this.disposables
    );
    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration("tapscribe")) {
          this.adb.setDevice(this.adb.device); // keep device, refresh the rest
          this.restartScreenLoop();
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
        await this.refreshDevices();
        this.restartScreenLoop();
        break;
      case "refreshDevices":
        await this.refreshDevices();
        break;
      case "selectDevice":
        this.adb.setDevice(message.serial || undefined);
        this.screenFailures = 0;
        this.restartLogcat();
        void this.wakeDevice();
        break;
      case "run":
        await this.runScript(String(message.script ?? ""));
        break;
      case "stop":
        this.runner.stop();
        break;
      case "gesture":
        await this.onGesture(message as GestureMessage);
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
      if (!this.adb.device || !devices.some((d) => d.serial === this.adb.device)) {
        this.adb.setDevice(devices[0]?.serial);
        this.restartLogcat();
        void this.wakeDevice();
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
      onStepEnd: (step, index, ok, detail) =>
        this.post({ type: "stepEnd", index, line: step.line, source: step.source, ok, detail }),
    });
    this.post({ type: "runFinished", ...summary });
  }

  private async onGesture(message: GestureMessage): Promise<void> {
    if (!this.adb.device) {
      return;
    }
    let step: Step;
    if (message.gesture === "swipe") {
      step = {
        kind: "swipeCoords",
        x1: message.x,
        y1: message.y,
        x2: message.x2 ?? message.x,
        y2: message.y2 ?? message.y,
        durationMs: Math.max(50, Math.min(2000, message.durationMs ?? 300)),
      };
    } else if (message.gesture === "longpress") {
      step = {
        kind: "longpress",
        x: message.x,
        y: message.y,
        durationMs: Math.max(400, Math.min(3000, message.durationMs ?? 600)),
      };
    } else {
      step = { kind: "tap", x: message.x, y: message.y };
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

  private restartScreenLoop(): void {
    if (this.screenTimer) {
      clearInterval(this.screenTimer);
    }
    const interval = Math.max(150, this.config<number>("screenRefreshMs", 800));
    this.screenTimer = setInterval(() => void this.captureScreen(), interval);
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
        <div id="screenOverlay" class="screen-overlay">Waiting for a device.
Start an emulator or plug in a phone, then hit Refresh.</div>
      </div>
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
    if (this.screenTimer) {
      clearInterval(this.screenTimer);
      this.screenTimer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
