import { promisify } from "util";
import { inflate } from "zlib";
import { Sha256 } from "@aws-crypto/sha256-js";

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

