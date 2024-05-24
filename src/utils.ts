// SPDX-FileCopyrightText: 2024 Daniel Vrátil <me@dvratil.cz>
//
// SPDX-License-Identifier: MIT

import { promisify } from "util";
import { inflate } from "zlib";
import { Sha256 } from "@aws-crypto/sha256-js";
import os from 'os';
import path from "path";
import fs from 'fs/promises';

const hostEndianness = (() => {
    const u16 = Uint16Array.of(1);
    const u8 = new Uint8Array(u16.buffer);
    return u8[0] ? 'LE' : 'BE';
})();

/**
 * Convert a 4-byte big-endian number to a host-endian number.
 *
 * @param data Uint8Array with 4 bytes of data to convert to a host-endian number
 * @returns
 */
export function ntohl(data: Uint8Array): number
{
    if (hostEndianness === 'BE') {
        // BE->BE, this is much faster t han new Uint32Array(data.buffer)[0]
        return ((0xff & data[3]) << 24) |
            ((0xff & data[2]) << 16) |
            ((0xff & data[1]) << 8) |
            ((0xff & data[0]));
    } else {
        // BE->LE
        return ((0xff & data[0]) << 24) |
            ((0xff & data[1]) << 16) |
            ((0xff & data[2]) << 8) |
            ((0xff & data[3]));
    }
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
export async function qUncompress(data: Uint8Array): Promise<Uint8Array | undefined>
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

/**
 * Calculate SHA-256 hash of the given string.
 *
 * crypto.subtle is not available in the extension host, so we use a JS implementation.
 *
 * @param data string to calculate SHA-256 hash for.
 * @returns Returns SHA-256 digest of the given string as a hex string.
 */
export async function sha256(data: string): Promise<string>
{
    const sha256 = new Sha256();
    sha256.update(data);
    const digest = await sha256.digest();
    const hashArray = Array.from(new Uint8Array(digest));
    return hashArray.map(b => ('00' + b.toString(16)).slice(-2)).join('');
}

/**
 * @returns Returns platform-specific path to the cache directory for this extension.
 */
export function getCacheDirectory(): string
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

    return path.join(baseDir, 'vscode-qtdoc');
}

/**
 * Reads a data from a file and returns it as a string.
 *
 * @param file Name of the file to read from
 * @param startOffset Offset to start reading from (or undefined to read from the beginning)
 * @param endOffset End offset to read to (or undefined to read until the end)
 * @returns Contents of the file within the given range as a string.
 */
export async function readFilePart(file: string, startOffset: number | undefined = undefined, endOffset: number | undefined = undefined): Promise<string>
{
    const fd = await fs.open(file, 'r');
    const stream = fd.createReadStream({
        autoClose: true,
        start: startOffset,
        end: endOffset
    });

    return new Promise<string>((resolve, reject) => {
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
}