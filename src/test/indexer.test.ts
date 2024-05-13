import * as assert from 'assert';
import initSqlJs from 'sql.js';
import { exportedForTests, SymbolId, SymbolData, FileId } from '../indexer';
import path from 'path';

suite("Indexer", async () => {
    test("index", async () => {
        const sqlite = await initSqlJs();
        const indexQCHFile = exportedForTests.indexQCHFile;

        const symbolMap = new Map<SymbolId, SymbolData>();
        const fileMap = new Map<FileId, string>();

        assert.doesNotReject(indexQCHFile(sqlite, path.join(__dirname, "data/test.qch"), symbolMap, fileMap));

        console.log(symbolMap);
        console.log(fileMap);
    });
});