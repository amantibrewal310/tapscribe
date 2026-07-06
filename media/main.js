// Webview side of the TapScribe Test Lab. Talks to the extension host
// exclusively through postMessage; no direct access to adb or the fs.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const editor = document.getElementById("editor");
  const consoleEl = document.getElementById("console");
  const runBtn = document.getElementById("run");
  const stopBtn = document.getElementById("stopRun");
  const recordBtn = document.getElementById("record");
  const saveBtn = document.getElementById("save");
  const loadBtn = document.getElementById("load");
  const clearConsoleBtn = document.getElementById("clearConsole");
  const deviceSelect = document.getElementById("deviceSelect");
  const refreshBtn = document.getElementById("refreshDevices");
  const screen = document.getElementById("screen");
  const screenCanvas = document.getElementById("screenCanvas");
  const screenWrap = document.getElementById("screenWrap");
  const screenOverlay = document.getElementById("screenOverlay");
  const deviceStatus = document.getElementById("deviceStatus");
  const logsEl = document.getElementById("logs");
  const logFilter = document.getElementById("logFilter");
  const logLevel = document.getElementById("logLevel");
  const autoScroll = document.getElementById("autoScroll");
  const clearLogsBtn = document.getElementById("clearLogs");

  const LOG_BUFFER = Number(document.body.dataset.logBuffer) || 5000;
  const LEVEL_ORDER = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 4 };

  /** @type {{text: string, level: string}[]} */
  let logBuffer = [];

  // ---- state restore ------------------------------------------------------

  const state = vscode.getState() || {};
  if (typeof state.script === "string") {
    editor.value = state.script;
  }
  if (typeof state.filter === "string") {
    logFilter.value = state.filter;
  }
  if (typeof state.level === "string") {
    logLevel.value = state.level;
  }

  function saveState() {
    vscode.setState({
      script: editor.value,
      filter: logFilter.value,
      level: logLevel.value,
    });
  }

  editor.addEventListener("input", saveState);

  // ---- script console -------------------------------------------------------

  function consoleLine(text, cls) {
    const div = document.createElement("div");
    div.textContent = text;
    if (cls) {
      div.className = cls;
    }
    consoleEl.appendChild(div);
    while (consoleEl.childElementCount > 500) {
      consoleEl.removeChild(consoleEl.firstChild);
    }
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }

  runBtn.addEventListener("click", () => {
    consoleEl.textContent = "";
    vscode.postMessage({ type: "run", script: editor.value });
  });
  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));
  saveBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "saveScript", text: editor.value })
  );
  loadBtn.addEventListener("click", () => vscode.postMessage({ type: "loadScript" }));
  clearConsoleBtn.addEventListener("click", () => {
    consoleEl.textContent = "";
  });

  function setRunning(running) {
    runBtn.disabled = running;
    stopBtn.disabled = !running;
  }

  // ---- record mode ----------------------------------------------------------

  let recording = false;

  function setRecording(value) {
    recording = value;
    recordBtn.setAttribute("aria-pressed", String(recording));
    screenWrap.classList.toggle("recording", recording);
    deviceStatus.textContent = recording
      ? "Recording: gestures are appended to the script"
      : "";
  }

  recordBtn.addEventListener("click", () => setRecording(!recording));

  function appendStep(text) {
    const current = editor.value;
    editor.value =
      current.length === 0 || current.endsWith("\n")
        ? current + text + "\n"
        : current + "\n" + text + "\n";
    editor.scrollTop = editor.scrollHeight;
    saveState();
  }

  // ---- devices --------------------------------------------------------------

  refreshBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "refreshDevices" })
  );
  deviceSelect.addEventListener("change", () =>
    vscode.postMessage({ type: "selectDevice", serial: deviceSelect.value })
  );

  function renderDevices(devices, selected, error) {
    deviceSelect.textContent = "";
    if (devices.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = error ? "adb unavailable" : "No devices";
      deviceSelect.appendChild(option);
      screen.classList.remove("live");
      screenOverlay.classList.remove("hidden");
      screenOverlay.textContent = error
        ? error
        : "Waiting for a device.\nStart an emulator or plug in a phone, then hit Refresh.";
      deviceStatus.textContent = "";
      return;
    }
    for (const device of devices) {
      const option = document.createElement("option");
      option.value = device.serial;
      option.textContent = device.model
        ? device.model + " (" + device.serial + ")"
        : device.serial;
      option.selected = device.serial === selected;
      deviceSelect.appendChild(option);
    }
  }

  // ---- device screen ----------------------------------------------------------

  let screenMode = "screenshots";

  // The active display surface and its bitmap dimensions: the img in
  // screenshot mode, the canvas in video mode.
  function activeSurface() {
    if (screenMode === "video") {
      return { el: screenCanvas, width: screenCanvas.width, height: screenCanvas.height };
    }
    return { el: screen, width: screen.naturalWidth, height: screen.naturalHeight };
  }

  function contentRect() {
    // Both surfaces render their bitmap letterbox-centered in the element
    // box. Gestures must map to bitmap pixels.
    const surface = activeSurface();
    const rect = surface.el.getBoundingClientRect();
    const scale = Math.min(rect.width / surface.width, rect.height / surface.height);
    const width = surface.width * scale;
    const height = surface.height * scale;
    return {
      left: rect.left + (rect.width - width) / 2,
      top: rect.top + (rect.height - height) / 2,
      width,
      height,
      scale,
    };
  }

  function toDeviceCoords(clientX, clientY) {
    const surface = activeSurface();
    if (!surface.width || !surface.height) {
      return undefined;
    }
    const rect = contentRect();
    const x = (clientX - rect.left) / rect.scale;
    const y = (clientY - rect.top) / rect.scale;
    if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) {
      return undefined;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  let gestureStart;

  function onScreenPointerDown(event) {
    const point = toDeviceCoords(event.clientX, event.clientY);
    if (!point) {
      return;
    }
    gestureStart = { point, time: Date.now(), pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onScreenPointerUp(event) {
    if (!gestureStart || event.pointerId !== gestureStart.pointerId) {
      return;
    }
    const start = gestureStart;
    gestureStart = undefined;
    const end =
      toDeviceCoords(event.clientX, event.clientY) || start.point;
    const elapsed = Date.now() - start.time;
    const dx = end.x - start.point.x;
    const dy = end.y - start.point.y;
    const moved = Math.hypot(dx, dy) * contentRect().scale > 8;

    let message;
    if (moved) {
      message = {
        type: "gesture",
        gesture: "swipe",
        x: start.point.x,
        y: start.point.y,
        x2: end.x,
        y2: end.y,
        durationMs: Math.max(50, Math.min(2000, elapsed)),
      };
    } else if (elapsed >= 500) {
      message = {
        type: "gesture",
        gesture: "longpress",
        x: start.point.x,
        y: start.point.y,
        durationMs: Math.min(3000, elapsed),
      };
    } else {
      message = {
        type: "gesture",
        gesture: "tap",
        x: start.point.x,
        y: start.point.y,
      };
    }
    message.record = recording;
    vscode.postMessage(message);
    if (!recording) {
      deviceStatus.textContent = describeGesture(message);
    }
  }

  for (const surface of [screen, screenCanvas]) {
    surface.addEventListener("pointerdown", onScreenPointerDown);
    surface.addEventListener("pointerup", onScreenPointerUp);
    surface.addEventListener("pointercancel", () => {
      gestureStart = undefined;
    });
  }

  // Android navigation bar: back, home, recents.
  for (const btn of document.querySelectorAll(".nav-btn")) {
    btn.addEventListener("click", () => {
      vscode.postMessage({
        type: "navKey",
        key: btn.dataset.key,
        record: recording,
      });
    });
  }

  function describeGesture(message) {
    if (message.gesture === "swipe") {
      return (
        "swipe " + message.x + "," + message.y +
        " to " + message.x2 + "," + message.y2
      );
    }
    if (message.gesture === "longpress") {
      return "long press " + message.x + "," + message.y;
    }
    return "tap " + message.x + "," + message.y;
  }

  // ---- video decoding -------------------------------------------------------

  const canvasCtx = screenCanvas.getContext("2d");
  let decoder;
  let decoderCodec;
  let awaitingKey = true;
  let videoTimestamp = 0;
  let decodeErrors = 0;
  let lastDecodeErrorAt = 0;

  // A decode error usually means one corrupt frame (e.g. a frame truncated
  // by the idle flush), not a broken pipeline. Recover by restarting the
  // stream for a fresh keyframe; only give up after repeated failures.
  function onDecodeError(message) {
    const now = Date.now();
    if (now - lastDecodeErrorAt > 60000) {
      decodeErrors = 0;
    }
    lastDecodeErrorAt = now;
    decodeErrors++;
    if (decoder && decoder.state !== "closed") {
      decoder.close();
    }
    decoder = undefined;
    awaitingKey = true;
    if (decodeErrors >= 3) {
      vscode.postMessage({ type: "videoError", message });
    } else {
      deviceStatus.textContent = "video hiccup, resyncing";
      vscode.postMessage({ type: "videoRestart" });
    }
  }

  function showSurface(mode) {
    screenMode = mode;
    if (mode === "video") {
      screen.classList.remove("live");
    } else {
      screenCanvas.classList.remove("live");
      if (decoder && decoder.state !== "closed") {
        decoder.close();
      }
      decoder = undefined;
    }
  }

  function onDecodedFrame(frame) {
    if (
      screenCanvas.width !== frame.displayWidth ||
      screenCanvas.height !== frame.displayHeight
    ) {
      screenCanvas.width = frame.displayWidth;
      screenCanvas.height = frame.displayHeight;
      deviceStatus.textContent =
        "video " + frame.displayWidth + "x" + frame.displayHeight;
    }
    canvasCtx.drawImage(frame, 0, 0);
    frame.close();
    screenCanvas.classList.add("live");
    screenOverlay.classList.add("hidden");
  }

  function ensureDecoder(codec) {
    if (decoder && decoder.state === "configured" && decoderCodec === codec) {
      return true;
    }
    if (decoder && decoder.state !== "closed") {
      decoder.close();
    }
    try {
      decoder = new VideoDecoder({
        output: onDecodedFrame,
        error: (e) => onDecodeError(e.message),
      });
      decoder.configure({ codec, optimizeForLatency: true });
      decoderCodec = codec;
      awaitingKey = true;
      return true;
    } catch (e) {
      // configure() rejecting the codec is not recoverable by restarting.
      vscode.postMessage({ type: "videoError", message: e.message });
      return false;
    }
  }

  let keyStallSince;

  function onVideoChunk(message) {
    if (screenMode !== "video" || !message.codec) {
      return;
    }
    if (!ensureDecoder(message.codec)) {
      return;
    }
    if (awaitingKey && !message.key) {
      // screenrecord sends exactly one keyframe per stream, at the start.
      // If we are dropping deltas without one, the stream began before this
      // decoder did; ask for a restart instead of freezing until rollover.
      const now = Date.now();
      if (!keyStallSince) {
        keyStallSince = now;
      } else if (now - keyStallSince > 1500) {
        keyStallSince = undefined;
        vscode.postMessage({ type: "videoRestart" });
      }
      return;
    }
    keyStallSince = undefined;
    awaitingKey = false;
    const data =
      message.data instanceof ArrayBuffer
        ? new Uint8Array(message.data)
        : new Uint8Array(message.data.data || message.data);
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: message.key ? "key" : "delta",
          timestamp: (videoTimestamp += 33333),
          data,
        })
      );
    } catch (e) {
      onDecodeError(e.message);
    }
  }

  // ---- logcat ---------------------------------------------------------------

  function levelOf(line) {
    const match = line.match(/ ([VDIWEF])\//);
    return match ? match[1] : "I";
  }

  function passesFilter(entry) {
    const min = LEVEL_ORDER[logLevel.value] || 0;
    if ((LEVEL_ORDER[entry.level] ?? 2) < min) {
      return false;
    }
    const needle = logFilter.value.trim().toLowerCase();
    return !needle || entry.text.toLowerCase().includes(needle);
  }

  function appendLogLine(entry) {
    const div = document.createElement("div");
    div.className = "line lv-" + entry.level;
    div.textContent = entry.text;
    logsEl.appendChild(div);
  }

  function renderLogs() {
    logsEl.textContent = "";
    const visible = logBuffer.filter(passesFilter);
    // Render at most the newest 2000 lines; the full buffer stays in memory
    // so loosening the filter brings older lines back.
    for (const entry of visible.slice(-2000)) {
      appendLogLine(entry);
    }
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  function addLogs(lines) {
    const atBottom =
      logsEl.scrollTop + logsEl.clientHeight >= logsEl.scrollHeight - 30;
    for (const text of lines) {
      const entry = { text, level: levelOf(text) };
      logBuffer.push(entry);
      if (passesFilter(entry)) {
        appendLogLine(entry);
      }
    }
    if (logBuffer.length > LOG_BUFFER) {
      logBuffer = logBuffer.slice(-LOG_BUFFER);
    }
    while (logsEl.childElementCount > 2000) {
      logsEl.removeChild(logsEl.firstChild);
    }
    if (autoScroll.checked && atBottom) {
      logsEl.scrollTop = logsEl.scrollHeight;
    }
  }

  logFilter.addEventListener("input", () => {
    saveState();
    renderLogs();
  });
  logLevel.addEventListener("change", () => {
    saveState();
    renderLogs();
  });
  clearLogsBtn.addEventListener("click", () => {
    vscode.postMessage({ type: "clearLogs" });
  });

  // ---- messages from the extension -----------------------------------------

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "devices":
        renderDevices(message.devices, message.selected, message.error);
        break;
      case "screenMode":
        showSurface(message.mode);
        break;
      case "video":
        onVideoChunk(message);
        break;
      case "screenModeNotice":
        deviceStatus.textContent = message.text;
        break;
      case "screen":
        if (screenMode === "screenshots") {
          screen.src = message.dataUri;
          screen.classList.add("live");
          screenOverlay.classList.add("hidden");
        }
        break;
      case "screenError":
        screen.classList.remove("live");
        screenOverlay.classList.remove("hidden");
        screenOverlay.textContent =
          "Could not capture the screen.\n" + message.message;
        break;
      case "logs":
        addLogs(message.lines);
        break;
      case "logsCleared":
        logBuffer = [];
        logsEl.textContent = "";
        break;
      case "runStarted":
        setRunning(true);
        consoleLine("Running " + message.total + " step(s)", "info");
        break;
      case "stepStart":
        consoleLine(
          "> line " + message.line + ": " + message.source,
          "running"
        );
        break;
      case "stepEnd":
        if (message.ok) {
          consoleLine(
            "  ok" + (message.detail ? "\n" + message.detail : ""),
            "ok"
          );
        } else {
          consoleLine("  failed: " + (message.detail || "unknown error"), "err");
        }
        break;
      case "runFinished": {
        setRunning(false);
        let text;
        if (message.stopped) {
          text = "Stopped after " + message.ran + " of " + message.total + " step(s).";
        } else if (message.ok) {
          text = "Done. " + message.ran + " step(s) passed.";
        } else {
          text = message.message ||
            "Failed at step " + (message.ran + 1) + " of " + message.total + ".";
        }
        consoleLine(text, message.ok ? "ok" : "err");
        break;
      }
      case "parseIssues":
        setRunning(false);
        for (const issue of message.issues) {
          consoleLine(
            (issue.line ? "line " + issue.line + ": " : "") + issue.message,
            "err"
          );
        }
        break;
      case "recordedStep":
        appendStep(message.text);
        break;
      case "gestureError":
        deviceStatus.textContent = "gesture failed: " + message.message;
        break;
      case "scriptLoaded":
        editor.value = message.text;
        saveState();
        break;
    }
  });

  vscode.postMessage({
    type: "ready",
    webCodecs: typeof VideoDecoder === "function",
  });
})();
