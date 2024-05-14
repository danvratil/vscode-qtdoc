// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { NodeHtmlMarkdown, NodeHtmlMarkdownOptions } from 'node-html-markdown';
import { Worker } from 'worker_threads';
import { Response } from './worker.js';

type Symbol = {
	name: string,
	type: vscode.SymbolKind,
};

function resolveFQSymbol(symbols: vscode.DocumentSymbol[], symbol: string): Symbol | undefined
{
	for (const s of symbols) {
		if (s.name === symbol) {
			return { name: s.name, type: s.kind };
		}

		const subSymbol = resolveFQSymbol(s.children, symbol);
		if (subSymbol) {
			// We use the type of the leaf symbol
			return { name: s.name + "::" + subSymbol.name, type: subSymbol.type };
		}
	}

	return undefined;
}

type Result = {
	path: string,
	anchor: string | undefined
};

function defaultQCHPaths(): string[]
{
    if (process.platform === 'linux') {
        return [
            '/usr/share/doc/qt5',
            '/usr/share/doc/qt6'
        ];
    } else if (process.platform === 'win32') {
        // TODO: How can we find or detect some reasonable defaults on Windows?
    } else if (process.platform === 'darwin') {
        // TODO: How can we find or detect some reasonalbe defaults on macOS?
    }

    return [];
}

function getQCHDirectories(): string[] {
	return vscode.workspace.getConfiguration('qch').get<string[]>('paths') || defaultQCHPaths();
}

async function checkIndex(context: vscode.ExtensionContext): Promise<string[]> {
	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		cancellable: true,
		title: "Validating QCH files index..."
	}, (progress, token) => new Promise((resolve, reject) => {
		const worker = new Worker(new URL(vscode.Uri.joinPath(context.extensionUri, '/dist/worker.js').toString(true)));
		let donePercent = 0;
		worker.on("message", (message: Response) => {
			if (message.type === 'progress') {
				const newProgressPercent = (message.progress.done / message.progress.total) * 100;
				progress.report({ increment: newProgressPercent - donePercent });
				donePercent = newProgressPercent;
			} else if (message.type === 'checkIndexDone') {
				resolve(message.filesToReindex);
			} else if (message.type === 'error') {
				reject(new Error(message.error));
			}
		});
		worker.on("error", (code) => {
			console.error(`Worker error: ${code.message}`);
			reject(code);
		});

		worker.postMessage({ type: "checkIndex", qchDirectories: getQCHDirectories() });
	}));
}

async function reindex(context: vscode.ExtensionContext, filesToReindex: string[]): Promise<void> {
	return vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		cancellable: true,
		title: "Reindexing QCH files..."
	}, (progress, token) => new Promise((resolve, reject) => {
		const worker = new Worker(new URL(vscode.Uri.joinPath(context.extensionUri, '/dist/worker.js').toString(true)));
		let donePercent = 0;
		worker.on("message", (message: Response) => {
			if (message.type === 'progress') {
				const newProgressPercent = (message.progress.done / message.progress.total) * 100;
				progress.report({ increment: newProgressPercent - donePercent });
				donePercent = newProgressPercent;
			} else if (message.type === 'indexingDone') {
				resolve();
			} else if (message.type === 'error') {
				reject(new Error(message.error));
			}
		});
		worker.on("error", (code) => {
			console.error(`Worker error: ${code.message}`);
			reject(code);
		});

		worker.postMessage({ type: "reindex", qchFiles: filesToReindex });
	}));
}

export function activate(context: vscode.ExtensionContext) {
	console.log("QCH extension activating");

	let indexerDisposable = vscode.commands.registerCommand('extensions.useWorker', async () => {
		try {
			const filesToReindex = await checkIndex(context);
			if (filesToReindex.length > 0) {
				await reindex(context, filesToReindex);
			}
		} catch (error) {
			vscode.window.showErrorMessage(`Indexer failed with error: ${error}`);
		}
	});


	context.subscriptions.push(indexerDisposable);

	vscode.commands.executeCommand('extensions.useWorker');

	/*
	vscode.languages.registerHoverProvider('cpp', {
		async provideHover(document, position, cancellationToken): Promise<vscode.Hover> {
			const editor = vscode.window.activeTextEditor;

			const definition = await vscode.commands.executeCommand<vscode.Definition | vscode.LocationLink[]>("vscode.executeDefinitionProvider", editor?.document.uri, position);
			if (!definition) {
				return { contents: []};
			}

			const def = (Array.isArray(definition) ? definition[0] : definition) as vscode.Location;
			const doc = await vscode.workspace.openTextDocument(def.uri);
			if (!doc.validateRange(def.range)) {
				console.log("Invalid range");
				return { contents: [] };
			}

			const rangeText = doc.getText(def.range);
			console.log(`Range text: ${rangeText}`);
			const sourceLine = doc.lineAt(def.range.start.line).text;
			console.log(`Source line: ${sourceLine}`);

			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", doc.uri);
			let start = performance.now();
			const fqSymbol = resolveFQSymbol(symbols, rangeText);
			console.log(`FQ symbol: ${fqSymbol}, took ${performance.now() - start} ms`);
			if (!fqSymbol) {
				return { contents: [] };
			}

			start = performance.now();
			const result = await resolveSymbolDocs(context, fqSymbol.name);
			if (!result) {
				console.error("Failed to resolve FQ symbol in DB");
				return { contents: [] };
			}
			console.log(`FQ symbol docs path: ${result.path}, anchor: ${result.anchor}, took ${performance.now() - start} ms`);

			const html = await (async () => {
				try {
					return await vscode.workspace.fs.readFile(vscode.Uri.parse(`file:///usr/share/doc/qt6/${result.path}`));
				} catch (e) {
					console.error("Failed to load HMTL doc file: ", e);
					return undefined;
				}
			})();
			if (!html) {
				console.error("Failed to load HMTL doc file");
				return { contents: [] };
			}
			console.log("Loaded HTML file");

			const root = (() => { try {
				return parse(html.toString());
			} catch (e) {
				console.error("Failed to parse HTML doc");
				return undefined;
			} })();
			console.log("Parsed HTML file");

			if (!root) {
				return { contents: [] };
			}
			const elem = root.querySelector(`h3#${result.anchor}`);
			if (!elem) {
				console.error("Failed to find anchor in HTML doc");
				return { contents: [] };
			}
			console.log("Found anchor in HTML doc");

			let docu = "";
			let para = elem?.nextElementSibling;
			while (para && para.tagName.toLowerCase() === "p") {
				docu += para.outerHTML;
				para = para.nextElementSibling;
			}

			const md = NodeHtmlMarkdown.translate(docu, {});

			return {
				contents: [md]
			};
		}
	});
	*/

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	let disposable = vscode.commands.registerCommand('vscode-extension-qch.rescan', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Re-scanning QCH files');
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
