import * as vscode from "vscode";
import * as child_process from "child_process";
import * as path from "path";

let emulatorPanel: vscode.WebviewPanel | undefined;
let screenshotInterval: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
  console.log("Android Emulator Extension is now active");

  let showEmulatorCommand = vscode.commands.registerCommand(
    "tapscribe.openTestLab",
    () => {
      if (emulatorPanel) {
        emulatorPanel.reveal();
        return;
      }

      emulatorPanel = vscode.window.createWebviewPanel(
        "androidEmulator",
        "Android Emulator",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      emulatorPanel.webview.html = getWebviewContent();

      // Handle messages from the webview
      emulatorPanel.webview.onDidReceiveMessage(
        async (message) => {
          if (message.type === 'runScript') {
            if (!emulatorPanel) return;

            const commands = message.script.split('\n')
              .map((line: string) => line.trim())
              .filter((line: string) => line && !line.startsWith('//')); // Remove empty lines and comments

            for (const command of commands) {
              try {
                const output = child_process.execSync(command, { encoding: 'utf8' });
                emulatorPanel.webview.postMessage({
                  type: 'scriptOutput',
                  output: `✓ ${command}\n${output}`,
                  error: false
                });
              } catch (error: unknown) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
                emulatorPanel.webview.postMessage({
                  type: 'scriptOutput',
                  output: `✗ ${command}\n${errorMessage}`,
                  error: true
                });
              }
            }
          }
        },
        undefined,
        context.subscriptions
      );

      emulatorPanel.onDidDispose(
        () => {
          emulatorPanel = undefined;
          if (screenshotInterval) {
            clearInterval(screenshotInterval);
            screenshotInterval = undefined;
          }
        },
        null,
        context.subscriptions
      );

      updateEmulatorScreen();
      screenshotInterval = setInterval(updateEmulatorScreen, 2000);
    }
  );

  context.subscriptions.push(showEmulatorCommand);
}

function getWebviewContent() {
  return `<!DOCTYPE html>
	<html>
	<head>
		<style>
			body {
				padding: 0;
				margin: 0;
				background: #1e1e1e;
				display: flex;
				height: 100vh;
			}
			.split-view {
				display: flex;
				width: 100%;
				height: 100%;
			}
			.emulator-container {
				flex: 1;
				display: flex;
				justify-content: center;
				align-items: center;
				padding: 10px;
				border-right: 1px solid #444;
			}
			#emulator-screen {
				max-width: 100%;
				max-height: 100vh;
				object-fit: contain;
			}
			.editor-container {
				flex: 1;
				display: flex;
				flex-direction: column;
				padding: 10px;
			}
			#editor {
				flex: 1;
				width: 100%;
				background: #1e1e1e;
				color: #d4d4d4;
				font-family: 'Courier New', monospace;
				font-size: 14px;
				line-height: 1.5;
				padding: 10px;
				resize: none;
				border: 1px solid #444;
				outline: none;
			}
			.toolbar {
				display: flex;
				gap: 10px;
				padding: 10px 0;
			}
			.button {
				background: #0e639c;
				color: white;
				border: none;
				padding: 8px 12px;
				cursor: pointer;
				border-radius: 3px;
			}
			.button:hover {
				background: #1177bb;
			}
			.output {
				margin-top: 10px;
				padding: 10px;
				background: #2d2d2d;
				border: 1px solid #444;
				max-height: 150px;
				overflow-y: auto;
				font-family: 'Courier New', monospace;
				font-size: 12px;
				color: #d4d4d4;
			}
		</style>
	</head>
	<body>
		<div class="split-view">
			<div class="emulator-container">
				<img id="emulator-screen" src="" alt="Android Emulator Screen">
			</div>
			<div class="editor-container">
				<div class="toolbar">
					<button class="button" id="run-button">Run Script</button>
					<button class="button" id="clear-button">Clear Output</button>
				</div>
				<textarea id="editor" placeholder="// Write your test script here
// Example:
adb shell input tap 100 200
adb shell input text 'hello'
adb shell input keyevent KEYCODE_ENTER"></textarea>
				<div class="output" id="output"></div>
			</div>
		</div>
		<script>
			const vscode = acquireVsCodeApi();
			const editor = document.getElementById('editor');
			const output = document.getElementById('output');
			const runButton = document.getElementById('run-button');
			const clearButton = document.getElementById('clear-button');

			// Try to restore previous state
			const previousState = vscode.getState();
			if (previousState?.editorContent) {
				editor.value = previousState.editorContent;
			}

			// Save editor content when it changes
			editor.addEventListener('input', () => {
				vscode.setState({ editorContent: editor.value });
			});

			runButton.addEventListener('click', () => {
				const script = editor.value;
				vscode.postMessage({
					type: 'runScript',
					script
				});
			});

			clearButton.addEventListener('click', () => {
				output.innerHTML = '';
			});

			window.addEventListener('message', event => {
				const message = event.data;
				switch (message.type) {
					case 'updateScreen':
						document.getElementById('emulator-screen').src = message.imageData;
						break;
					case 'scriptOutput':
						const outputLine = document.createElement('div');
						outputLine.textContent = message.output;
						outputLine.style.color = message.error ? '#f48771' : '#89d185';
						output.appendChild(outputLine);
						output.scrollTop = output.scrollHeight;
						break;
				}
			});
		</script>
	</body>
	</html>`;
}

async function updateEmulatorScreen() {
  if (!emulatorPanel) {
    return;
  }

  try {
    const screenshot = child_process.execSync("adb exec-out screencap -p", {
      encoding: "base64",
      maxBuffer: 25 * 1024 * 1024, // 25MB buffer
    });
    const imageData = `data:image/png;base64,${screenshot}`;

    // Send to webview
    if (emulatorPanel?.visible) {
      emulatorPanel.webview.postMessage({
        type: "updateScreen",
        imageData,
      });
    }
  } catch (error) {
    console.error("Failed to capture emulator screen:", error);

    // Show error only if panel is visible
    if (emulatorPanel?.visible) {
      vscode.window.showErrorMessage(
        "Failed to capture Android emulator screen. Make sure the emulator is running and ADB is available."
      );
    }

    if (screenshotInterval) {
      clearInterval(screenshotInterval);
      screenshotInterval = undefined;
    }
  }
}

export function deactivate() {
  if (screenshotInterval) {
    clearInterval(screenshotInterval);
    screenshotInterval = undefined;
  }
}
