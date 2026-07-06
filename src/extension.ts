import * as vscode from "vscode";
import { TestLabPanel } from "./panel";

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("tapscribe.openTestLab", () => {
      TestLabPanel.createOrShow(context.extensionUri);
    })
  );
}

export function deactivate(): void {
  // TestLabPanel cleans itself up through its onDidDispose handler.
}
