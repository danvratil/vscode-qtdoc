import * as assert from 'assert';
import initSqlJs from 'sql.js';
import { exportedForTests, SymbolId, SymbolData, FileId } from '../indexer';
import path from 'path';
const string_hash = require('string-hash-64');

suite("Indexer", async () => {
    test("index", async () => {
        const sqlite = await initSqlJs();
        const indexQCHFile = exportedForTests.indexQCHFile;

        const symbolMap = new Map<SymbolId, SymbolData>();
        const fileMap = new Map<FileId, string>();

        await assert.doesNotReject(indexQCHFile(sqlite, path.join(__dirname, "../../src/test/data/test.qch"), symbolMap, fileMap));

        assert.strictEqual(symbolMap.size, 4);
        assert.strictEqual(fileMap.size, 1);

        const setTestPropertyKey = string_hash("TestClass::setTestProperty");
        assert.ok(symbolMap.has(setTestPropertyKey));
        const setTestProperty = symbolMap.get(setTestPropertyKey)!;
        assert.ok(setTestProperty.anchor.offset > 0);
        assert.ok(setTestProperty.anchor.len > 0);

        const testPropertyKey = string_hash("TestClass::testProperty");
        assert.ok(symbolMap.has(testPropertyKey));
        const testProperty = symbolMap.get(testPropertyKey)!;
        assert.strictEqual(testProperty.anchor.name, "testProperty-prop");
        assert.ok(testProperty.anchor.offset > 0);
        assert.ok(testProperty.anchor.len > 0);

        const testPropertyChangedKey = string_hash("TestClass::testPropertyChanged");
        assert.ok(symbolMap.has(testPropertyChangedKey));
        const testPropertyChanged = symbolMap.get(testPropertyChangedKey)!;
        assert.strictEqual(testPropertyChanged.anchor.name, "testPropertyChanged");
        assert.ok(testPropertyChanged.anchor.offset > 0);
        assert.ok(testPropertyChanged.anchor.len > 0);

        const testSignalKey = string_hash("TestClass::testSignal");
        assert.ok(symbolMap.has(testSignalKey));
        const testSignal = symbolMap.get(testSignalKey)!;
        assert.strictEqual(testSignal.anchor.name, "testSignal")!;
        assert.ok(testSignal.anchor.offset > 0);
        assert.ok(testSignal.anchor.len > 0);

        // Check that the file ID exists in the fileMap - no need to check the other keys, they are
        // all from the same file.
        assert.ok(fileMap.has(setTestProperty.fileId));
        assert.ok(fileMap.has(testProperty.fileId));
        assert.ok(fileMap.has(testPropertyChanged.fileId));
        assert.ok(fileMap.has(testSignal.fileId));
    });
});