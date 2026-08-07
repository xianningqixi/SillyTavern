import fs from 'node:fs';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';

import encode from './png/encode.js';
import extract from 'png-chunks-extract';
import PNGtext from 'png-chunk-text';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/**
 * 容错的 PNG chunk 提取：不校验 CRC，忽略 IEND 之后的尾随数据。
 * 社区里大量角色卡被三方工具改写过（追加数据、CRC 未重算），
 * png-chunks-extract 的严格校验会把这些可读的卡直接判死。
 * @param {Buffer} image PNG image buffer
 * @returns {Array<{ name: string, data: Uint8Array }>} chunks
 */
function extractChunksTolerant(image) {
    const buffer = Buffer.isBuffer(image) ? image : Buffer.from(image);
    if (buffer.length < 16 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('Not a PNG file.');
    }
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const name = buffer.toString('latin1', offset + 4, offset + 8);
        if (!/^[A-Za-z]{4}$/.test(name)) break;
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd > buffer.length) break;
        chunks.push({ name, data: new Uint8Array(buffer.subarray(dataStart, dataEnd)) });
        if (name === 'IEND') break;
        // 4 字节 CRC 直接跳过，不校验
        offset = dataEnd + 4;
    }
    if (!chunks.length) throw new Error('No PNG chunks found.');
    return chunks;
}

/**
 * @param {Buffer} image PNG image buffer
 * @returns {Array<{ name: string, data: Uint8Array }>} chunks
 */
function extractChunks(image) {
    try {
        return extract(new Uint8Array(image));
    } catch (error) {
        console.warn('Strict PNG chunk extraction failed, retrying tolerantly:', error instanceof Error ? error.message : error);
        return extractChunksTolerant(image);
    }
}

/**
 * 解出 zTXt chunk：keyword \0 compressionMethod(1B) + deflate 压缩文本。
 * @param {Uint8Array} data chunk data
 * @returns {{ keyword: string, text: string } | null}
 */
function decodeZtxtChunk(data) {
    const buffer = Buffer.from(data);
    const separator = buffer.indexOf(0);
    if (separator < 1 || separator + 2 > buffer.length) return null;
    try {
        const keyword = buffer.toString('latin1', 0, separator);
        const text = zlib.inflateSync(buffer.subarray(separator + 2)).toString('latin1');
        return { keyword, text };
    } catch {
        return null;
    }
}

/**
 * 解出 iTXt chunk：keyword \0 compFlag(1B) compMethod(1B) langTag \0 translatedKeyword \0 text。
 * @param {Uint8Array} data chunk data
 * @returns {{ keyword: string, text: string } | null}
 */
function decodeItxtChunk(data) {
    const buffer = Buffer.from(data);
    const keywordEnd = buffer.indexOf(0);
    if (keywordEnd < 1 || keywordEnd + 3 > buffer.length) return null;
    const compressed = buffer[keywordEnd + 1] === 1;
    const langEnd = buffer.indexOf(0, keywordEnd + 3);
    if (langEnd < 0) return null;
    const translatedEnd = buffer.indexOf(0, langEnd + 1);
    if (translatedEnd < 0) return null;
    try {
        const keyword = buffer.toString('latin1', 0, keywordEnd);
        const payload = buffer.subarray(translatedEnd + 1);
        const text = compressed
            ? zlib.inflateSync(payload).toString('utf8')
            : payload.toString('utf8');
        return { keyword, text };
    } catch {
        return null;
    }
}

/**
 * 收集所有文本类 chunk（tEXt/zTXt/iTXt）里的 keyword/text。
 * @param {Array<{ name: string, data: Uint8Array }>} chunks PNG chunks
 * @returns {Array<{ keyword: string, text: string }>}
 */
function collectTextualChunks(chunks) {
    const result = [];
    for (const chunk of chunks) {
        if (chunk.name === 'tEXt') {
            try {
                result.push(PNGtext.decode(chunk.data));
            } catch {
                // 忽略坏掉的单个 chunk，继续找其他携带角色数据的 chunk
            }
        } else if (chunk.name === 'zTXt') {
            const decoded = decodeZtxtChunk(chunk.data);
            if (decoded) result.push(decoded);
        } else if (chunk.name === 'iTXt') {
            const decoded = decodeItxtChunk(chunk.data);
            if (decoded) result.push(decoded);
        }
    }
    return result;
}

