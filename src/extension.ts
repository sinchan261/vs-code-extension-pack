// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
// import {getWebviewContent} from './webview';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GoogleGenerativeAI } from "@google/generative-ai";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {


	// console.log('Congratulations, your extension "Snapcode" is now active!');


	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,100);
	statusBarItem.text = "$(rocket) Snapcode";
	statusBarItem.tooltip = "Click to start snapcode engine";
	statusBarItem.command = "Snapcode.openWebView";
	statusBarItem.show();
	context.subscriptions.push(statusBarItem);
   
	const disposable = vscode.commands.registerCommand('Snapcode.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from Snapcode!');
		console.log("hello world");
	});
	context.subscriptions.push(disposable);
        
	const webViewCommand = vscode.commands.registerCommand('Snapcode.openWebView',()=>{

		     const panel = vscode.window.createWebviewPanel(
				'snapcodeWebview',
				'Snapcode Panel',
				vscode.ViewColumn.One,{
					enableScripts : true
				}
			 );
		 panel.webview.onDidReceiveMessage(
				async(message) =>{
				if(message.command === 'runsHelloWorld'){
						vscode.commands.executeCommand('Snapcode.helloWorld');
					}

			 if (message.command === 'analyzeFile') {
          const result = await analyzeFile(message.filename);
          panel.webview.postMessage({ command: 'showResult', text: result });
        }

		  if( message.command === 'analyzeCode'){
			const result = await analyzeCodeBlock(message.filepath,message.search);
			panel.webview.postMessage({command:'showResult1',text:result});
		  }
				},
				undefined,
				context.subscriptions
			 );
			 panel.webview.html= getWebviewContent();
	});
	context.subscriptions.push(webViewCommand);



async function analyzeFile(filename:string): Promise<string>{
		  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders){ return "No workspace open!";}

  const workspacePath = workspaceFolders[0].uri.fsPath;
  const filePath = path.join(workspacePath, filename);
  if (!fs.existsSync(filePath)){
    return `❌ File not found: ${filename}`;
  }
  const fileContent = fs.readFileSync(filePath, 'utf8');

  // Call Gemini API
  try {
    const genAI = new GoogleGenerativeAI("AIzaSyDdACIU3h59herh6ZjZnNw0oav4xRe8gK8");
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
Return results in a clear list format.
    `;

    const result = await model.generateContent(prompt);
  let output =  result.response.text();

   output = output.replace(/[`*]/g,"").trim();
   return output ; 

  } catch (err) {
    return `Error: ${err}`;
  }
	}

    // async function for checking analyzecode  from exact file

async function analyzeCodeBlock(filename:string,searchTerm:string){

		const workspaceFolders = vscode.workspace.workspaceFolders;
		if(!workspaceFolders) {return "No Workspace Folders";}
          
		const worksspacepath = workspaceFolders[0].uri.fsPath;

		const filePath = path.join(worksspacepath,filename);
		if( !fs.existsSync(filePath)){ return `File not found:${filename}`;}
       
		const code = fs.readFileSync(filePath,'utf8');
		const genAI = new GoogleGenerativeAI("AIzaSyDdACIU3h59herh6ZjZnNw0oav4xRe8gK8");
		const model = genAI.getGenerativeModel({model:"gemini-1.5-flash"});
const prompt = `
You are a code analyzer.
Given this file: ${filename}

Code:
---
${code}
---

Task:
1. Find all occurrences of "${searchTerm}" that are used and  unused.
2. Consider scope: variables or functions inside another function or class must be treated separately from globals.
3. For each occurrence, return:
   - type (variable/function/import)
   - exact code
   - start line and end line
   - parent scope (global or function/class name)
4. Do NOT include anything that is **not "${searchTerm}"**.
5. Return only plain text, no markdown or code blocks.

Example output format:

Variable: unusedVar
Scope: global
Lines: 2-2
Code:
const unusedVar = 859;

Function: unusedVar
Scope: function someFunction
Lines: 5-7
Code:
const unusedVar = 90;

`;


		 const result = await model.generateContent(prompt);
		 let output = result.response.text();
		 output = output.replace(/[`*]/g, "").trim();
       console.log(output);
		 return output;


	}


}

// This method is called when your extension is deactivated
export function deactivate() {};


export function getWebviewContent() {
	return `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Snapcode Webview</title>
		<style>
			body {
				font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
				padding: 20px;
				background-color: #1e1e1e; /* Dark background */
				color: #d4d4d4; /* Light text */
			}

			h1 {
				color: #4CAF50;
				margin-bottom: 10px;
			}

			p {
				color: #cccccc;
				margin-bottom: 15px;
			}

			input {
				width: 100%;
				padding: 10px;
				border-radius: 6px;
				border: 1px solid #333;
				background-color: #252526;
				color: #fff;
				margin-bottom: 15px;
			}

			button {
				background: #4CAF50;
				color: white;
				border: none;
				padding: 10px 20px;
				cursor: pointer;
				border-radius: 6px;
				font-size: 14px;
				margin-right: 10px;
				transition: background 0.3s ease;
			}

			button:hover {
				background: #45a049;
			}

			pre {
				background-color: #252526;
				color: #d4d4d4;
				padding: 15px;
				border-radius: 8px;
				white-space: pre-wrap;
				word-wrap: break-word;
				border: 1px solid #333;
				font-family: Consolas, monospace;
				margin-top: 10px;
			}

			#result {
				background-color: #133b22; /* Dark green block */
				color: #b6fcb6;
				padding: 15px;
				border-radius: 8px;
				margin-top: 10px;
				border: 1px solid #2b6e3f;
			}
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

		//searching and fixing bar 
              <input id ="filepath" placeholder = "Enter file Path relative to wrokspace"/>
			  <input id ="search" placeholder = "Enter function /class/console.log to search"/>
			  <button onclick="analyze1()">Analyze</button>
			  <h3> AI Analysis Result: </h3>
			  <Pre id= "result1"> Waiting...</pre>

		<script>
			const vscode = acquireVsCodeApi();


			window.addEventListener('message', event => {
				const message = event.data;
				console.log(message.text);
				if (message.command === 'showResult') {
					document.getElementById('result').textContent = message.text;
				}
                     
				// insert the code analyze result into frontend
				if( message.command === 'showResult1'){
				document.getElementById('result1').textContent = message.text
				}
			});
            
			// analyze function for code checking
			function analyze1(){
			const filepath = document.getElementById('filepath').value;
			const search = document.getElementById('search').value;
			 vscode.postMessage({ command: 'analyzeCode',filepath,search});
			}

               // analyze function for file analyze
		  function analyze() {
				const filename = document.getElementById('filename').value;
				vscode.postMessage({ command: 'analyzeFile', filename });
			}

			function sayHello() {
				vscode.postMessage({ command: 'runsHelloWorld' });
			}



		</script>
	</body>
	</html>`;
}


















