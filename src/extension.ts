
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenerativeAI } from "@google/generative-ai";

/** =======================
 *  CONFIG: API KEY
 *  TODO: move to secure storage/settings later.
 *  ======================= */
const GEMINI_API_KEY = "AIzaSyDdACIU3h59herh6ZjZnNw0oav4xRe8gK8";

/** =======================
 *  TYPES + PARSER
 *  ======================= */
type Occurence = {
  kind: "Variable" | "Function" | "Import" | "Class" | "Statement";
  name: string;
  scope: string;
  startLine: number;
  endLine: number;
  code: string;
};

function parseAiOccurrences(aiText: string): Occurence[] {
  const text = aiText.replace(/[`*]/g, "");
  const re =
    /(Variable|Function|Import|Class|Statement):\s*([^\n]+)\s*[\r\n]+Scope:\s*([^\n]+)\s*[\r\n]+Lines:\s*(\d+)\s*-\s*(\d+)\s*[\r\n]+Code:\s*([\s\S]*?)(?=(?:\n(?:Variable|Function|Import|Class|Statement):)|$)/g;
  const items: Occurence[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    items.push({
      kind: m[1] as Occurence["kind"],
      name: m[2].trim(),
      scope: m[3].trim(),
      startLine: parseInt(m[4], 10),
      endLine: parseInt(m[5], 10),
      code: m[6].trim(),
    });
  }
  return items;
}

/** =======================
 *  ACTIVATION
 *  ======================= */
export function activate(context: vscode.ExtensionContext) {
  // Status bar
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(rocket) Snapcode";
  statusBarItem.tooltip = "Click to start snapcode engine";
  statusBarItem.command = "Snapcode.openWebView";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Hello World
  const disposable = vscode.commands.registerCommand("Snapcode.helloWorld", () => {
    vscode.window.showInformationMessage("Hello World from Snapcode!");
    console.log("hello world");
  });
  context.subscriptions.push(disposable);

  // Webview command
  const webViewCommand = vscode.commands.registerCommand("Snapcode.openWebView", () => {
    const panel = vscode.window.createWebviewPanel(
      "snapcodeWebview",
      "Snapcode Panel",
      vscode.ViewColumn.One,
      { enableScripts: true }
    );

    panel.webview.html = getWebviewContent();

    // Handle messages FROM webview
    panel.webview.onDidReceiveMessage(
      async (message) => {
        try {
          if (message.command === "runsHelloWorld") {
            vscode.commands.executeCommand("Snapcode.helloWorld");
          }

          if (message.command === "analyzeFile") {
            const result = await analyzeFile(message.filename);
            panel.webview.postMessage({ command: "showResult", text: result });
          }

          if (message.command === "analyzeCode") {
            const result = await analyzeCodeBlock(message.filepath, message.search);
            const occurrences = parseAiOccurrences(result);
            // also send back filepath so webview can keep it
            panel.webview.postMessage({
              command: "showResult1",
              occurrences,
              raw: result,
              filepath: message.filepath,
            });
          }

          if (message.command === "requestScopeInfo") {
            const { filepath } = message;
            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
              panel.webview.postMessage({ command: "toast", text: "No workspace open" });
              return;
            }
            const filePath = path.join(workspacePath, filepath);
            if (!fs.existsSync(filePath)) {
              panel.webview.postMessage({ command: "toast", text: `File not found: ${filepath}` });
              return;
            }
            const docText = fs.readFileSync(filePath, "utf8");

            // We now expect the webview to send the actual occurrence object.
            const occ = message.occurrence as Occurence | null;
            const occurrence =
              occ || ((): Occurence => { throw new Error("Occurrence not provided"); })();

            const scopeInfo = await getScopeInfoViaAI(
              filepath,
              docText,
              occurrence,
              GEMINI_API_KEY
            );

            panel.webview.postMessage({
              command: "confirmDelete",
              filepath,
              occurrence,
              scopeInfo,
            });
          }

          if (message.command === "performDelete") {
            const { filepath, occurrence, variables, lines, scopeInfo } = message;

            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
              panel.webview.postMessage({ command: "toast", text: "No workspace open" });
              return;
            }

            const filePath = path.join(workspacePath, filepath);
            if (!fs.existsSync(filePath)) {
              panel.webview.postMessage({ command: "toast", text: `File not found: ${filePath}` });
              return;
            }

            const original = fs.readFileSync(filePath, "utf8");
            const aiCode = await aiDeleteAndFixFullFile(
              filepath,
              original,
              occurrence,
              variables,
              lines,
              scopeInfo,
              GEMINI_API_KEY
            );

            panel.webview.postMessage({
              command: "showMerger",
              filepath,
              original,
              aiCode, // <- FIXED: was "aicode"
            });
          }

          if (message.command === "applyMergedCode") {
            const { filepath, merged } = message;

            const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!workspacePath) {
              panel.webview.postMessage({ command: "toast", text: "No workspace open" });
              return;
            }
            const filePath = path.join(workspacePath, filepath);

            try {
              fs.writeFileSync(filePath, merged, "utf8");
              panel.webview.postMessage({ command: "toast", text: `✅ Saved ${filepath}` });
              // Reload in editor
              const docUri = vscode.Uri.file(filePath);
              const doc = await vscode.workspace.openTextDocument(docUri);
              await vscode.window.showTextDocument(doc, { preview: false });
            } catch (e) {
              panel.webview.postMessage({ command: "toast", text: `Error saving file: ${e}` });
            }
          }
        } catch (err) {
          panel.webview.postMessage({ command: "toast", text: `Error: ${err}` });
        }
      },
      undefined,
      context.subscriptions
    );
  });
  context.subscriptions.push(webViewCommand);

  /** ========== FUNCTIONS ========== */

  async function analyzeFile(filename: string): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return "No workspace open!";
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const filePath = path.join(workspacePath, filename);
    if (!fs.existsSync(filePath)) {
      return `❌ File not found: ${filename}`;
    }
    const fileContent = fs.readFileSync(filePath, "utf8");

    try {
      const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

      const prompt = `
You are a code analyzer. Given the following file:

Filename: ${filename}

Code:
---
${fileContent}
---

Task:
1. Find all unused imports.
2. Find all unused variables.
3. For each one, return the variable/import name and the line number.
Return results in a clear list format with NO markdown, NO asterisks, NO backticks.
`;

      const result = await model.generateContent(prompt);
      let output = result.response.text();
      output = output.replace(/[`*]/g, "").trim();
      return output;
    } catch (err) {
      return `Error: ${err}`;
    }
  }

  async function analyzeCodeBlock(filename: string, searchTerm: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return "No Workspace Folders";
    }

    const workspacePath = workspaceFolders[0].uri.fsPath;
    const filePath = path.join(workspacePath, filename);
    if (!fs.existsSync(filePath)) {
      return `File not found:${filename}`;
    }

    const code = fs.readFileSync(filePath, "utf8");
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
You are a code analyzer.
Given this file: ${filename}