/**
 * @param {{ keyword: string, text: string }} chunk textual chunk
 * @returns {string | null} decoded character JSON, or null when not decodable/parseable
 */
function decodeCharacterPayload(chunk) {
    // 规范是 base64(JSON)，但个别工具直接写明文 JSON，两种都试
    const attempts = [
        Buffer.from(chunk.text.replace(/\s+/g, ''), 'base64').toString('utf8'),
        chunk.text,
    ];
    for (const candidate of attempts) {
        try {
            JSON.parse(candidate);
            return candidate;
        } catch {
            // 尝试下一个解码方式
        }
    }
    return null;
}

/**
 * Writes Character metadata to a PNG image buffer.
 * Writes only 'chara', 'ccv3' is not supported and removed not to create a mismatch.
 * @param {Buffer} image PNG image buffer
 * @param {string} data Character data to write
 * @returns {Buffer} PNG image buffer with metadata
 */
export const write = (image, data) => {
    const chunks = extractChunks(image);
    const tEXtChunks = chunks.filter(chunk => chunk.name === 'tEXt');

    // Remove existing tEXt chunks
    for (const tEXtChunk of tEXtChunks) {
        const data = PNGtext.decode(tEXtChunk.data);
        if (data.keyword.toLowerCase() === 'chara' || data.keyword.toLowerCase() === 'ccv3') {
            chunks.splice(chunks.indexOf(tEXtChunk), 1);
        }
    }

    // Add new v2 chunk before the IEND chunk
    const base64EncodedData = Buffer.from(data, 'utf8').toString('base64');
    chunks.splice(-1, 0, PNGtext.encode('chara', base64EncodedData));

    // Try adding v3 chunk before the IEND chunk
    try {
        //change v2 format to v3
        const v3Data = JSON.parse(data);
        v3Data.spec = 'chara_card_v3';
        v3Data.spec_version = '3.0';

        const base64EncodedData = Buffer.from(JSON.stringify(v3Data), 'utf8').toString('base64');
        chunks.splice(-1, 0, PNGtext.encode('ccv3', base64EncodedData));
    } catch (error) {
        // Ignore errors when adding v3 chunk
    }

    const newBuffer = Buffer.from(encode(chunks));
    return newBuffer;
};

/**
 * Reads Character metadata from a PNG image buffer.
 * Supports V2 (chara) and V3 (ccv3) in tEXt, zTXt and iTXt chunks; tolerates
 * broken CRCs and trailing data. ccv3 takes precedence, but falls back to
 * chara when the ccv3 payload is not valid JSON.
 * @param {Buffer} image PNG image buffer
 * @returns {string} Character data
 */
export const read = (image) => {
    const chunks = extractChunks(image);
    const textChunks = collectTextualChunks(chunks);

    if (textChunks.length === 0) {
        console.error('PNG metadata does not contain any text chunks.');
        throw new Error('No PNG metadata.');
    }

    // ccv3 优先；单个 chunk 损坏时回退到其余可解析的候选，而不是直接判死整张卡
    const candidates = [
        ...textChunks.filter((chunk) => chunk.keyword.toLowerCase() === 'ccv3'),
        ...textChunks.filter((chunk) => chunk.keyword.toLowerCase() === 'chara'),
    ];

    if (candidates.length === 0) {
        console.error('PNG metadata does not contain any character data.');
        throw new Error('No PNG metadata.');
    }

    for (const candidate of candidates) {
        const payload = decodeCharacterPayload(candidate);
        if (payload !== null) return payload;
    }

    console.error('PNG character metadata is present but could not be decoded as JSON.');
    throw new Error('Character metadata is corrupted.');
};

/**
 * Parses a card image and returns the character metadata.
 * @param {string} cardUrl Path to the card image
 * @param {string} format File format
 * @returns {Promise<string>} Character data
 */
export const parse = async (cardUrl, format) => {
    let fileFormat = format === undefined ? 'png' : format;

    switch (fileFormat) {
        case 'png': {
            const buffer = fs.readFileSync(cardUrl);
            return read(buffer);
        }
    }

    throw new Error('Unsupported format');
};

