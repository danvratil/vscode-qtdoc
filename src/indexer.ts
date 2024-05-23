// SPDX-FileCopyrightText: 2024 Daniel Vrátil <me@dvratil.cz>
//
// SPDX-License-Identifier: MIT

import * as path from 'path';
import fs from 'fs/promises';
import initSqlJs from 'sql.js';
import { parse as parse_html, HTMLElement } from 'node-html-parser';
import { qUncompress, sha256, getCacheDirectory } from './utils';

const string_hash = require('string-hash-64');


/* Index format:
 *
 * qch_file_map.json
 *
 * This file holds a list of indexed QCH files. For each file it holds its mtime and size,
 * so that we can easily detect whether the file has changed and trigger reindexing.
 *
 * file_map.json
 *
 * A simple map of File ID (a numerical ID) to absolute file path, purely for the purposes
 * of saving memory.
 *
 * symbol_map.json
 *
 * A database of all symbols extracted from all indexed QCH files. The key is a hash of the symbol
 * name (stored as a number) and the value contains ID of file where the documentation is stored and
 * anchor into the HTML file from which to extract the documentation.
 *
 * There's a "docs" directory in the cache directory where the actual documentation HTML files are
 * stored.
 */



export type SymbolId = number;
export type FileId = number;

type Anchor = {
    offset: number;
    len: number;
};

export type SymbolData = {
    fileId: FileId;
    anchor: Anchor;
};

type QCHFileInfo = {
    mtime: number;
    size: number;
};

async function discoverQCHFiles(scanDirs: string[]): Promise<Set<string>>
{
    let existingFiles = new Set<string>();
    for (const scanDir of scanDirs) {
        const entries = await fs.readdir(scanDir, { withFileTypes: true }).catch((e: Error) => {
            console.warn("Failed to scan directory: ", scanDir, e.message);
            return [];
        });
        for (const entry of entries) {
            // Explicitly ignore any QCH files that are not from Qt documentation itself.
            // For instance, KDE Frameworks provide QCH documentation as well, but it's from Doxygen,
            // so the HTML format is different and also we don't actually need to extract docs from
            // it, because KDE Frameworks have docs in their header files, so they get extracted
            // by the C++ parser.
            if (entry.isFile() && entry.name.startsWith("qt") && entry.name.endsWith('.qch')) {
                existingFiles.add(path.join(scanDir, entry.name));
            }
        }
    }

    return existingFiles;
}

async function getCachedQCHFiles(): Promise<[string, QCHFileInfo][]>
{
    const cacheDir = getCacheDirectory();
    const qchCacheFile = path.join(cacheDir, 'qch_file_map.json');
    // check whether the file exists
    if (!await fs.stat(qchCacheFile).catch((e: Error) => { return false; })) {
        return [];
    }
    const filemap_data = await fs.readFile(qchCacheFile).catch((e: Error) => {
        console.warn("Failed to read cached QCH file map: ", e.toString());
        throw e;
    });
    return JSON.parse(filemap_data.toString());
}

async function getQCHFileInfo(file: string): Promise<QCHFileInfo>
{
    const stat = await fs.stat(file);
    return {
        mtime: stat.mtime.getTime() / 1000,
        size: stat.size
    };
}

async function isCachedFileValid(file: string, info: QCHFileInfo): Promise<boolean>
{
    const stat = await fs.stat(file);
    return stat.mtime === new Date(info.mtime * 1000) || stat.size === info.size;
}

async function extractFileDataFromQCH(db: initSqlJs.Database, qchFileName: string, qchFileId: number, fileName: string): Promise<Uint8Array>
{
    const result = db.exec("SELECT Data FROM FileDataTable WHERE Id = :fileId", { ':fileId': qchFileId });
    if (result.length === 0 || result[0].values.length === 0) {
        throw new Error(`Couldn't find data for fileId ${qchFileId} (${fileName}) in ${qchFileName}`);
    }
    const data = result[0].values[0][0] as Uint8Array | undefined;
    if (!data) {
        throw new Error(`No data for fileId ${qchFileId} (${fileName}) in ${qchFileName}`);
    }

    const buffer = await qUncompress(data);
    if (!buffer) {
        throw new Error(`Failed to decompress file data for fileId ${qchFileId} (${fileName}) in ${qchFileName}`);
    }

    return buffer;
}

