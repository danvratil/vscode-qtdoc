// SPDX-FileCopyrightText: 2024 Daniel Vrátil <me@dvratil.cz>
//
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import fs from 'fs/promises';
import path from 'path';

import { Worker } from 'worker_threads';

import { Response } from './worker.js';
import { FileId, SymbolData, SymbolId } from './indexer';
import { getCacheDirectory } from './utils';
import { HoverProvider } from './hoverprovider';

const symbolMap = new Map<SymbolId, SymbolData>();
const fileMap = new Map<FileId, string>();

async function initializeLookupMaps(): Promise<void> {
	async function readJsonFile<K, V>(file: string, map: Map<K, V>): Promise<void> {
		map.clear();

		if (!await fs.stat(file).then(stat => stat.isFile()).catch(() => false)) {
			// Nothing to do, file doesn't exist
			return;
		}
		const result = await fs.readFile(file);
		const json = JSON.parse(new TextDecoder().decode(result));
		if (!Array.isArray(json)) {
			throw new Error(`Invalid cache data in ${file}`);
		}
		for (const entry of json) {
			if (!Array.isArray(entry) || entry.length !== 2) {
				throw new Error(`Invalid cache data in ${file}`);
			}
			map.set(entry[0] as K, entry[1] as V);
		}
	}

	try {
		const symbolMapFile = path.join(getCacheDirectory(), 'symbol_map.json');
		await readJsonFile(symbolMapFile, symbolMap);

		const fileMapFile = path.join(getCacheDirectory(), 'file_map.json');
		await readJsonFile(fileMapFile, fileMap);
	} catch (error) {
		console.error(`Failed to read cache files: ${error}`);
		symbolMap.clear();
		fileMap.clear();
	}
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
	return vscode.workspace.getConfiguration("qtdoc").get<string[]>('paths') || defaultQCHPaths();
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

		token.onCancellationRequested(async () => {
			// TODO: Implement proper cancellation of the scanning process
			await worker.terminate();
		});

		worker.postMessage({ type: "checkIndex", qchDirectories: getQCHDirectories() });
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
		worker.on("message", async (message: Response) => {
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

		token.onCancellationRequested(async () => {
			// TODO: Implement proper cancellation of the indexing process
			await worker.terminate();
		});

		worker.postMessage({ type: "reindex", qchDirectories: getQCHDirectories() });
	}));
}

function registerProviders(context: vscode.ExtensionContext): void {
	// Register the main hook to provide documentation on hover
	const provider = vscode.languages.registerHoverProvider('cpp', new HoverProvider(symbolMap, fileMap));
	context.subscriptions.push(provider);
}

function registerCommands(context: vscode.ExtensionContext): void {
	const command = vscode.commands.registerCommand('qtdoc.reindex', async () => {
		await reindex(context);
	});
	context.subscriptions.push(command);
}

export function activate(context: vscode.ExtensionContext) {
	console.log("QCH extension activating");

	// Register a hook to trigger reindexng when the configuration changes
	vscode.workspace.onDidChangeConfiguration(async (event) => {
		if (event.affectsConfiguration('qtdoc.paths')) {
			await reindex(context);
			await initializeLookupMaps();
		}
	});

	registerProviders(context);
	registerCommands(context);

	// Check whether we have any directories to scan, show a message to the user if not
	const qchDirectories = getQCHDirectories();
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
				await initializeLookupMaps();
			} catch (error) {
				vscode.window.showErrorMessage(`Indexer failed with error: ${error}`);
			}
		})();
	}
}

// This method is called when your extension is deactivated
export function deactivate() {
	console.log("QCH extension deactivating");

	symbolMap.clear();
	fileMap.clear();
}
