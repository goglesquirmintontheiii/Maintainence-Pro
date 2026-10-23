// Read and write metadata inside PNG files (floor plan export, MP-110).
// - iTXt chunk with keyword "mpro:floorplan" holding the drawing as JSON (UTF-8, uncompressed)
// - eXIf chunk with an EXIF UserComment holding the same JSON, for tools that only read EXIF
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const PNG_KEYWORD = "mpro:floorplan";
let table = null;
function crc32(bytes) {
    if (!table) {
        table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++)
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
    }
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++)
        c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function u32(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}
function chunk(type, data) {
    const t = new TextEncoder().encode(type);
    return concat([u32(data.length), t, data, u32(crc32(concat([t, data])))]);
}
function itxt(keyword, text) {
    const enc = new TextEncoder();
    // keyword \0 compression-flag(0) compression-method(0) language-tag \0 translated-keyword \0 text
    return chunk("iTXt", concat([enc.encode(keyword), new Uint8Array([0, 0, 0, 0, 0]), enc.encode(text)]));
}
/** EXIF (big-endian TIFF) with IFD0 → Exif IFD → UserComment (ASCII). */
function exifUserComment(text) {
    const body = new TextEncoder().encode(text.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));
    const comment = concat([new TextEncoder().encode("ASCII\0\0\0"), body]);
    const be16 = (n) => new Uint8Array([(n >> 8) & 255, n & 255]);
    const header = concat([new TextEncoder().encode("MM"), be16(42), u32(8)]);
    // IFD0 at 8: 1 entry (ExifIFDPointer 0x8769, LONG, 1, offset) + next IFD 0 → 2 + 12 + 4 = 18 bytes → Exif IFD at 26
    const exifIfdAt = 8 + 18;
    const ifd0 = concat([be16(1), be16(0x8769), be16(4), u32(1), u32(exifIfdAt), u32(0)]);
    // Exif IFD: 1 entry (UserComment 0x9286, UNDEFINED, count, offset) + next 0 → 18 bytes → data at 44
    const dataAt = exifIfdAt + 18;
    const exifIfd = concat([be16(1), be16(0x9286), be16(7), u32(comment.length), u32(dataAt), u32(0)]);
    return chunk("eXIf", concat([header, ifd0, exifIfd, comment]));
}
/** Insert the drawing JSON into a PNG (right after IHDR). */
export function embedInPng(png, json) {
    const b = new Uint8Array(png);
    if (!SIG.every((v, i) => b[i] === v))
        throw new Error("Not a PNG image");
    const ihdrLen = (b[8] << 24) | (b[9] << 16) | (b[10] << 8) | b[11];
    const afterIhdr = 8 + 12 + ihdrLen;
    return concat([b.slice(0, afterIhdr), itxt(PNG_KEYWORD, json), exifUserComment(json), b.slice(afterIhdr)]);
}
/** The drawing JSON stored in a PNG by embedInPng, or null. Reads the iTXt chunk, then falls back to EXIF. */
export function readFromPng(png) {
    const b = new Uint8Array(png);
    if (!SIG.every((v, i) => b[i] === v))
        return null;
    const dec = new TextDecoder();
    let o = 8;
    let fromExif = null;
    while (o + 8 <= b.length) {
        const len = ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
        const type = dec.decode(b.slice(o + 4, o + 8));
        const data = b.slice(o + 8, o + 8 + len);
        if (type === "iTXt") {
            const z = data.indexOf(0);
            if (dec.decode(data.slice(0, z)) === PNG_KEYWORD && data[z + 1] === 0) {
                // skip compression flag/method, language tag and translated keyword
                let p = z + 3;
                p = data.indexOf(0, p) + 1;
                p = data.indexOf(0, p) + 1;
                return dec.decode(data.slice(p));
            }
        }
        else if (type === "eXIf" && !fromExif) {
            const s = dec.decode(data);
            const at = s.indexOf("ASCII\0\0\0");
            if (at >= 0)
                fromExif = s.slice(at + 8).replace(/\\u([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        }
        else if (type === "IEND")
            break;
        o += 12 + len;
    }
    return fromExif;
}
