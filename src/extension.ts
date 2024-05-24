// SPDX-FileCopyrightText: 2024 Daniel Vrátil <me@dvratil.cz>
//
// SPDX-License-Identifier: MIT

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

function getQCHDirectories(context: vscode.ExtensionContext): string[] {
	return vscode.workspace.getConfiguration(context.extension.id).get<string[]>('qtDocPaths') || defaultQCHPaths();
}

async function checkIndex(context: vscode.ExtensionContext): Promise<boolean> {
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
				resolve(message.needsReindexing);
			} else if (message.type === 'error') {
				reject(new Error(message.error));
			}
		});
		worker.on("error", (code) => {
			console.error(`Worker error: ${code.message}`);
			reject(code);
		});

		worker.postMessage({ type: "checkIndex", qchDirectories: getQCHDirectories(context) });
	}));
}

async function reindex(context: vscode.ExtensionContext): Promise<void> {
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

		worker.postMessage({ type: "reindex", qchDirectories: getQCHDirectories(context) });
	}));
}

export function activate(context: vscode.ExtensionContext) {
	console.log("QCH extension activating");

	// Check whether we have any directories to scan, show a message to the user if not
	const qchDirectories = getQCHDirectories(context);
	if (qchDirectories.length === 0) {
		vscode.window.showInformationMessage("No Qt documentation directories configured. Please configure the directories in the extension settings.",
			"Open settings").then((value) => {
				if (value === "Open settings") {
					vscode.commands.executeCommand("workbench.action.openSettings", "vscode-extension-qch.qtDocPaths");
				}
			}
		);
	} else {
		// Check index and trigger reindexing, if necessary
		(async () => {
			try {
				if (await checkIndex(context)) {
					await reindex(context);
				}
			} catch (error) {
				vscode.window.showErrorMessage(`Indexer failed with error: ${error}`);
			}
		})();
	}

	// Register a hook to trigger reindexng when the configuration changes
	vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('vscode-extension-qch.qtDocPaths')) {
			reindex(context);
		}
	});

	// Register the main hook to provide documentation on hover
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

			const definitions = await vscode.commands.executeCommand<vscode.Definition | vscode.LocationLink[]>("vscode.executeDefinitionProvider", editor?.document.uri, position);
			if (!definitions) {
				return { contents: [] };
			}

			// Take the last definition, as those tend to be the correct ones if the provider somehow discovers
			// a same-name definition in the current project.
			const definition = (Array.isArray(definitions) ? definitions[definitions.length -1] : definitions) as vscode.Location;
			const doc = await vscode.workspace.openTextDocument(definition.uri);
			if (!doc.validateRange(definition.range)) {
				return { contents: [] };
			}

			const rangeText = doc.getText(definition.range);
			const sourceLine = doc.lineAt(definition.range.start.line).text;

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
			let md = NodeHtmlMarkdown.translate(data);
			// Replace relative links with absolute link to online documentation
			// FIXME: Ideally we would do this in the NodeHtmlMarkdown with a custom translator
			md = md.replace(/([a-zA-Z0-9\-_]+\.html)/g, 'https://doc.qt.io/qt-6/$1');

			console.log(`Documentation for symbol ${fqSymbol.name} resolved in ${performance.now() - hoverStart} ms`);

			return {
				contents: [md]
			};
		}
	});

	// Register commands
	let disposable = vscode.commands.registerCommand('vscode-extension-qch.reindex', async () => {
		await reindex(context);
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	console.log("QCH extension deactivating");

	symbolMap = undefined;
	fileMap = undefined;
}