async function cacheExtractedFile(buffer: Uint8Array, qchFileName: string, fileName: string): Promise<string>
{
    const targetDir = path.join(getCacheDirectory(), await sha256(qchFileName));
    await fs.mkdir(targetDir, { recursive: true });

    const targetFile = path.join(targetDir, fileName);
    await fs.writeFile(targetFile, buffer);

    return targetFile;
}

function parseHtmlFile(buffer: Uint8Array): HTMLElement
{
    return parse_html(new TextDecoder().decode(buffer));
}

function generateFileId(filePath: string): FileId
{
    return string_hash(filePath);
}

export function generateSymbolId(symbol: string): SymbolId
{
    return string_hash(symbol);
}

const escapeAnchor = (anchor: string) => anchor.replace(/\./g, '\\.');

async function extractAnchor(document: HTMLElement, anchor: string | undefined): Promise<Anchor>
{
    if (anchor) {
        const doc_header_elem = document.querySelector(`h3#${escapeAnchor(anchor)}`);
        if (!doc_header_elem) {
            throw new Error(`Failed to find anchor ${anchor}`);
        }

        let doc_node = doc_header_elem.nextElementSibling;
        // Start offset is offset of the first element after the heading.
        // We don't want to include the header in the documentation, since it contains the
        // function definition, which is already displayed in the hover from the C++ intellisense.
        const start = doc_node?.range[0] || 0;
        let end = doc_node?.range[1] || 0;
        while (doc_node && doc_node.tagName !== 'H3') {
            end = doc_node?.range[1] || 0;
            doc_node = doc_node.nextElementSibling;
        }

        return {
            offset: start,
            len: Math.max(0, end - doc_header_elem.range[0])
        };
    } else {
        const descr_elem = document.querySelector("div.descr");
        if (!descr_elem) {
            throw new Error(`Failed to find class documentation.`);
        }

        return {
            offset: descr_elem.range[0],
            len: descr_elem.range[1] - descr_elem.range[0]
        };
    }
}

async function indexQCHFile(sqlite: initSqlJs.SqlJsStatic, qchFileName: string, symbolMap: Map<SymbolId, SymbolData>, fileMap: Map<FileId, string>)
{
    console.log("Indexing QCH file: ", qchFileName);

    const data = await fs.readFile(qchFileName).catch((e: Error) => {
        console.error("Failed to read QCH file: ", qchFileName, e.message);
        throw e;
    });
    const db = new sqlite.Database(data);

    // List all symbols, their Anchors and also the files their documentation is stored in.
    // As an optimization, the results are sorted by FileID, so that we can extract and parse the file once
    // and reuse it for all symbols in the same file.
    const result = db.exec("SELECT IndexTable.Identifier AS Identifier, IndexTable.Anchor as Anchor, " +
                           "       IndexTable.FileId AS FileId, FileNameTable.Name AS FileName, " +
                           "       FileNameTable.Title AS FileTitle " +
                           "FROM IndexTable " +
                           "LEFT JOIN FileNameTable ON (FileNameTable.FileId = IndexTable.FileId) " +
                           "ORDER BY FileId ASC");
    if (result.length === 0) {
        console.log(`No symbols found in ${qchFileName}`);
        return;
    }
    let lastQCHFileId = -1;
    let lastParsedHtmlFile: HTMLElement | undefined = undefined;
    let fileId = -1;
    for (const row of result[0].values) {
        const identifier = row[0] as string | undefined;
        const anchor = row[1] as string | undefined;
        const qchFileId = row[2] as number | undefined;
        const fileName = row[3] as string | undefined;
        const fileTitle = row[4] as string | undefined;
        if (!identifier || qchFileId  === undefined || !fileName || !fileTitle) {
            continue;
        }


        // Match "QString Class | Qt Core 6.7.0"
        if (!fileTitle.match(/^([a-zA-Z0-9_]+) Class \| Qt(.*)/)) {
            continue;
        }

        // We don't support QML (yet), so skip symbols whose documentation is in files prefixed with qml-
        if (fileName.startsWith("qml-")) {
            continue;
        }

        if (lastQCHFileId !== qchFileId) {
            const fileData = await extractFileDataFromQCH(db, qchFileName, qchFileId, fileName);
            const filePath = await cacheExtractedFile(fileData, qchFileName, fileName);
            lastParsedHtmlFile = parseHtmlFile(fileData);
            fileId = generateFileId(filePath);
            fileMap.set(fileId, filePath);
            lastQCHFileId = qchFileId;
        }

        await extractAnchor(lastParsedHtmlFile!, anchor).then((anchor: Anchor) => {
            symbolMap.set(generateSymbolId(identifier), {
                fileId: fileId,
                anchor: anchor
            });
        }).catch((e: Error) => {
            console.log(`Skipping symbol ${identifier} in file ${fileName} due to error: `, e.message);
        });
    }
}

