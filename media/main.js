// Webview side of the TapScribe Test Lab. Talks to the extension host
// exclusively through postMessage; no direct access to adb or the fs.
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const editor = document.getElementById("editor");
  const consoleEl = document.getElementById("console");
  const runBtn = document.getElementById("run");
  const stopBtn = document.getElementById("stopRun");
  const saveBtn = document.getElementById("save");
  const loadBtn = document.getElementById("load");
  const deviceSelect = document.getElementById("deviceSelect");
  const refreshBtn = document.getElementById("refreshDevices");
  const screen = document.getElementById("screen");
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

  function setRunning(running) {
    runBtn.disabled = running;
    stopBtn.disabled = !running;
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

  function contentRect() {
    // The img uses object-fit: contain, so the rendered bitmap is centered
    // inside the element box. Gestures must map to bitmap pixels.
    const rect = screen.getBoundingClientRect();
    const scale = Math.min(
      rect.width / screen.naturalWidth,
      rect.height / screen.naturalHeight
    );
    const width = screen.naturalWidth * scale;
    const height = screen.naturalHeight * scale;
    return {
      left: rect.left + (rect.width - width) / 2,
      top: rect.top + (rect.height - height) / 2,
      width,
      height,
      scale,
    };
  }

  function toDeviceCoords(clientX, clientY) {
    if (!screen.naturalWidth || !screen.naturalHeight) {
      return undefined;
    }
    const rect = contentRect();
    const x = (clientX - rect.left) / rect.scale;
    const y = (clientY - rect.top) / rect.scale;
    if (x < 0 || y < 0 || x >= screen.naturalWidth || y >= screen.naturalHeight) {
      return undefined;
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  let gestureStart;

  screen.addEventListener("pointerdown", (event) => {
    const point = toDeviceCoords(event.clientX, event.clientY);
    if (!point) {
      return;
    }
    gestureStart = { point, time: Date.now(), pointerId: event.pointerId };
    screen.setPointerCapture(event.pointerId);
  });

  screen.addEventListener("pointerup", (event) => {
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
    vscode.postMessage(message);
    deviceStatus.textContent = describeGesture(message);
  });

  screen.addEventListener("pointercancel", () => {
    gestureStart = undefined;
  });

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
      case "screen":
        screen.src = message.dataUri;
        screen.classList.add("live");
        screenOverlay.classList.add("hidden");
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
      case "gestureError":
        deviceStatus.textContent = "gesture failed: " + message.message;
        break;
      case "scriptLoaded":
        editor.value = message.text;
        saveState();
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
})();
