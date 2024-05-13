import * as os from 'os';
import * as path from 'path';
import fs from 'fs/promises';
import initSqlJs from 'sql.js';
import { parse as parse_html, HTMLElement } from 'node-html-parser';
import { qUncompress, sha256 } from './utils';

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


function getCacheDirectory(): string
{
    const baseDir = (() => {
        switch (process.platform) {
            case 'linux':
                return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
            case 'win32':
                return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
            case 'darwin':
                return path.join(os.homedir(), 'Library', 'Caches');
            default:
                throw new Error("Unsupported platform");
        }
    })();

    return path.join(baseDir, 'vscode', 'cz.dvratil.vscode-qch');
}

export type SymbolId = number;
export type FileId = number;

type Anchor = {
    name: string;
    offset: number;
    len: number;
};

export type SymbolData = {
    fileId: FileId;
    anchor: Anchor;
};

type QCHFileData = {
    path: string;
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
            if (entry.isFile() && entry.name.endsWith('.qch')) {
                existingFiles.add(path.join(scanDir, entry.name));
            }
        }
    }

    return existingFiles;
}

async function getCachedQCHFiles(): Promise<QCHFileData[]>
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
    return JSON.parse(filemap_data.toString()) as QCHFileData[];
}

async function isCachedFileValid(file: QCHFileData): Promise<boolean>
{
    const stat = await fs.stat(file.path);
    return stat.mtime === new Date(file.mtime * 1000) || stat.size === file.size;
}

async function extractFileDataFromQCH(db: initSqlJs.Database, qchFileName: string, qchFileId: number, fileName: string): Promise<Uint8Array>
{
    const result = db.exec("SELECT Data FROM FileDataTable WHERE FileId = :fileId", { ':fileId': qchFileId });
    const data = result[0].values[0][0] as Uint8Array | undefined;
    if (!data) {
        throw new Error("Failed to extract file data");
    }

    const buffer = await qUncompress(data);
    if (!buffer) {
        throw new Error("Failed to decompress file data");
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

function generateSymbolId(symbol: string): SymbolId
{
    return string_hash(symbol);
}

async function extractAnchor(document: HTMLElement, anchor: string): Promise<Anchor>
{
    const doc_header_elem = document.querySelector(`h3#${anchor}`);
    if (!doc_header_elem) {
        throw new Error("Failed to find anchor in HTML doc");
    }

    let doc_node = doc_header_elem.nextElementSibling;
    let end = doc_node?.range[1] || 0;
    while (doc_node && doc_node.tagName !== 'H3') {
        doc_node = doc_node.nextElementSibling;
        end = doc_node?.range[1] || 0;
    }

    return {
        name: anchor,
        offset: doc_header_elem.range[0],
        len: Math.max(0, end - doc_header_elem.range[0])
    };
}

async function indexQCHFile(sqlite: initSqlJs.SqlJsStatic, qchFileName: string, symbolMap: Map<SymbolId, SymbolData>, fileMap: Map<FileId, string>)
{
    console.log("Indexing QCH file: ", qchFileName);

    const data = await fs.readFile(qchFileName);
    const db = new sqlite.Database(data);

    // List all symbols, their Anchors and also the files their documentation is stored in.
    // As an optimization, the results are sorted by FileID, so that we can extract and parse the file once
    // and reuse it for all symbols in the same file.
    const result = db.exec("SELECT IndexTable.Identifier AS Identifier, IndexTable.Anchor as Anchor, " +
                           "       IndexTable.FileId AS FileId, FileNameTable.Name AS FileName " +
                           "FROM IndexTable " +
                           "LEFT JOIN FileNameTable ON (FileNameTable.FileId = IndexTable.FileId) " +
                           "ORDER BY IndexTable.FileId ASC");
    let lastQCHFileId = -1;
    let lastParsedHtmlFile: HTMLElement | undefined = undefined;
    let fileId = -1;
    for (const row of result[0].values) {
        const identifier = row[0] as string | undefined;
        const anchor = row[1] as string | undefined;
        const qchFileId = row[2] as number | undefined;
        const fileName = row[3] as string | undefined;
        if (!identifier || qchFileId  === undefined || !fileName || !anchor) {
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

        symbolMap.set(generateSymbolId(identifier), {
            fileId: fileId,
            anchor: await extractAnchor(lastParsedHtmlFile!, anchor)
        });
    }
}

type IndexCheckResult = {
    filesToReindex: string[];
};

export class Indexer
{
    public onProgress: ((done: number, total: number) => void) | undefined;

    public async checkIndex(qchDirectories: string[]): Promise<IndexCheckResult>
    {
        const existingQCHFiles = await discoverQCHFiles(qchDirectories);
        console.log("Discovered QCH files: ", existingQCHFiles.size);

        const cachedQCHFiles = await getCachedQCHFiles();
        console.log("Cached QCH files: ", cachedQCHFiles.length);

        let filesToReindex: string[] = [];
        let processedFiles = 0;

        // Calculate union of cached and existing QCH files to get total number of files to process
        const total = cachedQCHFiles.filter(file => !existingQCHFiles.has(file.path)).length + existingQCHFiles.size;

        for (let cachedFile = cachedQCHFiles.pop(); cachedFile; cachedFile = cachedQCHFiles.pop()) {
            if (existingQCHFiles.has(cachedFile.path)) {
                if (!await isCachedFileValid(cachedFile)) {
                    console.log(`QCH file ${cachedFile.path} has changed!`);
                    filesToReindex.push(cachedFile.path);
                }

                existingQCHFiles.delete(cachedFile.path);
            } else {
                console.log(`QCH file ${cachedFile.path} removed`);
            }

            this.emitProgress(total, processedFiles++);
        }

        // Are there any unindexed QCH files?
        if (existingQCHFiles.size > 0) {
            for (const file of existingQCHFiles) {
                console.log(`New QCH file found: ${file}`);
                filesToReindex.push(file);
                this.emitProgress(total, processedFiles++);
            }
        }

        return { filesToReindex: filesToReindex };
    }

    public async index(qchFiles: string[]): Promise<void>
    {
        const sqlite = await initSqlJs();

        const symbolMap = new Map<SymbolId, SymbolData>();
        const fileMap = new Map<FileId, string>();

        for (const file of qchFiles) {
            await indexQCHFile(sqlite, file, symbolMap, fileMap);
        }

        //await writeSymbolMap(symbolMap);
        //await writeFileMap(fileMap);
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