async function writeMapFile<K, V>(map: Map<K,V>, filePath: string)
{
    const replacer = (key: string, value: Map<K, V>) => {
        if(value instanceof Map) {
            return [...value];
        } else {
            return value;
        }
    };

    const data = JSON.stringify(map, replacer);
    await fs.writeFile(filePath, data);
}

async function clearCacheDirectory()
{
    const cacheDir = getCacheDirectory();
    await fs.rmdir(cacheDir, { recursive: true }).catch((e: Error) => {
        console.warn("Failed to clear cache directory: ", cacheDir, e.message);
    });
}

export class Indexer
{
    public onProgress: ((done: number, total: number) => void) | undefined;

    public async checkIndex(qchDirectories: string[]): Promise<boolean>
    {
        const existingQCHFiles = await discoverQCHFiles(qchDirectories);
        console.log("Discovered QCH files: ", existingQCHFiles.size);

        const cachedQCHFiles = await getCachedQCHFiles();
        console.log("Cached QCH files: ", cachedQCHFiles.length);

        let needsReindexing = false;
        let processedFiles = 0;

        // Calculate union of cached and existing QCH files to get total number of files to process
        const total = cachedQCHFiles.filter(file => !existingQCHFiles.has(file[0])).length + existingQCHFiles.size;

        for (let cachedFile = cachedQCHFiles.pop(); cachedFile; cachedFile = cachedQCHFiles.pop()) {
            const path = cachedFile[0];
            const info = cachedFile[1];
            if (existingQCHFiles.has(cachedFile[0])) {
                if (!await isCachedFileValid(path, info)) {
                    console.log(`QCH file ${path} has changed!`);
                    needsReindexing = true;
                    break;
                }

                existingQCHFiles.delete(path);
            } else {
                console.log(`QCH file ${path} removed`);
            }

            this.emitProgress(total, processedFiles++);
        }

        // Are there any unindexed QCH files?
        if (existingQCHFiles.size > 0) {
            for (const file of existingQCHFiles) {
                console.log(`New QCH file found: ${file}`);
                needsReindexing = true;
                break;
            }
        }

        return needsReindexing;
    }

    public async index(qchDirectories: string[]): Promise<void>
    {
        const sqlite = await initSqlJs();

        const symbolMap = new Map<SymbolId, SymbolData>();
        const fileMap = new Map<FileId, string>();
        const indexedQCHFiles = new Map<string, QCHFileInfo>();

        await clearCacheDirectory();

        const qchFiles = await discoverQCHFiles(qchDirectories);
        let index = 0;
        for (const [file] of qchFiles.entries()) {
            await indexQCHFile(sqlite, file, symbolMap, fileMap);
            indexedQCHFiles.set(file, await getQCHFileInfo(file));
            this.emitProgress(qchFiles.size, index + 1);
            index++;
        }

        await writeMapFile(symbolMap, path.join(getCacheDirectory(), 'symbol_map.json'));
        await writeMapFile(fileMap, path.join(getCacheDirectory(), 'file_map.json'));
        await writeMapFile(indexedQCHFiles, path.join(getCacheDirectory(), 'qch_file_map.json'));

    }

    private emitProgress(total: number, done: number)
    {
        if (this.onProgress) {
            this.onProgress(Math.min(done, total), total);
        }
    }
};

export const exportedForTests = {
    indexQCHFile: indexQCHFile
};