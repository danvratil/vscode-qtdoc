// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import fs from 'fs/promises';
import path from 'path';

import { NodeHtmlMarkdown } from 'node-html-markdown';
import { Worker } from 'worker_threads';

import { Response } from './worker.js';
import { FileId, SymbolData, SymbolId, generateSymbolId } from './indexer';
import { getCacheDirectory } from './utils';

let symbolMap: Map<SymbolId, SymbolData> | undefined = undefined;
let fileMap: Map<FileId, string> | undefined = undefined;

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

async function initializeLookupMaps(): Promise<void> {
	async function readJsonFile<K, V>(file: string): Promise<Map<K, V>> {
		const result = await fs.readFile(file);
		const json = JSON.parse(new TextDecoder().decode(result));
		return new Map<K, V>(json);
	}

	const symbolMapFile = path.join(getCacheDirectory(), 'symbol_map.json');
	symbolMap = await readJsonFile(symbolMapFile);

	const fileMapFile = path.join(getCacheDirectory(), 'file_map.json');
	fileMap = await readJsonFile(fileMapFile);
}

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

			symbolMap = undefined;
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

	vscode.languages.registerHoverProvider('cpp', {
		async provideHover(document, position, cancellationToken): Promise<vscode.Hover> {

			let hoverStart = performance.now();

			if (!symbolMap || !fileMap) {
				await initializeLookupMaps();
				if (!symbolMap || !fileMap) {
					return { contents: [] };
				}
			}

			const editor = vscode.window.activeTextEditor;

			const definition = await vscode.commands.executeCommand<vscode.Definition | vscode.LocationLink[]>("vscode.executeDefinitionProvider", editor?.document.uri, position);
			if (!definition) {
				return { contents: [] };
			}

			const def = (Array.isArray(definition) ? definition[0] : definition) as vscode.Location;
			const doc = await vscode.workspace.openTextDocument(def.uri);
			if (!doc.validateRange(def.range)) {
				return { contents: [] };
			}

			const rangeText = doc.getText(def.range);
			const sourceLine = doc.lineAt(def.range.start.line).text;

			const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", doc.uri);
			let start = performance.now();
			const fqSymbol = resolveFQSymbol(symbols, rangeText);
			console.log(`FQ symbol: ${fqSymbol?.name}, ${fqSymbol?.type}, took ${performance.now() - start} ms`);
			if (!fqSymbol) {
				return { contents: [] };
			}

			const symbolId = generateSymbolId(fqSymbol.name);
			if (!symbolId) {
				return { contents: [] };
			}

			const symbolData = symbolMap.get(symbolId);
			if (!symbolData) {
				console.debug(`No documentation for symbol ID ${symbolId} (symbol ${fqSymbol.name})`);
				return { contents: [] };
			}

			const filePath = fileMap.get(symbolData.fileId);
			if (!filePath) {
				return { contents: [] };
			}

			const fd = await fs.open(filePath, 'r');
			const stream = fd.createReadStream({
				autoClose: true,
				start: symbolData.anchor.offset,
				end: symbolData.anchor.offset + symbolData.anchor.len
			});

			let dataPromise = new Promise<string>((resolve, reject) => {
				let data = "";
				stream.on('data', (chunk: string | Buffer) => {
					if (chunk instanceof Buffer) {
						data += chunk.toString('utf8');
					} else {
						data += chunk;
					}
				});
				stream.on('end', () => {
					resolve(data);
				});
				stream.on('error', (err) => {
					reject(err);
				});
			});

			const data = await dataPromise;
			const md = NodeHtmlMarkdown.translate(data, {});

			console.log(`Documentation for symbol ${fqSymbol.name} resolved in ${performance.now() - hoverStart} ms`);

			return {
				contents: [md]
			};
		}
	});

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