Code:
---
${code}
---

Task:
1. Find all occurrences of "${searchTerm}" that are used and unused.
2. Consider scope: variables or functions inside another function or class must be treated separately from globals.
3. For each occurrence, return:
   - type (variable/function/import)
   - exact code
   - start line and end line
   - parent scope (global or function/class name)
4. Do NOT include anything that is not exactly "${searchTerm}".
5. Return only plain text, no markdown, no backticks.

Example output format:

Variable: unusedVar
Scope: global
Lines: 2-2
Code:
const unusedVar = 859;

Variable: unusedVar
Scope: function someFunction
Lines: 5-5
Code:
unusedVar = 90;
`;

    const result = await model.generateContent(prompt);
    let output = result.response.text();
    output = output.replace(/[`*]/g, "").trim();
    console.log(output);
    return output;
  }

  async function getScopeInfoViaAI(
    filename: string,
    fullcode: string,
    occurence: Occurence,
    apikey: string
  ): Promise<{
    scopeType: string;
    scopeName: string;
    scopeStartLine: number;
    scopeEndLine: number;
    variables: string[];
    lines: number[];
  }> {
    const genAI = new GoogleGenerativeAI(apikey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
You are a precise code analyst.

File: ${filename}

code:
---
${fullcode}
---

Target occurrence:
- kind: ${occurence.kind}
- name: ${occurence.name}
- lines: ${occurence.startLine}-${occurence.endLine}
- scopeLabel: ${occurence.scope}

Task:
1) Find the nearest enclosing function or class for this occurrence (if none, scope is "global").
2) Return STRICT JSON (no markdown) with:
{
  "scopeType": "function|class|global",
  "scopeName": "<name or global>",
  "scopeStartLine": <number>,
  "scopeEndLine": <number>,
  "variables": ["list","all","declared","names","in","this","scope"],
  "lines": [<every integer line from scopeStartLine to scopeEndLine>]
}
ONLY JSON.
`;

    const res = await model.generateContent(prompt);
    const text = res.response.text().replace(/[`*]/g, "").trim();
    try {
      return JSON.parse(text);
    } catch {
      return {
        scopeType: "unknown",
        scopeName: occurence.scope || "unknown",
        scopeStartLine: occurence.startLine,
        scopeEndLine: occurence.endLine,
        variables: [],
        lines: Array.from(
          { length: occurence.endLine - occurence.startLine + 1 },
          (_, i) => occurence.startLine + i
        ),
      };
    }
  }

  async function aiDeleteAndFixFullFile(
    filename: string,
    originalCode: string,
    occurrence: Occurence,
    variables: string[],
    lines: number[],
    scopeInfo: { scopeType: string; scopeName: string; scopeStartLine: number; scopeEndLine: number },
    apiKey: string
  ): Promise<string> {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

    const prompt = `
You are a precise refactoring assistant.

File: ${filename}

Original code:
---
${originalCode}
---

Delete target:
- kind: ${occurrence.kind}
- name: ${occurrence.name}
- occurrenceLines: ${occurrence.startLine}-${occurrence.endLine}

Scope info:
- scopeType: ${scopeInfo.scopeType}
- scopeName: ${scopeInfo.scopeName}
- scopeLines: ${scopeInfo.scopeStartLine}-${scopeInfo.scopeEndLine}

Context arrays provided by user:
- variablesInScope: [${variables.join(", ")}]
- linesToConsider: [${lines.join(", ")}]

Tasks:
1) Remove ONLY the target occurrence safely.
2) Fix any resulting errors (unresolved references, imports, params, returns) minimally.
3) Preserve formatting as much as possible.
4) Return the FULL UPDATED FILE CONTENT only. NO explanations, NO markdown, NO backticks.
`;

    const res = await model.generateContent(prompt);
    return res.response.text().replace(/[`*]/g, "").trim();
  }
}

/** =======================
 *  DEACTIVATE
 *  ======================= */
export function deactivate() {}

/** =======================
 *  WEBVIEW HTML
 *  ======================= */
export function getWebviewContent() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Snapcode Webview</title>
  <style>
    body { font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif; padding: 20px; background-color: #1e1e1e; color: #d4d4d4; }
    h1 { color: #4CAF50; margin-bottom: 10px; }
    p { color: #cccccc; margin-bottom: 15px; }
    input { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #333; background-color: #252526; color: #fff; margin-bottom: 15px; }
    button { background: #4CAF50; color: white; border: none; padding: 10px 20px; cursor: pointer; border-radius: 6px; font-size: 14px; margin-right: 10px; transition: background 0.3s ease; }
    button:hover { background: #45a049; }
    pre { background-color: #252526; color: #d4d4d4; padding: 15px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; border: 1px solid #333; font-family: Consolas, monospace; margin-top: 10px; }
    #result { background-color: #133b22; color: #b6fcb6; padding: 15px; border-radius: 8px; margin-top: 10px; border: 1px solid #2b6e3f; }
  </style>
</head>
<body>
  <h1>🚀 Snapcode Webview</h1>
  <p>Analyze your code in a clean dark UI.</p>

  <label for="filename"><b>Enter file name:</b></label>
  <input id="filename" placeholder="example.js"/>

  <div>
    <button onclick="analyze()">Check Unused Code</button>
    <button onclick="sayHello()">Run HelloWorld</button>
  </div>

  <h3>Result:</h3>
  <pre id="result">Waiting...</pre>

  <!-- searching and fixing bar -->
  <input id="filepath" placeholder="Enter file Path relative to workspace"/>
  <input id="search" placeholder="Enter function /class/console.log to search"/>
  <button onclick="analyze1()">Analyze</button>

  <h3>AI Analysis Result:</h3>
  <pre id="result1">Waiting...</pre>
  <div id="occ-list"></div>
  <div id="delete-form"></div>

  <div id="merger"></div>

  <script>
    const vscode = acquireVsCodeApi();

    window.addEventListener('message', event => {
      const message = event.data;

      if (message.command === 'showResult') {
        document.getElementById('result').textContent = message.text;
      }

      if (message.command === 'showResult1') {
        // Keep for later actions
        window.__lastFilepath = message.filepath || document.getElementById('filepath')?.value;
        window.__lastOccurrences = message.occurrences || [];
        renderOccurrences(message.occurrences, window.__lastFilepath);
        document.getElementById('result1').textContent = message.raw || '';
      }

      if (message.command === 'confirmDelete') {
        const { filepath, occurrence, scopeInfo } = message;
        const varsStr = (scopeInfo.variables || []).join(', ');
        const linesStr = (scopeInfo.lines || []).join(', ');

        document.getElementById('delete-form').innerHTML = \`
          <div style="border:1px dashed #aaa;padding:10px;margin:10px 0;border-radius:8px;">
            <div><b>Delete target:</b> \${occurrence.kind} \${occurrence.name} (\${occurrence.startLine}-\${occurrence.endLine})</div>
            <div><b>Scope:</b> \${scopeInfo.scopeType} \${scopeInfo.scopeName} (\${scopeInfo.scopeStartLine}-\${scopeInfo.scopeEndLine})</div>
            <label>Variables (array):</label>
            <textarea id="varsArea" rows="3" style="width:100%;">\${varsStr}</textarea>
            <label>Lines (array):</label>
            <textarea id="linesArea" rows="3" style="width:100%;">\${linesStr}</textarea>
            <button id="btnDoDelete">Delete with AI (auto-fix)</button>
          </div>
        \`;

        document.getElementById('btnDoDelete').onclick = () => {
          const variables = document.getElementById('varsArea').value.split(',').map(s => s.trim()).filter(Boolean);
          const lines = document.getElementById('linesArea').value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
          vscode.postMessage({
            command: 'performDelete',
            filepath,
            occurrence,
            scopeInfo,
            variables,
            lines
          });
        };
      }

      if (message.command === 'showMerger') {
        const { filepath, original, aiCode } = message;
        document.getElementById('merger').innerHTML = \`
          <h3>Snapcode Merger</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;">
            <div>
              <div><b>Original</b></div>
              <textarea id="origTA" rows="18" style="width:100%;">\${String(original).replace(/</g,'&lt;')}</textarea>
              <button id="btnUseOrig">Use Original → Merge</button>
            </div>
            <div>
              <div><b>AI (after delete & fix)</b></div>
              <textarea id="aiTA" rows="18" style="width:100%;">\${String(aiCode).replace(/</g,'&lt;')}</textarea>
              <button id="btnUseAI">Use AI → Merge</button>
            </div>
            <div>
              <div><b>Merge (editable)</b></div>
              <textarea id="mergeTA" rows="18" style="width:100%;"></textarea>
              <div style="margin-top:8px; display:flex; gap:8px;">
                <button id="btnSaveMerge">Apply Merge to File</button>
              </div>
            </div>
          </div>
        \`;
        const mergeTA = document.getElementById('mergeTA');
        document.getElementById('btnUseOrig').onclick = () => { mergeTA.value = document.getElementById('origTA').value; };
        document.getElementById('btnUseAI').onclick = () => { mergeTA.value = document.getElementById('aiTA').value; };
        document.getElementById('btnSaveMerge').onclick = () => {
          const merged = mergeTA.value;
          vscode.postMessage({ command: 'applyMergedCode', filepath, merged });
        };
      }

      if (message.command === 'toast') {
        // simple fallback toast
        alert(message.text);
      }
    });

    // analyze function for code checking
    function analyze1() {
      const filepath = document.getElementById('filepath').value;
      const search = document.getElementById('search').value;
      vscode.postMessage({ command: 'analyzeCode', filepath, search });
    }

    // analyze function for file analyze
    function analyze() {
      const filename = document.getElementById('filename').value;
      vscode.postMessage({ command: 'analyzeFile', filename });
    }

    function sayHello() {
      vscode.postMessage({ command: 'runsHelloWorld' });
    }

    function renderOccurrences(list, filepath) {
      const container = document.getElementById('occ-list');
      if (!list || !list.length) {
        container.innerHTML = "<p>No matches.</p>";
        return;
      }
      container.innerHTML = list.map((o, i) => \`
        <div style="border:1px solid #ddd;padding:8px;margin:8px 0;border-radius:8px;">
          <b>\${o.kind}:</b> \${o.name}<br>
          <b>Scope:</b> \${o.scope}<br>
          <b>Lines:</b> \${o.startLine}-\${o.endLine}<br>
          <pre style="white-space:pre-wrap">\${String(o.code).replace(/</g,'&lt;')}</pre>
          <button data-idx="\${i}" class="btn-delete">Delete this occurrence</button>
        </div>
      \`).join("");

      container.querySelectorAll(".btn-delete").forEach(btn => {
        btn.addEventListener("click", (e) => {
          const idx = +e.currentTarget.getAttribute("data-idx");
          const occ = list[idx];
          vscode.postMessage({ command: "requestScopeInfo", filepath, index: idx, occurrence: occ });
        });
      });
    }
  </script>
</body>
</html>`;
}
















// // extension.ts
// import * as vscode from "vscode";
// import * as fs from "fs";
// import * as path from "path";
// import { GoogleGenerativeAI } from "@google/generative-ai";

// /** =======================
//  * CONFIG: API KEY (replace or move later)
//  * ======================= */
// const GEMINI_API_KEY = "AIzaSyDdACIU3h59herh6ZjZnNw0oav4xRe8gK8";

// /** =======================
//  * TYPES & PARSER
//  * ======================= */
// type Occurence = {
//   kind: "Variable" | "Function" | "Import" | "Class" | "Statement";
//   name: string;
//   scope: string;
//   startLine: number;
//   endLine: number;
//   code: string;
// };

// function parseAiOccurrences(aiText: string): Occurence[] {
//   const text = aiText.replace(/[`*]/g, "");
//   const re =
//     /(Variable|Function|Import|Class|Statement):\s*([^\n]+)\s*[\r\n]+Scope:\s*([^\n]+)\s*[\r\n]+Lines:\s*(\d+)\s*-\s*(\d+)\s*[\r\n]+Code:\s*([\s\S]*?)(?=(?:\n(?:Variable|Function|Import|Class|Statement):)|$)/g;
//   const items: Occurence[] = [];
//   let m: RegExpExecArray | null;
//   while ((m = re.exec(text)) !== null) {
//     items.push({
//       kind: m[1] as Occurence["kind"],
//       name: m[2].trim(),
//       scope: m[3].trim(),
//       startLine: parseInt(m[4], 10),
//       endLine: parseInt(m[5], 10),
//       code: m[6].trim(),
//     });
//   }
//   return items;
// }

// /** =======================
//  * ACTIVATE
//  * ======================= */
// export function activate(context: vscode.ExtensionContext) {
//   // Status bar
//   const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
//   statusBarItem.text = "$(rocket) Snapcode";
//   statusBarItem.tooltip = "Click to start Snapcode engine";
//   statusBarItem.command = "Snapcode.openWebView";
//   statusBarItem.show();
//   context.subscriptions.push(statusBarItem);

//   // Hello command
//   const helloCmd = vscode.commands.registerCommand("Snapcode.helloWorld", () => {
//     vscode.window.showInformationMessage("Hello World from Snapcode!");
//     console.log("hello world");
//   });
//   context.subscriptions.push(helloCmd);

//   // Open webview
//   const webViewCommand = vscode.commands.registerCommand("Snapcode.openWebView", () => {
//     const panel = vscode.window.createWebviewPanel("snapcodeWebview", "Snapcode Panel", vscode.ViewColumn.One, {
//       enableScripts: true,
//       retainContextWhenHidden: true,
//     });

//     panel.webview.html = getWebviewContent();

//     // Handle messages from webview
//     panel.webview.onDidReceiveMessage(
//       async (message) => {
//         try {
//           // Simple tester
//           if (message.command === "runsHelloWorld") {
//             vscode.commands.executeCommand("Snapcode.helloWorld");
//             return;
//           }

//           // AI Fix Mode: analyze full file for unused imports/vars
//           if (message.command === "analyzeFile") {
//             const result = await analyzeFile(message.filename);
//             panel.webview.postMessage({ command: "showResult", text: result });
//             return;
//           }

//           // Snapcode Merge Mode: analyze occurrences of a search term
//           if (message.command === "analyzeCode") {
//             const result = await analyzeCodeBlock(message.filepath, message.search);
//             const occurrences = parseAiOccurrences(result);
//             panel.webview.postMessage({
//               command: "showResult1",
//               occurrences,
//               raw: result,
//               filepath: message.filepath,
//             });
//             return;
//           }

//           // Request scope info (webview must send the occurrence object)
//           if (message.command === "requestScopeInfo") {
//             const { filepath, occurrence } = message;
//             const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
//             if (!workspacePath) {
//               panel.webview.postMessage({ command: "toast", text: "No workspace open" });
//               return;
//             }

//             const filePath = path.join(workspacePath, filepath);
//             if (!fs.existsSync(filePath)) {
//               panel.webview.postMessage({ command: "toast", text: `File not found: ${filepath}` });
//               return;
//             }

//             const docText = fs.readFileSync(filePath, "utf8");

//             // occurrence must be provided by webview (so we know which match user clicked)
//             const occ = occurrence as Occurence | null;
//             if (!occ) {
//               panel.webview.postMessage({ command: "toast", text: "Occurrence data missing" });
//               return;
//             }

//             const scopeInfo = await getScopeInfoViaAI(filepath, docText, occ, GEMINI_API_KEY);

//             panel.webview.postMessage({
//               command: "confirmDelete",
//               filepath,
//               occurrence: occ,
//               scopeInfo,
//             });
//             return;
//           }

//           // Perform delete + AI fix — produce full updated file
//           if (message.command === "performDelete") {
//             const { filepath, occurrence, variables, lines, scopeInfo } = message;
//             const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
//             if (!workspacePath) {
//               panel.webview.postMessage({ command: "toast", text: "No workspace open" });
//               return;
//             }
//             const filePath = path.join(workspacePath, filepath);
//             if (!fs.existsSync(filePath)) {
//               panel.webview.postMessage({ command: "toast", text: `File not found: ${filePath}` });
//               return;
//             }

//             const original = fs.readFileSync(filePath, "utf8");
//             const aiCode = await aiDeleteAndFixFullFile(
//               filepath,
//               original,
//               occurrence as Occurence,
//               variables as string[],
//               lines as number[],
//               scopeInfo,
//               GEMINI_API_KEY
//             );

//             panel.webview.postMessage({
//               command: "showMerger",
//               filepath,
//               original,
//               aiCode,
//             });
//             return;
//           }

//           // Apply merged code (write file and open in editor)
//           if (message.command === "applyMergedCode") {
//             const { filepath, merged } = message;
//             const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
//             if (!workspacePath) {
//               panel.webview.postMessage({ command: "toast", text: "No workspace open" });
//               return;
//             }
//             const filePath = path.join(workspacePath, filepath);

//             try {
//               fs.writeFileSync(filePath, merged, "utf8");
//               panel.webview.postMessage({ command: "toast", text: `✅ Saved ${filepath}` });

//               // Open file in editor
//               const docUri = vscode.Uri.file(filePath);
//               const doc = await vscode.workspace.openTextDocument(docUri);
//               await vscode.window.showTextDocument(doc, { preview: false });
//             } catch (e) {
//               panel.webview.postMessage({ command: "toast", text: `Error saving file: ${e}` });
//             }
//             return;
//           }
//         } catch (err) {
//           panel.webview.postMessage({ command: "toast", text: `Error: ${err}` });
//         }
//       },
//       undefined,
//       context.subscriptions
//     );

//     context.subscriptions.push(panel);
//   });

//   context.subscriptions.push(webViewCommand);

//   /** ========== Helper functions ========== */

//   async function analyzeFile(filename: string): Promise<string> {
//     const workspaceFolders = vscode.workspace.workspaceFolders;
//     if (!workspaceFolders) return "No workspace open!";
//     const workspacePath = workspaceFolders[0].uri.fsPath;
//     const filePath = path.join(workspacePath, filename);
//     if (!fs.existsSync(filePath)) return `❌ File not found: ${filename}`;
//     const fileContent = fs.readFileSync(filePath, "utf8");

//     try {
//       const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
//       const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

//       const prompt = `
// You are a code analyzer. Given the following file:

// Filename: ${filename}

// Code:
// ---
// ${fileContent}
// ---

// Task:
// 1. Find all unused imports.
// 2. Find all unused variables.
// 3. For each one, return the variable/import name and the line number.
// Return results in a clear list format with NO markdown, NO asterisks, NO backticks.
// `;

//       const result = await model.generateContent(prompt);
//       let output = result.response.text();
//       output = output.replace(/[`*]/g, "").trim();
//       return output;
//     } catch (err) {
//       return `Error: ${err}`;
//     }
//   }

//   async function analyzeCodeBlock(filename: string, searchTerm: string): Promise<string> {
//     const workspaceFolders = vscode.workspace.workspaceFolders;
//     if (!workspaceFolders) return "No Workspace Folders";
//     const workspacePath = workspaceFolders[0].uri.fsPath;
//     const filePath = path.join(workspacePath, filename);
//     if (!fs.existsSync(filePath)) return `File not found: ${filename}`;

//     const code = fs.readFileSync(filePath, "utf8");
//     const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
//     const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

//     const prompt = `
// You are a code analyzer.
// Given this file: ${filename}

// Code:
// ---
// ${code}
// ---

// Task:
// 1. Find all occurrences of "${searchTerm}" that are used and unused.
// 2. Consider scope: variables or functions inside another function or class must be treated separately from globals.
// 3. For each occurrence, return:
//    - type (variable/function/import)
//    - exact code
//    - start line and end line
//    - parent scope (global or function/class name)
// 4. Do NOT include anything that is not exactly "${searchTerm}".
// 5. Return only plain text, no markdown, no backticks.

// Example output format:

// Variable: unusedVar
// Scope: global
// Lines: 2-2
// Code:
// const unusedVar = 859;

// Variable: unusedVar
// Scope: function someFunction
// Lines: 5-5
// Code:
// unusedVar = 90;
// `;

//     const result = await model.generateContent(prompt);
//     let output = result.response.text();
//     output = output.replace(/[`*]/g, "").trim();
//     return output;
//   }

//   async function getScopeInfoViaAI(
//     filename: string,
//     fullcode: string,
//     occurence: Occurence,
//     apikey: string
//   ): Promise<{
//     scopeType: string;
//     scopeName: string;
//     scopeStartLine: number;
//     scopeEndLine: number;
//     variables: string[];
//     lines: number[];
//   }> {
//     const genAI = new GoogleGenerativeAI(apikey);
//     const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

//     const prompt = `
// You are a precise code analyst.

// File: ${filename}

// code:
// ---
// ${fullcode}
// ---

// Target occurrence:
// - kind: ${occurence.kind}
// - name: ${occurence.name}
// - lines: ${occurence.startLine}-${occurence.endLine}
// - scopeLabel: ${occurence.scope}

// Task:
// 1) Find the nearest enclosing function or class for this occurrence (if none, scope is "global").
// 2) Return STRICT JSON (no markdown) with:
// {
//   "scopeType": "function|class|global",
//   "scopeName": "<name or global>",
//   "scopeStartLine": <number>,
//   "scopeEndLine": <number>,
//   "variables": ["list","all","declared","names","in","this","scope"],
//   "lines": [<every integer line from scopeStartLine to scopeEndLine>]
// }
// ONLY JSON.
// `;

//     const res = await model.generateContent(prompt);
//     const text = res.response.text().replace(/[`*]/g, "").trim();
//     try {
//       return JSON.parse(text);
//     } catch {
//       return {
//         scopeType: "unknown",
//         scopeName: occurence.scope || "unknown",
//         scopeStartLine: occurence.startLine,
//         scopeEndLine: occurence.endLine,
//         variables: [],
//         lines: Array.from({ length: occurence.endLine - occurence.startLine + 1 }, (_, i) => occurence.startLine + i),
//       };
//     }
//   }

//   async function aiDeleteAndFixFullFile(
//     filename: string,
//     originalCode: string,
//     occurrence: Occurence,
//     variables: string[],
//     lines: number[],
//     scopeInfo: { scopeType: string; scopeName: string; scopeStartLine: number; scopeEndLine: number },
//     apiKey: string
//   ): Promise<string> {
//     const genAI = new GoogleGenerativeAI(apiKey);
//     const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

//     const prompt = `
// You are a precise refactoring assistant.

// File: ${filename}

// Original code:
// ---
// ${originalCode}
// ---

// Delete target:
// - kind: ${occurrence.kind}
// - name: ${occurrence.name}
// - occurrenceLines: ${occurrence.startLine}-${occurrence.endLine}

// Scope info:
// - scopeType: ${scopeInfo.scopeType}
// - scopeName: ${scopeInfo.scopeName}
// - scopeLines: ${scopeInfo.scopeStartLine}-${scopeInfo.scopeEndLine}

// Context arrays provided by user:
// - variablesInScope: [${variables.join(", ")}]
// - linesToConsider: [${lines.join(", ")}]

// Tasks:
// 1) Remove ONLY the target occurrence safely.
// 2) Fix any resulting errors (unresolved references, imports, params, returns) minimally.
// 3) Preserve formatting as much as possible.
// 4) Return the FULL UPDATED FILE CONTENT only. NO explanations, NO markdown, NO backticks.
// `;

//     const res = await model.generateContent(prompt);
//     return res.response.text().replace(/[`*]/g, "").trim();
//   }
// }

// /** =======================
//  * DEACTIVATE
//  * ======================= */
// export function deactivate() {}

// /** =======================
//  * WEBVIEW HTML
//  * ======================= */
// export function getWebviewContent() {
//   return `<!DOCTYPE html>
// <html lang="en">
// <head>
//   <meta charset="UTF-8" />
//   <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
//   <title>Snapcode Webview</title>
//   <style>
//     body { font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif; padding: 20px; background-color: #1e1e1e; color: #d4d4d4; }
//     h1 { color: #4CAF50; margin-bottom: 10px; }
//     p { color: #cccccc; margin-bottom: 15px; }
//     input, select, textarea { width: 100%; padding: 10px; border-radius: 6px; border: 1px solid #333; background-color: #252526; color: #fff; margin-bottom: 12px; }
//     button { background: #4CAF50; color: white; border: none; padding: 10px 20px; cursor: pointer; border-radius: 6px; font-size: 14px; margin-right: 10px; transition: background 0.3s ease; }
//     button:hover { background: #45a049; }
//     pre { background-color: #252526; color: #d4d4d4; padding: 15px; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; border: 1px solid #333; font-family: Consolas, monospace; margin-top: 10px; }
//     #result { background-color: #133b22; color: #b6fcb6; padding: 15px; border-radius: 8px; margin-top: 10px; border: 1px solid #2b6e3f; }
//     .grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
//   </style>
// </head>
// <body>
//   <h1>🚀 Snapcode</h1>
//   <p>AI-assisted code refactoring (AI Fix Mode & Snapcode Merge Mode)</p>

//   <label for="mode"><b>Mode:</b></label>
//   <select id="mode">
//     <option value="snapMerge" selected>Snapcode Merge Mode (targeted)</option>
//     <option value="aiFix">AI Fix Mode (whole-file analysis)</option>
//   </select>

//   <div>
//     <label><b>AI Fix - filename (relative to workspace)</b></label>
//     <input id="filename" placeholder="example.js"/>
//     <label><b>Snap Merge - file path (relative)</b></label>
//     <input id="filepath" placeholder="src/example.js"/>
//     <input id="search" placeholder="functionName / variableName / console.log / className"/>
//     <div style="display:flex; gap:8px; margin-bottom:12px;">
//       <button id="analyzeBtn">Analyze</button>
//       <button id="helloBtn">Run HelloWorld</button>
//     </div>
//   </div>

//   <h3>Result (AI Fix Mode):</h3>
//   <pre id="result">Waiting...</pre>

//   <h3>AI Analysis Result (Snap Merge Mode):</h3>
//   <pre id="result1">Waiting...</pre>
//   <div id="occ-list"></div>
//   <div id="delete-form"></div>

//   <div id="merger"></div>

//   <script>
//     const vscode = acquireVsCodeApi();

//     document.getElementById('analyzeBtn').addEventListener('click', () => {
//       const mode = document.getElementById('mode').value;
//       if (mode === 'aiFix') {
//         const filename = document.getElementById('filename').value;
//         vscode.postMessage({ command: 'analyzeFile', filename });
//       } else {
//         const filepath = document.getElementById('filepath').value;
//         const search = document.getElementById('search').value;
//         vscode.postMessage({ command: 'analyzeCode', filepath, search });
//       }
//     });

//     document.getElementById('helloBtn').addEventListener('click', () => {
//       vscode.postMessage({ command: 'runsHelloWorld' });
//     });

//     window.addEventListener('message', event => {
//       const message = event.data;

//       if (message.command === 'showResult') {
//         document.getElementById('result').textContent = message.text;
//       }

//       if (message.command === 'showResult1') {
//         window.__lastFilepath = message.filepath || document.getElementById('filepath')?.value;
//         window.__lastOccurrences = message.occurrences || [];
//         renderOccurrences(message.occurrences || [], window.__lastFilepath);
//         document.getElementById('result1').textContent = message.raw || '';
//       }

//       if (message.command === 'confirmDelete') {
//         const { filepath, occurrence, scopeInfo } = message;
//         const varsStr = (scopeInfo.variables || []).join(', ');
//         const linesStr = (scopeInfo.lines || []).join(', ');

//         document.getElementById('delete-form').innerHTML = \`
//           <div style="border:1px dashed #aaa;padding:10px;margin:10px 0;border-radius:8px;">
//             <div><b>Delete target:</b> \${occurrence.kind} \${occurrence.name} (\${occurrence.startLine}-\${occurrence.endLine})</div>
//             <div><b>Scope:</b> \${scopeInfo.scopeType} \${scopeInfo.scopeName} (\${scopeInfo.scopeStartLine}-\${scopeInfo.scopeEndLine})</div>
//             <label>Variables (array):</label>
//             <textarea id="varsArea" rows="3" style="width:100%;">\${varsStr}</textarea>
//             <label>Lines (array):</label>
//             <textarea id="linesArea" rows="3" style="width:100%;">\${linesStr}</textarea>
//             <div style="margin-top:8px;">
//               <button id="btnDoDelete">Delete with AI (auto-fix)</button>
//             </div>
//           </div>
//         \`;

//         document.getElementById('btnDoDelete').onclick = () => {
//           const variables = document.getElementById('varsArea').value.split(',').map(s => s.trim()).filter(Boolean);
//           const lines = document.getElementById('linesArea').value.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
//           vscode.postMessage({
//             command: 'performDelete',
//             filepath,
//             occurrence,
//             scopeInfo,
//             variables,
//             lines
//           });
//         };
//       }

//       if (message.command === 'showMerger') {
//         const { filepath, original, aiCode } = message;
//         document.getElementById('merger').innerHTML = \`
//           <h3>Snapcode Merger</h3>
//           <div class="grid3">
//             <div>
//               <div><b>Original</b></div>
//               <textarea id="origTA" rows="20" style="width:100%;">\${String(original).replace(/</g,'&lt;')}</textarea>
//               <button id="btnUseOrig">Use Original → Merge</button>
//             </div>
//             <div>
//               <div><b>AI (after delete & fix)</b></div>
//               <textarea id="aiTA" rows="20" style="width:100%;">\${String(aiCode).replace(/</g,'&lt;')}</textarea>
//               <button id="btnUseAI">Use AI → Merge</button>
//             </div>
//             <div>
//               <div><b>Merge (editable)</b></div>
//               <textarea id="mergeTA" rows="20" style="width:100%;"></textarea>
//               <div style="margin-top:8px; display:flex; gap:8px;">
//                 <button id="btnSaveMerge">Apply Merge to File</button>
//               </div>
//             </div>
//           </div>
//         \`;

//         const mergeTA = document.getElementById('mergeTA');
//         document.getElementById('btnUseOrig').onclick = () => { mergeTA.value = document.getElementById('origTA').value; };
//         document.getElementById('btnUseAI').onclick = () => { mergeTA.value = document.getElementById('aiTA').value; };
//         document.getElementById('btnSaveMerge').onclick = () => {
//           const merged = mergeTA.value;
//           vscode.postMessage({ command: 'applyMergedCode', filepath, merged });
//         };
//       }

//       if (message.command === 'toast') {
//         alert(String(message.text));
//       }
//     });

//     // render occurrences list with delete buttons
//     function renderOccurrences(list, filepath) {
//       const container = document.getElementById('occ-list');
//       if (!list || !list.length) {
//         container.innerHTML = "<p>No matches.</p>";
//         return;
//       }
//       container.innerHTML = list.map((o, i) => \`
//         <div style="border:1px solid #ddd;padding:8px;margin:8px 0;border-radius:8px;">
//           <b>\${o.kind}:</b> \${o.name}<br>
//           <b>Scope:</b> \${o.scope}<br>
//           <b>Lines:</b> \${o.startLine}-\${o.endLine}<br>
//           <pre style="white-space:pre-wrap">\${String(o.code).replace(/</g,'&lt;')}</pre>
//           <button data-idx="\${i}" class="btn-delete">Delete this occurrence</button>
//         </div>
//       \`).join("");

//       container.querySelectorAll(".btn-delete").forEach(btn => {
//         btn.addEventListener("click", (e) => {
//           const idx = +e.currentTarget.getAttribute("data-idx");
//           const occ = list[idx];
//           vscode.postMessage({ command: "requestScopeInfo", filepath, occurrence: occ });
//         });
//       });
//     }
//   </script>
// </body>
// </html>`;
// }
