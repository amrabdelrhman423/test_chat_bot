/**
 * Encoding Utilities
 * Functions for handling text encoding issues (Windows-1252, UTF-8, Arabic)
 */

/**
 * Fix encoding issues when text is misinterpreted as Windows-1252
 * @param {string} str - The potentially mis-encoded string
 * @returns {string} - The correctly decoded UTF-8 string
 */
export function fixEncoding(str) {
    // Manually map Windows-1252 characters that aren't in Latin-1
    // to their byte values.
    const win1252Map = {
        '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84,
        '\u2026': 0x85, '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88,
        '\u2030': 0x89, '\u0160': 0x8A, '\u2039': 0x8B, '\u0152': 0x8C,
        '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92, '\u201C': 0x93,
        '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
        '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B,
        '\u0153': 0x9C, '\u017E': 0x9E, '\u0178': 0x9F
    };

    // SAFETY CHECK: If the string already contains high-byte characters
    // that are NOT in our Windows-1252 map (like Arabic letters),
    // then the string is likely ALREADY valid Unicode. Do not mangle it.
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        const code = char.charCodeAt(0);
        if (code > 0xFF && !win1252Map[char]) {
            return str;
        }
    }

    const bytes = new Uint8Array(str.length);

    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        const code = str.charCodeAt(i);
        if (win1252Map[char]) {
            bytes[i] = win1252Map[char];
        } else if (code <= 0xFF) {
            bytes[i] = code;
        } else {
            // Fallback for unexpected chars: keep low byte
            bytes[i] = code & 0xFF;
        }
    }

    // Now decode these bytes as UTF-8
    return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Normalize Arabic medical text for better search matching
 * @param {string} text - The Arabic text to normalize
 * @returns {string} - Normalized text
 */
export function normalizeArabicMedical(text) {
    if (!text) return "";
    return text
        .replace(/[\u064B-\u065F]/g, '') // remove diacritics
        .replace(/[إأآٱ]/g, 'ا') // normalize alef
        .replace(/ى/g, 'ي') // normalize ya
        .replace(/ة/g, 'ه') // normalize ta marbuta
        .replace(/ـ/g, '') // remove tatweel
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Escape special regex characters in a string
 * @param {string} str - The string to escape
 * @returns {string} - Escaped string safe for regex
 */
export function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Clean search term by removing common prefixes (hospital, doctor titles, etc.)
 * @param {string} term - The search term to clean
 * @returns {string} - Cleaned search term
 */
export function cleanSearchTerm(term) {
    if (!term) return "";
    return term.replace(/\b(Hospital|Hospitals|Clinic|Clinics|Center|Centers|Centre|Centres|Dr|Doctor|Doctors|City|Governorate)\.?\b/gi, "")
        .replace(/^(د\.|دكتور|دكتورة|مستشفى|عيادة|مركز|محافظة|مدينة|حي|منطقة)\s+/g, "")
        .trim();
}
