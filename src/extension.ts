// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { parse } from 'node-html-parser';
import { NodeHtmlMarkdown, NodeHtmlMarkdownOptions } from 'node-html-markdown';

const initSqlJs = require('sql.js');

function resolveFQSymbol(symbols: vscode.DocumentSymbol[], symbol: string): string | undefined
{
	for (const s of symbols) {
		if (s.name === symbol) {
			return s.name;
		}

		const subSymbol = resolveFQSymbol(s.children, symbol);
		if (subSymbol) {
			return s.name + "::" + subSymbol;
		}
	}

	return undefined;
}

type Result = {
	path: string;
	anchor: string;
};

async function resolveSymbolDocs(symbol: string): Promise<Result | undefined>
{
	let now = performance.now();
	console.log("Loading SQLite wasm");
	const sqlite = await (async () => {
		try {
			return await initSqlJs();
		} catch (e) {
			console.error("Failed to load SQLite wasm: " + e);
			throw e;
		}
	})();
	console.log(`SQlite wasm loaded in ${performance.now() - now} ms`);

	now = performance.now();
	const data = await vscode.workspace.fs.readFile(vscode.Uri.file('/usr/share/doc/qt6/qtcore.qch'));
	console.log(`QCH file loaded in ${performance.now() - now} ms`);
	const db = new sqlite.Database(data);
	console.log("DB initialized");

	now = performance.now();
	let stmt = db.prepare("SELECT FolderTable.Name, FileNameTable.Name, IndexTable.Anchor " +
						  "FROM IndexTable " +
						  "LEFT JOIN FileNameTable ON (FileNameTable.FileId = IndexTable.FileId) " +
						  "LEFT JOIN FolderTable ON (FileNameTable.FolderId = FolderTable.Id) " +
						  "WHERE IndexTable.Identifier = :identifier");
	stmt.bind([symbol]);
	if (!stmt.step()) {
		return undefined;
	}

	const row = stmt.get();
	stmt.free();

	db.close();

	console.log(`Query finished in ${performance.now() - now} ms`);
	return { path: `${row[0]}/${row[1]}`, anchor: row[2] };
}


export function activate(context: vscode.ExtensionContext) {
	console.log("QCH extension activating");

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
			const result = await resolveSymbolDocs(fqSymbol);
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
