import * as assert from 'assert';
import * as indexer from '../indexer';

suite('Indexer', async () => {
    test("ntohl", () => {
        const ntohl = indexer.exportedForTesting.ntohl;
        assert.strictEqual(ntohl(new Uint8Array([0x0D, 0x0C, 0x0B, 0x0A])), 0x0D0C0B0A);
        assert.strictEqual(ntohl(new Uint8Array([0x00, 0x00, 0x01, 0x00])), 0x100);
        assert.strictEqual(ntohl(new Uint8Array([0x00, 0x01, 0x00, 0x00])), 0x10000);

    });

    const qUncompress = indexer.exportedForTesting.qUncompress;
    test("qUncompress - success", async () => {
        // "Hello World!" string compressed using qCompress()
        const compressed = new Uint8Array([
            0x00, 0x00, 0x00, 0x0c,
            0x78, 0x9c, 0xf3, 0x48,
            0xcd, 0xc9, 0xc9, 0x57,
            0x08, 0xcf, 0x2f, 0xca,
            0x49, 0x51, 0x04, 0x00,
            0x1c, 0x49, 0x04, 0x3e
        ]);

        const decompressed = await qUncompress(compressed);
        assert.strictEqual(new TextDecoder().decode(decompressed), "Hello World!");
    });

    test("qUncompress - invalid data", async () => {
        // "Hello World!" string compressed using qCompress(), but the value in the header is too short
        const compressed = new Uint8Array([
            0x00, 0x00, 0x00, 0x01,
            0x78, 0x9c, 0xf3, 0x48,
            0xcd, 0xc9, 0xc9, 0x57,
            0x08, 0xcf, 0x2f, 0xca,
            0x49, 0x51, 0x04, 0x00,
            0x1c, 0x49, 0x04, 0x3e
        ]);

        assert.rejects(() => qUncompress(compressed));
    });
});