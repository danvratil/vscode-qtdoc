import { parentPort } from 'worker_threads';
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js';
import { inflate } from 'zlib';
import { parse as parse_html } from 'node-html-parser';
import { Sha256 } from '@aws-crypto/sha256-js';
import { promisify } from 'util';

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

type SymbolId = number;
type FileId = number;

type Anchor = {
    name: string;
    offset: number;
    len: number;
};

type SymbolData = {
    fileId: FileId;
    anchor: Anchor;
};

type QCHFileData = {
    path: string;
    mtime: number;
    size: number;
};

type QCHFileMap = QCHFileData[];

async function checkIndex()
{
    // TODO: Obtain from caller
    const scanDirs = ["/usr/share/doc/qt6"];
    let existingFiles = new Set<string>();
    for (const scanDir of scanDirs) {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(scanDir));
        for (const [name, type] of entries) {
            if (type === vscode.FileType.File && name.endsWith('.qch')) {
                existingFiles.add(path.join(scanDir, name));
            }
        }
    }

    const cache_dir = getCacheDirectory();
    try {
        const filemap_data = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(cache_dir, 'qch_file_map.json')));
        const filemap: QCHFileMap = JSON.parse(filemap_data.toString());
        for (const file of filemap) {
            try {
                const stat = await vscode.workspace.fs.stat(vscode.Uri.file(file.path));
                if (stat.mtime !== file.mtime || stat.size !== file.size) {
                    reindex();
                    return;
                }
            } catch (e) {
                // File disappeared -> reindex it
                reindex();
                return;
            }

            existingFiles.delete(file.path);
        }

        // Are there any unindexed QCH files?
        if (existingFiles.size > 0) {
            reindex();
            return;
        }
    } catch (e) {
        reindex();
        return;
    }
}

async function sha256(data: string): Promise<string>
{
    const sha256 = new Sha256();
    sha256.update(data);
    const digest = await sha256.digest();
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map(b => ('00' + b.toString(16)).slice(-2)).join('');
}

function ntohl(data: Uint8Array): number
{
    return ((0xff & data[0]) << 24) |
        ((0xff & data[1]) << 16) |
        ((0xff & data[2]) << 8) |
        ((0xff & data[3]));
}

/**
 * Our own implementation of the qUncompress function from Qt.
 *
 * qCompress() uses zlib to deflate the data, but it also adds a 4-byte big-endian
 * header containing the size of the original (uncompressed) data.
 *
 * @param data Compressed data produced by qCompress() function from Qt
 * @returns Decompressed data
 */
async function qUncompress(data: Uint8Array): Promise<Uint8Array | undefined>
{
    const expected_size = ntohl(data.slice(0, 4));
    const zlib_data = data.slice(4);

    const do_inflate = promisify(inflate);
    const buffer = await do_inflate(zlib_data);
    if (buffer.byteLength !== expected_size) {
        throw new Error(`Decompressed data size (${buffer.byteLength}) does not match the expected size (${expected_size})`);
    }

    return new Uint8Array(buffer);
}

async function extractFile(db: initSqlJs.Database, qchFileName: string, qchFileId: number, fileName: string): Promise<string>
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

    const targetDir = path.join(getCacheDirectory(), await sha256(qchFileName));
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir));

    const targetFile = path.join(targetDir, fileName);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(targetFile), buffer);

    return targetFile;
}

function generateFileId(filePath: string): FileId
{
    return string_hash(filePath);
}

function generateSymbolId(symbol: string): SymbolId
{
    return string_hash(symbol);
}

async function extractAnchor(filePath: string, anchor: string): Promise<Anchor>
{
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    const root = (() => {
        try {
            return parse_html(data.toString());
        } catch (e) {
            console.error("Failed to parse HTML doc");
            return undefined;
        }
    })();

    console.log("Parsed HTML file");

    if (!root) {
        throw new Error("Failed to parse HTML doc");
    }

    const doc_header_elem = root.querySelector(`h3#${anchor}`);
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
    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(qchFileName));
    const db = new sqlite.Database(data);

    let reverseFileMap = new Map<string, FileId>();

    // List all symbols, their Anchors and also their FileIds
    const result = db.exec("SELECT IndexTable.Identifier AS Identifier, IndexTable.Anchor as Anchor, IndexTable.FileId AS FileId, FileNameTable.Name AS FileName " +
                           "FROM IndexTable " +
                           "LEFT JOIN FileNameTable ON (FileNameTable.FileId = IndexTable.FileId)");
    for (const row of result[0].values) {
        const identifier = row[0] as string | undefined;
        const anchor = row[1] as string | undefined;
        const qchFileId = row[2] as number | undefined;
        const fileName = row[3] as string | undefined;
        if (!identifier || qchFileId  === undefined || !fileName || !anchor) {
            continue;
        }

        let fileId = reverseFileMap.get(fileName);
        if (!fileId) {
            const extractedFilePath = await extractFile(db, qchFileName, qchFileId, fileName);
            fileId = generateFileId(extractedFilePath);
            reverseFileMap.set(fileName, fileId);
            fileMap.set(fileId, extractedFilePath);
        }

        symbolMap.set(generateSymbolId(identifier), {
            fileId: fileId,
            anchor: await extractAnchor(fileMap.get(fileId)!, anchor)
        });
    }
}

async function reindex()
{
    const sqlite = await initSqlJs();

    // Find all files to index
    const scanDirs = ["/usr/share/doc/qt6"];
    let qchFileMap: QCHFileData[] = [];
    let symbolMap = new Map<SymbolId, SymbolData>();
    let fileMap = new Map<FileId, string>();

    for (const scanDir of scanDirs) {
        const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(scanDir));
        for (const [name, type] of entries) {
            const file_path = path.join(scanDir, name);
            if (type === vscode.FileType.File && name.endsWith('.qch')) {
                const stat = await vscode.workspace.fs.stat(vscode.Uri.file(file_path));
                qchFileMap.push({ path: file_path, mtime: stat.mtime, size: stat.size });
            }

            indexQCHFile(sqlite, file_path, symbolMap, fileMap);
        }
    }

}

type Message = {
    command: 'checkIndex' | 'reindex';
};

if (parentPort) { // not available when running tests
    parentPort!.addListener('message', async (message: Message) => {
        if (message.command === 'checkIndex') {
            checkIndex();
        } else if (message.command === 'reindex') {
            reindex();
        }
    });
}

export const exportedForTesting = {
    extractFile,
    extractAnchor,
    ntohl,
    qUncompress,
};