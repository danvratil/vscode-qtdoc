// SPDX-FileCopyrightText: 2024 Daniel Vrátil <me@dvratil.cz>
//
// SPDX-License-Identifier: MIT

import * as vscode from 'vscode';
import fs from 'fs/promises';
import { FileId, SymbolData, SymbolId, generateSymbolId } from './indexer';
import { readFilePart } from './utils';
import { NodeHtmlMarkdown } from 'node-html-markdown';

type SymbolMap = Map<SymbolId, SymbolData>;
type FileMap = Map<FileId, string>;

type Symbol = {
	name: string,
	type: vscode.SymbolKind,

};
class DocumentationMissing extends Error {
    constructor(public symbol: string) {
        super(`No documentation found for symbol ${symbol}`);
    }
}

async function getDefinitionsOfSymbolUnderHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Location> {
    const definitionLocations = await vscode.commands.executeCommand<vscode.Definition | vscode.LocationLink[]>("vscode.executeDefinitionProvider", document.uri, position);
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }

    if (!definitionLocations) {
        throw new DocumentationMissing("Couldn't find definition for the symbol under the cursor.");
    }
    if (Array.isArray(definitionLocations)) {
        if (definitionLocations.length === 0) {
            throw new DocumentationMissing("Couldn't find definition for the symbol under the cursor.");
        }
        // Take the last definition, as those tend to be the correct ones if the provider somehow discovers
        // a same-name definition in the current project.
        return definitionLocations[definitionLocations.length - 1] as vscode.Location;
    }

    return definitionLocations;
}

function resolveFullSymbolName(symbols: vscode.DocumentSymbol[], symbol: string, token: vscode.CancellationToken): Symbol | undefined
{
	for (const s of symbols) {
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }

		if (s.name === symbol) {
			return { name: s.name, type: s.kind };
		}

		const subSymbol = resolveFullSymbolName(s.children, symbol, token);
		if (subSymbol) {
			return { name: s.name + "::" + subSymbol.name, type: subSymbol.type };
		}
	}

	return undefined;
}

async function getSymbolUnderHover(definitionLoc: vscode.Location, token: vscode.CancellationToken): Promise<Symbol> {
    // Open the document where the definition is located and check whether
    // the position of the definition that we have is valid within the document.
    const doc = await vscode.workspace.openTextDocument(definitionLoc.uri);
    if (!doc.validateRange(definitionLoc.range)) {
        throw new Error("Location of the definition within the document is not valid.");
    }
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }

    // Get text of the definition
    const symbolName = doc.getText(definitionLoc.range);

    // Get all symbols in the document, as a tree  (e..g namespace->class->method).
    // This can be fairly slow as it means that the document must be fully parsed by the LS.
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", doc.uri);
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }

    // Make use of the fact that we have a full symbol tree to resolve a fully
    // qualified name of the symbol.
    const symbol = resolveFullSymbolName(symbols, symbolName, token);
    if (!symbol) {
        throw new DocumentationMissing(symbolName);
    }
    return symbol;
}

async function loadDocumentationForSymbol(file: string, symbolData: SymbolData, token: vscode.CancellationToken): Promise<vscode.MarkdownString> {
    const html = await readFilePart(file, symbolData.anchor.offset, symbolData.anchor.offset + symbolData.anchor.len);
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }

    const md = NodeHtmlMarkdown.translate(html);
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }

    // Replace relative links with absolute link to online documentation
    // FIXME: Ideally we would do this in the NodeHtmlMarkdown with a custom translator
    return new vscode.MarkdownString(md.replace(/([a-zA-Z0-9\-_]+\.html)/g, 'https://doc.qt.io/qt-6/$1'));
}


export class HoverProvider implements vscode.HoverProvider {
    private symbolMap: SymbolMap;
    private fileMap: FileMap;

    constructor(symbolMap: SymbolMap, fileMap: FileMap) {
        this.symbolMap = symbolMap;
        this.fileMap = fileMap;
    }

    async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
        try {
            // Get location where the symbol under the hover is defined
            const definitionLoc = await getDefinitionsOfSymbolUnderHover(document, position, token);
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const symbol = await getSymbolUnderHover(definitionLoc, token);
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            const symbolId = generateSymbolId(symbol.name);
            const symbolData = this.symbolMap.get(symbolId);
            if (!symbolData) {
                throw new DocumentationMissing(symbol.name);
            }

            const file = this.fileMap.get(symbolData.fileId);
            if (!file) {
                throw new Error("Cache inconsistency: file not found in the file map.");
            }

            const documentation = await loadDocumentationForSymbol(file, symbolData, token);
            if (token.isCancellationRequested) {
                throw new vscode.CancellationError();
            }

            return new vscode.Hover(documentation);
        } catch (e) {
            if (e instanceof vscode.CancellationError) {
                // Handle cancelation silently
            } else if (e instanceof Error) {
                console.error(`Error while providing hover: ${e.message}`);
            } else if (e instanceof DocumentationMissing) {
                console.debug(e.message);
            }

            return undefined;
        }
    }
}