/* global module */
// Shared by the source preparer, CEF relay and Panorama receiver. No native APIs.
(() => {
    "use strict";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const CHUNK_BYTES = 2700, MAX_PACKED = 8 * 1024 * 1024, MAX_RAW = 16 * 1024 * 1024;
    function checksum(bytes) {
        let hash = 2166136261;
        for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
        return hash.toString(16).padStart(8, "0");
    }
    function base64(bytes) {
        let out = "";
        for (let i = 0; i < bytes.length; i += 3) {
            const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
            out += alphabet[n >>> 18] + alphabet[(n >>> 12) & 63] +
                (i + 1 < bytes.length ? alphabet[(n >>> 6) & 63] : "=") +
                (i + 2 < bytes.length ? alphabet[n & 63] : "=");
        }
        return out;
    }
    function unbase64(text) {
        if (typeof text !== "string" || !text.length || text.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new Error("Invalid Base64");
        const out = [];
        for (let i = 0; i < text.length; i += 4) {
            const n = (alphabet.indexOf(text[i]) << 18) | (alphabet.indexOf(text[i + 1]) << 12) |
                (Math.max(0, alphabet.indexOf(text[i + 2])) << 6) | Math.max(0, alphabet.indexOf(text[i + 3]));
            out.push((n >>> 16) & 255);
            if (text[i + 2] !== "=") out.push((n >>> 8) & 255);
            if (text[i + 3] !== "=") out.push(n & 255);
        }
        const bytes = new Uint8Array(out);
        if (base64(bytes) !== text) throw new Error("Noncanonical Base64");
        return bytes;
    }
    // Literal token: 0..127 => 1..128 bytes. Match: 128..255 => 3..130
    // bytes copied from a two-byte backward distance. Matching can overlap.
    function pack(bytes) {
        if (!bytes.length || bytes.length > MAX_RAW) throw new Error("Raw size limit");
        const out = [], last = new Map(); let literals = [];
        function flush() { if (literals.length) { out.push(literals.length - 1, ...literals); literals = []; } }
        for (let i = 0; i < bytes.length;) {
            let length = 0, distance = 0;
            const key = i + 2 < bytes.length ? (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2] : -1;
            const previous = last.get(key);
            if (key >= 0 && previous !== undefined && i - previous <= 65535) {
                distance = i - previous;
                while (length < 130 && i + length < bytes.length && bytes[previous + length] === bytes[i + length]) length++;
            }
            if (length >= 3) { flush(); out.push(128 + length - 3, distance >>> 8, distance & 255); }
            else { length = 1; literals.push(bytes[i]); if (literals.length === 128) flush(); }
            for (let j = i; j < i + length && j + 2 < bytes.length; j++) last.set((bytes[j] << 16) | (bytes[j + 1] << 8) | bytes[j + 2], j);
            i += length;
        }
        flush();
        if (out.length > MAX_PACKED) throw new Error("Packed size limit");
        return new Uint8Array(out);
    }
    function unpack(bytes, rawLength) {
        if (!Number.isInteger(rawLength) || rawLength < 1 || rawLength > MAX_RAW || bytes.length > MAX_PACKED) throw new Error("Size limit");
        const out = new Uint8Array(rawLength); let at = 0;
        for (let i = 0; i < bytes.length;) {
            const token = bytes[i++], length = token < 128 ? token + 1 : token - 128 + 3;
            if (at + length > out.length) throw new Error("Decompression overflow");
            if (token < 128) {
                if (i + length > bytes.length) throw new Error("Truncated literal");
                for (let j = 0; j < length; j++) out[at++] = bytes[i++];
            } else {
                if (i + 2 > bytes.length) throw new Error("Truncated match");
                const distance = (bytes[i++] << 8) | bytes[i++];
                if (!distance || distance > at) throw new Error("Invalid match distance");
                for (let j = 0; j < length; j++) { out[at] = out[at - distance]; at++; }
            }
        }
        if (at !== rawLength) throw new Error("Decompressed size mismatch");
        return out;
    }
    function utf8(bytes) {
        const pieces = []; let text = "";
        for (let i = 0; i < bytes.length;) {
            const first = bytes[i++]; let point = first, remaining = 0, minimum = 0;
            if (first >= 0xc2 && first <= 0xdf) { point &= 31; remaining = 1; minimum = 128; }
            else if (first >= 0xe0 && first <= 0xef) { point &= 15; remaining = 2; minimum = 2048; }
            else if (first >= 0xf0 && first <= 0xf4) { point &= 7; remaining = 3; minimum = 65536; }
            else if (first > 127) throw new Error("Invalid UTF-8 leader");
            for (let j = 0; j < remaining; j++) {
                const byte = bytes[i++];
                if (byte === undefined || (byte & 192) !== 128) throw new Error("Invalid UTF-8 continuation");
                point = (point << 6) | (byte & 63);
            }
            if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error("Invalid UTF-8 code point");
            text += String.fromCodePoint(point);
            if (text.length >= 8192) { pieces.push(text); text = ""; }
        }
        return pieces.join("") + text;
    }
    function validateManifest(meta) {
        if (!meta || !/^[a-f0-9]{40}$/.test(meta.revision) || !/^[a-f0-9]{64}$/.test(meta.sha256) ||
            !/^[a-f0-9]{8}$/.test(meta.checksum) || !Number.isInteger(meta.bytes) || meta.bytes < 1 || meta.bytes > MAX_PACKED ||
            !Number.isInteger(meta.rawBytes) || meta.rawBytes < 1 || meta.rawBytes > MAX_RAW ||
            meta.chunks !== Math.ceil(meta.bytes / CHUNK_BYTES)) throw new Error("Invalid manifest");
        if (meta.scope !== undefined && (typeof meta.scope !== "string" || !/^panorama\/layout\/[A-Za-z0-9_./-]+\.xml$/.test(meta.scope) ||
            meta.scope.includes("..") || meta.profile !== checksum(Array.from(meta.scope, c => c.charCodeAt(0))))) throw new Error("Invalid profile manifest");
        return meta;
    }
    class Receiver {
        constructor(meta) { this.meta = validateManifest(meta); this.parts = new Map(); }
        accept(index, data) {
            if (!Number.isInteger(index) || index < 0 || index >= this.meta.chunks) throw new Error("Invalid chunk index");
            const bytes = unbase64(data);
            const length = Math.min(CHUNK_BYTES, this.meta.bytes - index * CHUNK_BYTES);
            if (bytes.length !== length) throw new Error("Chunk size mismatch");
            if (this.parts.has(index)) {
                if (base64(this.parts.get(index)) !== data) throw new Error("Conflicting duplicate chunk");
                return false;
            }
            this.parts.set(index, bytes); return true;
        }
        complete() { return this.parts.size === this.meta.chunks; }
        result() {
            if (!this.complete()) throw new Error("Incomplete snapshot");
            const bytes = new Uint8Array(this.meta.bytes);
            for (const [index, part] of this.parts) bytes.set(part, index * CHUNK_BYTES);
            if (checksum(bytes) !== this.meta.checksum) throw new Error("Transport checksum mismatch");
            const snapshot = JSON.parse(utf8(unpack(bytes, this.meta.rawBytes)));
            if (snapshot.revision !== this.meta.revision || !snapshot.files || !Array.isArray(snapshot.layouts)) throw new Error("Snapshot identity mismatch");
            return snapshot;
        }
    }
    const codec = { CHUNK_BYTES, MAX_PACKED, MAX_RAW, checksum, base64, unbase64, pack, unpack, utf8, validateManifest, Receiver };
    if (typeof module !== "undefined" && module.exports) module.exports = codec;
    else globalThis.QOL_REMOTE_CODEC = codec;
})();
