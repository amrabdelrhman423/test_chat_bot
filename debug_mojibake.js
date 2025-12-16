
function fixEncoding(str) {
    const win1252Map = {
        '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84,
        '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88,
        '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C,
        '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93,
        '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
        '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B,
        '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F
    };

    // DEBUG: Print char codes
    console.log("Input codes:", str.split('').map(c => c.charCodeAt(0).toString(16)).join(' '));

    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        const code = str.charCodeAt(i);
        if (win1252Map[char]) {
            bytes[i] = win1252Map[char];
        } else if (code <= 0xFF) {
            bytes[i] = code;
        } else {
            console.log(`Warning: char ${char} (${code}) > 0xFF and not in map`);
            bytes[i] = code & 0xFF;
        }
    }

    const decoded = new TextDecoder('utf-8').decode(bytes);
    console.log("Decoded:", decoded);
    return decoded;
}

const input = "Ø¯ÙƒØªÙˆØ±Ø©";
console.log("Input:", input);
fixEncoding(input);
