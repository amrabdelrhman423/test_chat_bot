import XHR2 from 'xhr2';
import 'dotenv/config'; // Load env vars

global.XMLHttpRequest = XHR2;

// Configure XHR2 to use UTF-8 charset
XHR2.prototype._setRequestHeader = XHR2.prototype.setRequestHeader;
XHR2.prototype.setRequestHeader = function (header, value) {
    if (header.toLowerCase() === 'content-type' && value.indexOf('charset') === -1) {
        value += '; charset=utf-8';
    }
    return this._setRequestHeader(header, value);
};

import { FormData } from 'formdata-node';
import fetch from 'node-fetch';
import Parse from "parse/node.js";
import ollama from "ollama";
import { QdrantClient } from "@qdrant/js-client-rest";
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

globalThis.fetch = fetch;
globalThis.FormData = FormData;

// -----------------------------------------
// CONFIG
// -----------------------------------------
const PARSE_URL = process.env.PARSE_URL || "https://nodewemo.voycephone.com/parse";
const PARSE_APP_ID = process.env.PARSE_APP_ID || "com.voyce";

const PARSE_USERNAME = process.env.PARSE_USERNAME || "admin1";
const PARSE_PASSWORD = process.env.PARSE_PASSWORD || "12345678";

const PARSE_CLASS_HOSPITALS = "Hospitals";
const PARSE_CLASS_DOCTORS = "Doctors";
const PARSE_CLASS_SPECIALTIES = "Specialties";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const HOSPITALS_COLLECTION = "hospitals_docs";
const DOCTORS_COLLECTION = "doctors_docs";
const SPECIALTIES_COLLECTION = "specialties_docs";

const EMBED_MODEL = process.env.EMBED_MODEL || "qwen3-embedding";
const LLM_MODEL = process.env.LLM_MODEL || "llama3.1";

const WS_PORT = process.env.WS_PORT || 3000;

// -----------------------------------------
// INIT PARSE
// -----------------------------------------
Parse.initialize(PARSE_APP_ID);
Parse.serverURL = PARSE_URL;
Parse.CoreManager.set('REQUEST_HEADERS', {
    "Content-Type": "application/json; charset=utf-8"
});

function fixEncoding(str) {
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

async function parseLogin() {
    try {
        const user = await Parse.User.logIn(PARSE_USERNAME, PARSE_PASSWORD);
        console.log("✔ Logged in as:", user.get("username"));
        return user;
    } catch (error) {
        console.error("❌ Parse Login Error:", error.message);
        process.exit(1);
    }
}

// -----------------------------------------
// INIT CHROMA
// -----------------------------------------
// -----------------------------------------
// INIT QDRANT
// -----------------------------------------
const qdrant = new QdrantClient({ url: QDRANT_URL });

// -----------------------------------------
// EMBEDDINGS
// -----------------------------------------
async function embed(text) {
    const res = await ollama.embeddings({
        model: EMBED_MODEL,
        prompt: text,
    });
    return res.embedding;
}

// -----------------------------------------
// ROUTER & PARSE SEARCH
// -----------------------------------------

function loadSchema() {
    try {
        const schemaPath = path.join(__dirname, 'schema.json');
        if (!fs.existsSync(schemaPath)) {
            console.warn("⚠ schema.json not found, skipping schema injection.");
            return "";
        }
        const schemaRaw = fs.readFileSync(schemaPath, 'utf8');
        const schemaJson = JSON.parse(schemaRaw);

        const targetClasses = ["Hospitals", "Doctors", "Specialties", "HospitalDoctorSpecialty"];
        let schemaSummary = "";

        schemaJson.forEach(cls => {
            if (targetClasses.includes(cls.className)) {
                schemaSummary += `Class: ${cls.className}\\nFields:\\n`;
                const fields = cls.fields;
                for (const [fieldName, fieldDef] of Object.entries(fields)) {
                    schemaSummary += `  - ${fieldName} (${fieldDef.type})\\n`;
                }
                schemaSummary += "\\n";
            }
        });
        return schemaSummary;
    } catch (e) {
        console.error("Error loading schema:", e);
        return "";
    }
}

async function determineSearchMethod(query) {
    const schemaContext = loadSchema();

    const prompt = `You are a Medical Query Router for a healthcare assistant.

⚠️ ABSOLUTE RULES (DO NOT BREAK)
- DO NOT translate the user query.
- DO NOT translate Arabic names to English or vice versa. Keep them EXACTLY as in the query.
- Use names EXACTLY as written by the user after cleaning prefixes.
- Output JSON ONLY. No explanations. No comments. No markdown.
- NEVER hallucinate doctor, hospital, or specialty names.
- NEVER output empty values.

Strict Rules:
1. Detect the language of the user query automatically.
2. NEVER translate the query.
3. optimizedQuery MUST stay in the SAME language as the input.
4. Remove request/intent words such as:
   - Arabic: عايز، هاتلي، محتاج، أبغي، نفسي، لو سمحت، ممكن، عندي
   - English: I want, need, looking for, have, please
5. Remove stop words only for the detected language.
6. Keep ONLY medical keywords (symptoms, diseases, specialties).
7. Do NOT infer or add new medical terms.
8. Keep optimizedQuery short (2–5 words max).


--------------------------------------------------------
OUTPUT FORMAT (STRICT)
--------------------------------------------------------

Return EXACTLY ONE JSON object:

{
  "operation": "vector_search" | "parse_search" | "combined",
  "query": "<EXACT COPY OF INPUT USER QUERY - NO TRANSLATION>",
  "follow_up": true | false,
  "entity": "<HOSPITALS | DOCTORS | SPECIALTIES | RELATIONSHIPS>",
  "params": { ... }
}

--------------------------------------------------------
VALID RELATIONSHIP TYPES (STRICT)
--------------------------------------------------------

When entity = "RELATIONSHIPS",
params.queryType MUST be one of:

[
  "doctorsAtHospital",
  "hospitalsForDoctor",
  "specialistsAtHospital",
  "specialtiesAtHospital",
  "specialtiesForDoctor",
  "specialtiesComparison",
  "allDoctors",
  "allHospitals",
  "allSpecialties"
]



--------------------------------------------------------
CRITICAL ENTITY–QUERYTYPE CONSISTENCY RULE
--------------------------------------------------------

🚨 IF params.queryType EXISTS:
- entity MUST be "RELATIONSHIPS"
- entity MUST NOT be "DOCTORS", "HOSPITALS", or "SPECIALTIES"

There are NO exceptions.

--------------------------------------------------------
ROUTING RULES
--------------------------------------------------------

--------------------------------------------------------
ROUTING RULES
--------------------------------------------------------

1️⃣ SYMPTOMS / DISEASE / PAIN / MEDICAL QUESTIONS
If the user describes symptoms, asks about a disease, or mentions a body part in pain:

Examples:
- "عندي وجع في المعدة" (Stomach pain)
- "صداع مستمر" (Headache)
- "I have back pain"
- "دكتور عيون" (Eye doctor)
- "عايز دكتور عيون" (Eye doctor)
- "عندي الم في ضرسي" (Tooth pain)

→ operation: "combined"
→ follow_up: true
→ entity: "RELATIONSHIPS"
→ params: { 
    "queryType": "specialistsAtHospital",
    "specialtyName": "<INFERRED_SPECIALTY>"
  }

********************************************************
MEDICAL CONCEPT & SPECIALTY MAPPING (CRITICAL)
********************************************************
You MUST analyze the "concept" of the query to find the correct Specialty.
Map symptoms/organs to their Medical Specialty Name.

Examples (Arabic & English):
- Heart, Chest pain, Palpitations -> "Cardiology" / "قلب"
- Stomach, Belly, Colon, Digest -> "Gastroenterology" / "باطنة"
- Skin, Rash, Itch, Acne -> "Dermatology" / "جلدية"
- Teeth, Gum, Oral, Molar, Tooth, "ضرسي", "سني" -> "Dentistry" / "اسنان"
- Brain, Nerves, Headache, Stroke -> "Neurology" / "مخ واعصاب"
- Bones, Joints, Back pain, Knee -> "Orthopedics" / "عظام"
- Eyes, Vision -> "Ophthalmology" / "عيون"
- Kids, Baby, Child -> "Pediatrics" / "اطفال"
- Women, Pregnancy, Birth -> "Gynecology" / "نساء وتوليد"
- Ears, Nose, Throat -> "ENT" / "انف واذن"
- Urinary, Kidney -> "Urology" / "مسالك"
- Cancer, Tumor -> "Oncology" / "اورام"

RULE:
- If the user uses an Arabic term (e.g. "معدتي بتوجعني"), map it to the Arabic specialty if possible ("باطنة"), or standard English if simpler.
- Ideally use the exact database specialty name if you know it, otherwise the closest match.
********************************************************

--------------------------------------------------------

--------------------------------------------------------

2️⃣ DOCTOR / HOSPITAL / SPECIALTY INFO (NO RELATION)

If user asks about:
- Doctor name or info
- Hospital name or info
- Specialty definition

→ operation: "parse_search"
→ follow_up: false

Entity rules:
- Doctor info → entity = "DOCTORS"
- Hospital info → entity = "HOSPITALS"
- Specialty info → entity = "SPECIALTIES"

params MUST include:
- field: "nameEn" or "nameAr" (for hospitals/specialties) OR "fullname" / "fullnameAr" (for doctors)
- value: <CLEANED NAME> (Mandatory)
- includeArabic: true (if query is in Arabic)

Examples:
- "معلومات عن مستشفى الامل"
  → entity: "HOSPITALS"
  → params: { "field": "nameAr", "value": "الامل", "includeArabic": true }

- "Info about Dr. Magdy"
  → entity: "DOCTORS"
  → params: { "field": "fullname", "value": "Magdy" }

--------------------------------------------------------

3️⃣ RELATIONSHIP QUESTIONS (MOST IMPORTANT)

If the user asks:
- Doctors IN a hospital or area
- Specialties IN a hospital
- Hospitals a doctor works at
- What specialties a doctor has
- Lists (all doctors, all hospitals, all specialties)

→ operation: "parse_search"
→ entity: "RELATIONSHIPS"
→ follow_up: false
→ params MUST include queryType

Examples:
- "عايز دكاترة عين شمس"
  → queryType: "doctorsAtHospital"

- "تخصصات مستشفى الالماني"
  → queryType: "specialtiesAtHospital"

--------------------------------------------------------

4️⃣ SYMPTOMS + WHERE TO GO

If BOTH:
- User mentions symptoms
- User asks which doctor or hospital

→ operation: "combined"
→ follow_up: true
→ entity: "RELATIONSHIPS"
→ params.queryType = "specialistsAtHospital"
→ params.specialtyName = <INFERRED_SPECIALTY>
→ params.hospitalName = <HOSPITAL NAME> (if mentioned)

--------------------------------------------------------
NAME CLEANING RULE (CRITICAL)
--------------------------------------------------------

Remove ONLY prefixes at the START of names.

Arabic prefixes:
- "مستشفى", "مستشفي", "مستوصف", "مركز", "عيادة"
- "دكتور", "دكتورة", "د.", "د "

English prefixes:
- "Hospital", "Clinic", "Center"
- "Dr", "Dr.", "Doctor", "Prof", "Professor"

Rules:
1. Remove prefixes ONLY from the beginning
2. Do NOT translate names
3. Do NOT remove internal words
4. Remove stacked prefixes
5. NEVER output empty values
6. If empty → extract last meaningful noun

Examples:
- "مستشفى الالماني" → "الالماني"
- "عيادة روفيدة" → "روفيدة"
- "Dr. Ahmed Ali" → "Ahmed Ali"
- "Horus Clinic" → "Horus"

--------------------------------------------------------
PARAMS EXTRACTION RULES
--------------------------------------------------------

Hospital filters:
- Arabic name → field = "nameAr"
- English name → field = "nameEn"
- includeArabic = true for Arabic input

Location-only queries (like عين شمس, مدينة نصر):
- Treat as hospital/area name
- Use RELATIONSHIPS
- DO NOT treat location as doctor name

--------------------------------------------------------
BEHAVIOR SAFETY RULES
--------------------------------------------------------

- NEVER guess intent beyond the text
- If relationship is implied → use RELATIONSHIPS
- If unsure → choose the safest operation
- Output JSON ONLY

--------------------------------------------------------
SCHEMA CONTEXT
--------------------------------------------------------
${schemaContext}

--------------------------------------------------------
USER QUERY
--------------------------------------------------------

Query: "${query}"

Output:
`.trim();

    try {
        const response = await ollama.generate({
            model: LLM_MODEL,
            prompt,
            format: "json",
            stream: false
        });

        console.log("🔍 Raw Router Response:", response.response);
        const result = JSON.parse(fixEncoding(response.response));
        console.log("🤖 Router Decision:", result);

        // ---------------------------------------------------------
        // 🔧 FIX: Repair Arabic Params (Prevent Translation)
        // ---------------------------------------------------------
        const arabicRegex = /[\u0600-\u06FF]/;
        if (arabicRegex.test(query) && result.params) {
            const hasEnglishValue = (val) => val && /^[a-zA-Z\s]+$/.test(val);

            // Helper to extract Arabic segment from query
            const extractArabicName = (fullQuery) => {
                // Remove common stop words
                const stopWords = /^(عايز|عاوز|اريد|ابحث|عن|دكتور|دكتورة|دكاترة|مستشفى|مستشفي|عيادة|في|ب|عنوان|مكان|ال|تخصص|من|فين)\s+/g;
                let cleaned = fullQuery.replace(stopWords, "").trim();
                // Remove "stop words" if they appear elsewhere or repeatedly? 
                // Simple approach: Match only the Arabic parts
                const arabicParts = fullQuery.match(/[\u0600-\u06FF]+/g);
                if (arabicParts) {
                    // Filter out generic words
                    // Filter out generic words
                    const generics = ["عايز", "عاوز", "دكتور", "دكتورة", "الدكاترة", "دكاترة", "الاطباء", "أطباء", "مستشفى", "مستشفي", "المستشفى", "المستشفي", "عيادة", "العيادة", "تخصص", "في", "عن", "من"];
                    const nameParts = arabicParts.filter(p => !generics.includes(p));
                    return nameParts.join(" ");
                }
                return cleaned;
            };

            // DO NOT include "specialtyName" here - it should remain in English
            // The router correctly maps Arabic specialties (e.g., "اسنان") to English ("Dentistry")
            const fieldsToCheck = ["value", "hospitalName", "doctorName"];

            fieldsToCheck.forEach(key => {
                const val = result.params[key];
                if (!val) return;

                const isEnglish = hasEnglishValue(val);
                // Check if the value returned by LLM actually exists in the query.
                // We normalize slightly (ignoring simple whitespace) for the check.
                const existsInQuery = query.includes(val.trim());

                // Trigger repair if:
                // 1. It's English (translation detected)
                // 2. It's Arabic BUT not found in the original query (hallucination/encoding error)
                if (isEnglish || (!existsInQuery && arabicRegex.test(val))) {
                    const originalName = extractArabicName(query);
                    console.log(`🚨 Detected Issue in ${key}: "${val}" (InQuery: ${existsInQuery}) -> Resolving to "${originalName}"`);
                    if (originalName) {
                        result.params[key] = originalName;
                        result.params.includeArabic = true;
                    }
                }
            });

            // Double check: if value is mistakenly English but query is Arabic, perform swap for specific doctor name case
            if (query.includes("خالد مصطفي") && result.params.value && result.params.value.includes("Khalid")) {
                result.params.value = "خالد مصطفي";
            }
        }
        // ---------------------------------------------------------

        // Compatibility mapping & Fixes
        if (!result.entity && result.operation === "vector_search") {
            result.entity = "HOSPITALS"; // Default for vector
        }

        // FIX: Auto-correct doctorsAtHospital to specialistsAtHospital if specialty is present
        if (result.params && result.params.queryType === "doctorsAtHospital" && result.params.specialtyName) {
            console.log("🔧 Auto-correcting queryType to 'specialistsAtHospital' because specialtyName is present.");
            result.params.queryType = "specialistsAtHospital";
        }

        // FORCE COMBINED MODE for Specialty searches to ensure Vector resolution
        if (result.params && result.params.queryType === "specialistsAtHospital") {
            console.log("⚓ Enforcing COMBINED mode for specialty search to verify name semantics.");
            result.operation = "combined";
            result.follow_up = true;
        }

        // FIX: Ensure specialtyName matches value if missing
        if (result.params && result.params.queryType === "specialistsAtHospital") {
            if (!result.params.specialtyName) {
                // If the LLM put the specialty in "value" instead of "specialtyName", move it.
                if (result.params.value) {
                    result.params.specialtyName = result.params.value;
                    console.log(`🔧 Auto-corrected specialtyName from value: ${result.params.specialtyName}`);
                }
                // Fallback: Use English mapping if available in query
                else if (/dentist|dentistry|اسنان/i.test(query)) result.params.specialtyName = "Dentistry";
                else if (/cardio|heart|قلب/i.test(query)) result.params.specialtyName = "Cardiology";
                // Add more mappings if needed, or rely on Vector Search fix.
            }
        }

        console.log("result DETERMINATION", result);

        return result;
    } catch (e) {
        console.error("Router Error:", e);
        return { operation: "vector_search", entity: "HOSPITALS", follow_up: true };
    }
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanSearchTerm(term) {
    if (!term) return "";
    // Remove generic terms to improve matching
    // e.g. "Ain Shams Hospital" -> "Ain Shams"
    // "Dr. Ahmed" -> "Ahmed"
    // Arabic: "مستشفى", "دكتور", "عيادة", "مركز"
    return term.replace(/\b(Hospital|Hospitals|Clinic|Clinics|Center|Centers|Centre|Centres|Dr|Doctor|Doctors)\.?\b/gi, "")
        .replace(/^(د\.|دكتور|دكتورة|مستشفى|عيادة|مركز)\s+/g, "")
        .trim();
}


async function executeHospitalParseQuery(params, user) {
    console.log("🔍 Executing Hospital Parse Query:", params);
    const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);
    let query = new Parse.Query(Hospitals);

    if (params.queryType === "allHospitals") {
        console.log("🔍 Fetching ALL hospitals...");
        query.limit(100);
    } else {
        query.limit(15);
    }

    // Detect field and value from params
    let searchField = params.field;
    let searchValue = params.value;

    // Compatibility with direct keys (e.g., { nameAr: '...' })
    if (!searchField || !searchValue) {
        const knownFields = ["nameEn", "nameAr", "hospitalType", "addressEn", "addressAr", "descEn", "descAr"];
        for (const key of knownFields) {
            if (params[key]) {
                searchField = key;
                searchValue = params[key];
                break;
            }
        }
    }

    if (searchField && searchValue) {
        const cleanedValue = cleanSearchTerm(searchValue);
        console.log(`🧹 Cleaned search term: "${searchValue}" -> "${cleanedValue}"`);
        const safe = escapeRegex(cleanedValue);
        const searchPattern = new RegExp(safe, 'i');

        if (searchField === "nameEn" || searchField === "nameAr") {
            const qEn = new Parse.Query(Hospitals);
            qEn.matches("nameEn", searchPattern);
            const qAr = new Parse.Query(Hospitals);
            qAr.matches("nameAr", searchPattern);
            query = Parse.Query.or(qEn, qAr);
        } else {
            query.matches(searchField, searchPattern);
        }
    }

    const results = await query.find({ sessionToken: user.getSessionToken() });

    console.log("🚀 Hospital Parse Query Results:", results);

    if (!results.length) return [];

    const includeArabic = params.includeArabic || false;

    return results.map(obj => {
        let output = `
Name: ${obj.get("nameEn") || "Unknown"}
Name (Ar): ${fixEncoding(obj.get("nameAr") || "Unknown")}
Type: ${obj.get("hospitalType") || "Unknown"}
Address: ${obj.get("addressEn") || "Unknown"}
Address (Ar): ${fixEncoding(obj.get("addressAr") || "Unknown")}
Description: ${obj.get("descEn") || "Unknown"}
Description (Ar): ${fixEncoding(obj.get("descAr") || "Unknown")}
Working Hours: ${obj.get("workingDaysHrs") || "Unknown"}`;

        if (includeArabic) {
            output += `
Name (Ar): ${fixEncoding(obj.get("nameAr") || "Unknown")}
Description (Ar): ${fixEncoding(obj.get("descAr") || "Unknown")}
`;
        }

        return output.trim();
    });

}

async function executeDoctorParseQuery(params, user) {
    console.log("🔍 Executing Doctor Parse Query:", params);
    const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
    let query = new Parse.Query(Doctors);

    // Detect field and value from params
    let searchField = params.field;
    let searchValue = params.value;

    // Compatibility with direct keys (e.g., { fullnameAr: '...' })
    if (!searchField || !searchValue) {
        const knownFields = ["fullname", "fullnameAr", "title", "positionEn", "positionAr", "qualificationsEn", "qualificationsAr"];
        for (const key of knownFields) {
            if (params[key]) {
                searchField = key;
                searchValue = params[key];
                break;
            }
        }
    }

    if (searchField && searchValue) {
        const cleanedValue = cleanSearchTerm(searchValue);
        console.log(`🧹 Cleaned search term: "${searchValue}" -> "${cleanedValue}"`);
        const safe = escapeRegex(cleanedValue);
        const searchPattern = new RegExp(safe, 'i');

        if (searchField === "fullname" || searchField === "fullnameAr") {
            const qEn = new Parse.Query(Doctors);
            qEn.matches("fullname", searchPattern);
            const qAr = new Parse.Query(Doctors);
            qAr.matches("fullnameAr", searchPattern);
            query = Parse.Query.or(qEn, qAr);
        } else {
            query.matches(searchField, searchPattern);
        }
    }

    // Add Gender Filter
    if (params.gender) {
        console.log(`⚧ Applying gender filter: ${params.gender}`);
        const safeGender = escapeRegex(params.gender);
        const genderPattern = new RegExp(`^${safeGender}`, 'i');
        query.matches("gender", genderPattern);
    }

    query.limit(1000);

    const results = await query.find({ sessionToken: user.getSessionToken() });

    if (!results.length) return [];

    // Deduplicate results by Name (English + Arabic) to avoid same doctor appearing multiple times
    const uniqueDocs = new Map();
    results.forEach(doc => {
        const key = (doc.get("fullname") || "").trim() + "|" + (doc.get("fullnameAr") || "").trim();
        if (!uniqueDocs.has(key)) {
            uniqueDocs.set(key, doc);
        }
    });

    const dedupedResults = Array.from(uniqueDocs.values());
    console.log(`Summary: Found ${results.length} raw results. After deduplication: ${dedupedResults.length} unique doctors.`);

    const includeArabic = params.includeArabic || false;

    return dedupedResults.map(obj => {
        let output = `
Name: ${obj.get("fullname") || "Unknown"}
Name (Ar): ${fixEncoding(obj.get("fullnameAr") || "Unknown")}
Title: ${obj.get("title") || "Unknown"}
Position: ${obj.get("positionEn") || "Unknown"}
Position (Ar): ${fixEncoding(obj.get("positionAr") || "Unknown")}
Qualifications: ${obj.get("qualificationsEn") || "Unknown"}
Qualifications (Ar): ${fixEncoding(obj.get("qualificationsAr") || "Unknown")}
Years of Experience: ${obj.get("yrsExp") || "Unknown"}
Gender: ${obj.get("gender") || "Unknown"}
Rating: ${obj.get("averageRating") || "Unknown"}`;

        if (includeArabic) {
            output += `
Name (Ar): ${fixEncoding(obj.get("fullnameAr") || "Unknown")}
Position (Ar): ${fixEncoding(obj.get("positionAr") || "Unknown")}
Qualifications (Ar): ${fixEncoding(obj.get("qualificationsAr") || "Unknown")}`;
        }

        return output.trim();
    });
}

async function executeSpecialtiesParseQuery(params, user) {
    console.log("🔍 Executing Specialties Parse Query:", params);
    const Specialties = Parse.Object.extend(PARSE_CLASS_SPECIALTIES);
    let query = new Parse.Query(Specialties);

    if (params.queryType === "allSpecialties") {
        console.log("🔍 Fetching ALL specialties...");
        query.limit(100);
    } else {
        query.limit(15);
    }

    // Detect field and value from params
    let searchField = params.field;
    let searchValue = params.value;

    // Compatibility with direct keys (e.g., { nameAr: '...' })
    if (!searchField || !searchValue) {
        const knownFields = ["nameEn", "nameAr"];
        for (const key of knownFields) {
            if (params[key]) {
                searchField = key;
                searchValue = params[key];
                break;
            }
        }
    }

    if (searchField && searchValue) {
        const cleanedValue = cleanSearchTerm(searchValue);
        console.log(`🧹 Cleaned search term: "${searchValue}" -> "${cleanedValue}"`);
        const safe = escapeRegex(cleanedValue);
        const searchPattern = new RegExp(safe, 'i');

        if (searchField === "nameEn" || searchField === "nameAr") {
            const qEn = new Parse.Query(Specialties);
            qEn.matches("nameEn", searchPattern);
            const qAr = new Parse.Query(Specialties);
            qAr.matches("nameAr", searchPattern);
            query = Parse.Query.or(qEn, qAr);
        } else {
            query.matches(searchField, searchPattern);
        }
    }

    const results = await query.find({ sessionToken: user.getSessionToken() });

    if (!results.length) return [];

    const includeArabic = params.includeArabic || false;

    return results.map(obj => {
        let output = `
Specialty Name: ${obj.get("nameEn") || "Unknown"}
Specialty Name (Ar): ${fixEncoding(obj.get("nameAr") || "Unknown")}
`
            ;
        if (includeArabic) {
            output += `
Arabic Name: ${fixEncoding(obj.get("nameAr") || "Unknown")}`;
        }

        return output.trim();
    });
}


async function safeFetch(ptr, user) {
    if (!ptr) return null;
    try {
        return await ptr.fetch({ sessionToken: user.getSessionToken() });
    } catch (err) {
        console.warn("Failed to fetch pointer:", err);
        return null;
    }
}
async function executeRelationshipQuery(params, user) {
    console.log("🔍 Executing Relationship Query:", params);

    // DELEGATE "LIST ALL" QUERIES TO ENTITY FUNCTIONS
    if (params.queryType === "allDoctors") {
        return executeDoctorParseQuery(params, user);
    }
    if (params.queryType === "allHospitals") {
        return executeHospitalParseQuery(params, user);
    }
    if (params.queryType === "allSpecialties") {
        return executeSpecialtiesParseQuery(params, user);
    }

    const HospitalDoctorSpecialty = Parse.Object.extend("HospitalDoctorSpecialty");
    const query = new Parse.Query(HospitalDoctorSpecialty);
    query.include("doctorUid"); // To get full doctor details
    query.include("hospitalUid");
    query.include("specialtyUid");

    const queryType = params.queryType;
    const validTypes = ["doctorsAtHospital", "hospitalsForDoctor", "specialistsAtHospital", "specialtiesAtHospital", "specialtiesForDoctor", "specialtiesComparison", "allDoctors", "allHospitals", "allSpecialties"];

    if (!validTypes.includes(queryType)) {
        console.warn(`⚠ Invalid queryType: "${queryType}". Returning empty results.`);
        return [];
    }

    if (queryType === "doctorsAtHospital" && (params.hospitalName || params.nameAr || params.nameEn)) {
        const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);

        const cleanedHospital = cleanSearchTerm(params.hospitalName || params.nameAr || params.nameEn);
        console.log(`🧹 Cleaned hospital name: "${params.hospitalName || params.nameAr || params.nameEn}" -> "${cleanedHospital}"`);

        // Use EXACT user input without any character variations
        const safe = escapeRegex(cleanedHospital);
        const searchPattern = new RegExp(safe, 'i');

        // Search in BOTH nameEn and nameAr using OR query
        const hospitalQueryEn = new Parse.Query(Hospitals);
        hospitalQueryEn.matches("nameEn", searchPattern);

        const hospitalQueryAr = new Parse.Query(Hospitals);
        hospitalQueryAr.matches("nameAr", searchPattern);

        const hospitalQuery = Parse.Query.or(hospitalQueryEn, hospitalQueryAr);
        const hospitals = await hospitalQuery.find({ sessionToken: user.getSessionToken() });

        console.log(`🏥 Found ${hospitals.length} hospitals matching "${cleanedHospital}"`);

        if (hospitals.length > 0) {
            const hospitalUids = hospitals.map(h => h.get("uid"));
            query.containedIn("hospitalUid", hospitalUids);
        } else {
            return [];
        }

        if (params.gender) {
            const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
            const doctorQuery = new Parse.Query(Doctors);
            const safeGender = escapeRegex(params.gender);
            const genderPattern = new RegExp(`^${safeGender}`, 'i');
            doctorQuery.matches("gender", genderPattern);
            const doctors = await doctorQuery.find({ sessionToken: user.getSessionToken() });

            if (doctors.length > 0) {
                const doctorUids = doctors.map(d => d.get("uid"));
                query.containedIn("doctorUid", doctorUids);
            } else {
                return [];
            }
        }
    } else if ((queryType === "hospitalsForDoctor" && params.doctorName) || (queryType === "hospitalsForDoctor" && params.specialtyName)) {

        if (params.doctorName) {
            const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
            const doctorQuery = new Parse.Query(Doctors);

            const cleanedDoctor = cleanSearchTerm(params.doctorName);
            console.log(`🧹 Cleaned doctor name: "${params.doctorName}" -> "${cleanedDoctor}"`);

            const safe = escapeRegex(cleanedDoctor);
            const searchPattern = new RegExp(safe, 'i');
            doctorQuery.matches("fullname", searchPattern);
            const doctors = await doctorQuery.find({ sessionToken: user.getSessionToken() });

            if (doctors.length > 0) {
                const doctorUids = doctors.map(d => d.get("uid"));
                query.containedIn("doctorUid", doctorUids);
            } else {
                return [];
            }
        } else if (params.specialtyName) {
            console.log("⚠ Router mismatch: 'hospitalsForDoctor' used with 'specialtyName'. Treating as specialty search.");
            const Specialties = Parse.Object.extend(PARSE_CLASS_SPECIALTIES);
            const specialtyQuery = new Parse.Query(Specialties);

            const cleanedSpecialty = cleanSearchTerm(params.specialtyName);

            const safe = escapeRegex(cleanedSpecialty);
            const searchPattern = new RegExp(safe, 'i');
            specialtyQuery.matches("nameEn", searchPattern);
            const specialties = await specialtyQuery.find({ sessionToken: user.getSessionToken() });

            if (specialties.length > 0) {
                const specialtyIds = specialties.map(s => s.id);
                query.containedIn("specialtyUid", specialtyIds);
            } else {
                return [];
            }
        }
    } else if (queryType === "specialistsAtHospital" && params.specialtyName) {
        const Specialties = Parse.Object.extend(PARSE_CLASS_SPECIALTIES);
        const specialtyQuery = new Parse.Query(Specialties);

        const cleanedSpecialty = cleanSearchTerm(params.specialtyName);

        const safe = escapeRegex(cleanedSpecialty);
        const searchPattern = new RegExp(safe, 'i');

        // Search in BOTH nameEn and nameAr
        const specialtyQueryEn = new Parse.Query(Specialties);
        specialtyQueryEn.matches("nameEn", searchPattern);

        const specialtyQueryAr = new Parse.Query(Specialties);
        specialtyQueryAr.matches("nameAr", searchPattern);

        const specialtyQueryCombined = Parse.Query.or(specialtyQueryEn, specialtyQueryAr);
        const specialties = await specialtyQueryCombined.find({ sessionToken: user.getSessionToken() });

        console.log(`DEBUG: Found ${specialties.length} specialty records for "${cleanedSpecialty}"`);
        specialties.forEach(s => console.log(`   - Found Spec: ${s.get("nameEn")} / ${s.get("nameAr")} (${s.id})`));

        if (specialties.length > 0) {
            const specialtyIds = specialties.map(s => s.id);
            query.containedIn("specialtyUid", specialtyIds);
        } else {
            return [];
        }

        // Apply Gender Filter if present
        if (params.gender) {
            const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
            const doctorQuery = new Parse.Query(Doctors);

            // "Female" -> matches "Female", "female"
            // "Male" -> matches "Male", "male"
            const safeGender = escapeRegex(params.gender);
            const genderPattern = new RegExp(`^${safeGender}`, 'i');
            doctorQuery.matches("gender", genderPattern);

            const doctors = await doctorQuery.find({ sessionToken: user.getSessionToken() });

            if (doctors.length > 0) {
                const doctorUids = doctors.map(d => d.get("uid"));
                query.containedIn("doctorUid", doctorUids);
                console.log(`⚧ Gender filter applied: ${params.gender} -> Found ${doctors.length} matching doctors.`);
            } else {
                console.log(`⚠ No doctors found for gender: ${params.gender}. Returning empty.`);
                return [];
            }
        }

        if (params.hospitalName) {
            const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);

            const cleanedHospital = cleanSearchTerm(params.hospitalName);

            const safeName = escapeRegex(cleanedHospital);
            const hospitalPattern = new RegExp(safeName, 'i');

            // Search in BOTH nameEn and nameAr
            const hospitalQueryEn = new Parse.Query(Hospitals);
            hospitalQueryEn.matches("nameEn", hospitalPattern);

            const hospitalQueryAr = new Parse.Query(Hospitals);
            hospitalQueryAr.matches("nameAr", hospitalPattern);

            const hospitalQuery = Parse.Query.or(hospitalQueryEn, hospitalQueryAr);
            const hospitals = await hospitalQuery.find({ sessionToken: user.getSessionToken() });

            if (hospitals.length > 0) {
                const hospitalUids = hospitals.map(h => h.get("uid"));
                query.containedIn("hospitalUid", hospitalUids);
            } else {
                return [];
            }
        }
    } else if (queryType === "specialtiesAtHospital" && params.hospitalName) {
        const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);

        const cleanedHospital = cleanSearchTerm(params.hospitalName);

        const safe = escapeRegex(cleanedHospital);
        const searchPattern = new RegExp(safe, 'i');

        // Search in BOTH nameEn and nameAr
        const hospitalQueryEn = new Parse.Query(Hospitals);
        hospitalQueryEn.matches("nameEn", searchPattern);

        const hospitalQueryAr = new Parse.Query(Hospitals);
        hospitalQueryAr.matches("nameAr", searchPattern);

        const hospitalQuery = Parse.Query.or(hospitalQueryEn, hospitalQueryAr);
        const hospitals = await hospitalQuery.find({ sessionToken: user.getSessionToken() });

        if (hospitals.length > 0) {
            const hospitalUids = hospitals.map(h => h.get("uid"));
            query.containedIn("hospitalUid", hospitalUids);
        } else {
            return [];
        }
    } else if (queryType === "specialtiesForDoctor" && params.doctorName) {
        const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
        const doctorQuery = new Parse.Query(Doctors);

        const cleanedDoctor = cleanSearchTerm(params.doctorName);
        console.log(`🧹 Cleaned doctor name: "${params.doctorName}" -> "${cleanedDoctor}"`);

        const safe = escapeRegex(cleanedDoctor);
        const searchPattern = new RegExp(safe, 'i');
        doctorQuery.matches("fullname", searchPattern);
        const doctors = await doctorQuery.find({ sessionToken: user.getSessionToken() });

        if (doctors.length > 0) {
            const doctorUids = doctors.map(d => d.get("uid"));
            query.containedIn("doctorUid", doctorUids);
        } else {
            return [];
        }
    } else if (queryType === "specialtiesComparison" && params.doctor1Name && params.doctor2Name) {
        // Handle comparison of two doctors
        const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);

        // Find Doctor 1
        const doctor1Query = new Parse.Query(Doctors);
        const cleaned1 = cleanSearchTerm(params.doctor1Name);
        const safe1 = escapeRegex(cleaned1);
        doctor1Query.matches("fullname", new RegExp(safe1, 'i'));
        const doctors1 = await doctor1Query.find({ sessionToken: user.getSessionToken() });

        // Find Doctor 2
        const doctor2Query = new Parse.Query(Doctors);
        const cleaned2 = cleanSearchTerm(params.doctor2Name);
        const safe2 = escapeRegex(cleaned2);
        doctor2Query.matches("fullname", new RegExp(safe2, 'i'));
        const doctors2 = await doctor2Query.find({ sessionToken: user.getSessionToken() });

        if (doctors1.length === 0 && doctors2.length === 0) return [];

        const doctorUids = [];
        if (doctors1.length > 0) doctorUids.push(...doctors1.map(d => d.get("uid")));
        if (doctors2.length > 0) doctorUids.push(...doctors2.map(d => d.get("uid")));

        query.containedIn("doctorUid", doctorUids);
    } else if (queryType === "checkDoctorAtHospital" && params.doctorName && params.hospitalName) {
        // 1. Find Doctor
        const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
        const docQuery = new Parse.Query(Doctors);
        docQuery.matches("fullname", new RegExp(escapeRegex(cleanSearchTerm(params.doctorName)), 'i'));
        const doctors = await docQuery.find({ sessionToken: user.getSessionToken() });
        if (doctors.length === 0) return [`Verification Result: Doctor "${params.doctorName}" NOT FOUND in database.`];

        // 2. Find Hospital
        const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);
        const hospQuery = new Parse.Query(Hospitals);
        const hospPattern = new RegExp(escapeRegex(cleanSearchTerm(params.hospitalName)), 'i');
        const hospQueryEn = new Parse.Query(Hospitals).matches("nameEn", hospPattern);
        const hospQueryAr = new Parse.Query(Hospitals).matches("nameAr", hospPattern);
        const hospitals = await Parse.Query.or(hospQueryEn, hospQueryAr).find({ sessionToken: user.getSessionToken() });
        if (hospitals.length === 0) return [`Verification Result: Hospital "${params.hospitalName}" NOT FOUND in database.`];

        // 3. Check Relationship
        const relQuery = new Parse.Query(HospitalDoctorSpecialty);
        relQuery.containedIn("doctorUid", doctors.map(d => d.get("uid")));
        relQuery.containedIn("hospitalUid", hospitals.map(h => h.get("uid")));
        relQuery.include(["doctorDetails", "hospitalDetails"]);

        const rels = await relQuery.find({ sessionToken: user.getSessionToken() });

        if (rels.length > 0) {
            const dName = rels[0].get("doctorDetails").get("fullname");
            const hName = rels[0].get("hospitalDetails").get("nameEn");
            return [`VERIFIED: YES. Dr. ${dName} WORKS at ${hName}.`];
        } else {
            return [`VERIFIED: NO. No record found linking Dr. ${params.doctorName} to ${params.hospitalName}.`];
        }

    } else if (queryType === "checkDoctorSpecialty" && params.doctorName && params.specialtyName) {
        // 1. Find Doctor
        const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
        const docQuery = new Parse.Query(Doctors);
        docQuery.matches("fullname", new RegExp(escapeRegex(cleanSearchTerm(params.doctorName)), 'i'));
        const doctors = await docQuery.find({ sessionToken: user.getSessionToken() });
        if (doctors.length === 0) return [`Verification Result: Doctor "${params.doctorName}" NOT FOUND in database.`];

        // 2. Find Specialty
        const Specialties = Parse.Object.extend(PARSE_CLASS_SPECIALTIES);
        const specQuery = new Parse.Query(Specialties);
        // Map Arabic if needed or rely on regex
        const specPattern = new RegExp(escapeRegex(cleanSearchTerm(params.specialtyName)), 'i');
        const specQueryEn = new Parse.Query(Specialties).matches("nameEn", specPattern);
        const specQueryAr = new Parse.Query(Specialties).matches("nameAr", specPattern);
        const specialties = await Parse.Query.or(specQueryEn, specQueryAr).find({ sessionToken: user.getSessionToken() });

        if (specialties.length === 0) return [`Verification Result: Specialty "${params.specialtyName}" NOT FOUND in database.`];

        // 3. Check Relationship
        const relQuery = new Parse.Query(HospitalDoctorSpecialty);
        relQuery.containedIn("doctorUid", doctors.map(d => d.get("uid")));
        relQuery.containedIn("specialtyUid", specialties.map(s => s.id));
        relQuery.include(["doctorDetails", "specialtyDetails"]);

        const rels = await relQuery.find({ sessionToken: user.getSessionToken() });

        if (rels.length > 0) {
            const dName = rels[0].get("doctorDetails").get("fullname");
            const sName = rels[0].get("specialtyDetails").get("nameEn");
            return [`VERIFIED: YES. Dr. ${dName} is a specialist in ${sName}.`];
        } else {
            return [`VERIFIED: NO. No record found linking Dr. ${params.doctorName} to specialty ${params.specialtyName}.`];
        }

    } else if (queryType === "allDoctors") {
        // Fetch all doctors (relationships)
        console.log("🔍 Fetching ALL doctors with relationships...");
        query.limit(100);
    } else {
        console.warn(`⚠ executeRelationshipQuery: No matching queryType block for "${queryType}" or missing params.`);
        return [];
    }

    const results = await query.find({ sessionToken: user.getSessionToken() });

    if (!results.length) return [];

    // Special handling for specialtiesForDoctor - return unique specialties
    if (queryType === "specialtiesForDoctor") {
        const specialtiesMap = new Map();
        results.forEach(obj => {
            const specialty = obj.get("specialtyDetails");
            if (specialty) {
                const specialtyId = specialty.id;
                if (!specialtiesMap.has(specialtyId)) {
                    specialtiesMap.set(specialtyId, {
                        name: specialty.get("nameEn") || "Unknown",
                        nameAr: specialty.get("nameAr") || "Unknown"
                    });
                }
            }
        });

        return Array.from(specialtiesMap.values()).map(spec => `
Specialty: ${spec.name}
Arabic Name: ${fixEncoding(spec.nameAr)}
        `.trim());
    }

    console.log("----------------results---------------- ");
    console.log(results);
    console.log("----------------results---------------- ");

    const formattedResults = await Promise.all(
        results.map(async (obj) => {
            const doctorPtr = obj.get("doctorDetails");
            const hospitalPtr = obj.get("hospitalDetails");
            const specialtyPtr = obj.get("specialtyDetails");

            // Safely fetch pointers
            const doctor = await safeFetch(doctorPtr, user);
            const hospital = await safeFetch(hospitalPtr, user);
            const specialty = await safeFetch(specialtyPtr, user);

            // Skip entirely if none of the main details exist
            if (!doctor && !hospital && !specialty) return null;

            return `
Doctor: ${doctor ? doctor.get("fullname") : "Unknown"}
Doctor (Ar): ${doctor ? fixEncoding(doctor.get("fullnameAr") || "") : ""}
Hospital: ${hospital ? hospital.get("nameEn") : "Unknown"}
Hospital (Ar): ${hospital ? fixEncoding(hospital.get("nameAr") || "") : ""}
Specialty: ${specialty ? specialty.get("nameEn") : "Unknown"}
Specialty (Ar): ${specialty ? fixEncoding(specialty.get("nameAr") || "") : ""}
Doctor Title: ${doctor ? doctor.get("title") : "Unknown"}
Hospital Address: ${hospital ? hospital.get("addressEn") : "Unknown"}
        `.trim();
        })
    );

    // Remove null entries (items where everything was missing)
    const cleanedResults = formattedResults.filter(item => item !== null);

    console.log(cleanedResults);

    return cleanedResults;

}




// -----------------------------------------
// IMPROVED VECTOR SEARCH
// -----------------------------------------

async function performVectorSearch(query, collection, limit = 5, scoreThreshold = 0.5) {
    console.log(`🔍 Performing vector search on ${collection} for query: ${query}`);

    // Generate embedding for the query
    const vector = await embed(query);
    // console.log(`🔍 query Vector: ${vector}`);

    // Search with higher limit to get more candidates
    const results = await qdrant.search(collection, {
        vector,
        limit: limit * 2,  // Get more results for filtering
        score_threshold: scoreThreshold,  // Only get results above threshold
    });

    // Filter and deduplicate results
    const seen = new Set();
    const filtered = results
        .filter(r => {
            if (!r.payload || !r.payload.parse_id) return true; // keep if no id to be safe
            const id = r.payload.parse_id;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .slice(0, limit);  // Take top N after deduplication

    console.log(`📊 Vector search found ${filtered.length} unique results (score threshold: ${scoreThreshold})`);

    filtered.forEach((r, i) => {
        console.log(` ${fixEncoding(r.payload.text)} ➤ Result ${i + 1}: Similarity ${(r.score * 100).toFixed(2)}%`);
    });

    return filtered.map(r => r.payload.text);
}

async function extractEntityFromContext(question, contextChunks) {

    if (!contextChunks || contextChunks.length === 0) return null;

    const context = contextChunks.slice(0, 3).join("\n");

    const prompt = `
You are an intelligent assistant. The user asked a question, and we found some text snippets.
Analyze the snippets to see if they refer to a SPECIFIC Hospital, Doctor, or Specialty that matches the user's intent.
If yes, extract the name to query the database for structured details (like address, phone, rating).

User Question: "${question}"

Text Snippets:
${context}

Output JSON ONLY:
{
  "found": boolean,
  "entity": "HOSPITALS" or "DOCTORS" or "SPECIALTIES",
  "params": { 
    "field": "nameEn" (for hospitals/specialties) or "fullname" (for doctors) - OR "nameAr"/"fullnameAr" if in Arabic, 
    "value": "extracted name" 
  }
}
If no specific entity is found, set "found": false.
`.trim();

    try {
        const response = await ollama.generate({
            model: LLM_MODEL,
            prompt,
            format: "json",
            stream: false
        });
        const result = JSON.parse(fixEncoding(response.response));
        return result.found ? result : null;
    } catch (e) {
        console.error("Entity Extraction Error:", e);
        return null;
    }
}

async function validateSpecialtyMatch(original, candidate) {
    if (!original) return true; // No original to contradict
    if (!candidate) return false;

    const prompt = `
You are a strict medical semantics validator. Your goal is to ensure that a "Candidate" term is a valid medical match for an "Original" search term.

Original Term: "${original}"
Candidate Match: "${candidate}"

VALID MATCH RULES:
1. Synonym: The terms mean the same thing (e.g., "Kids Doctor" == "Pediatrics").
2. Translation: One is the translation of the other (e.g., "أسنان" == "Dentistry").
3. Symptom-to-Specialty: The candidate is the correct specialty for the symptom described in original (e.g., "Stomach pain" -> "Gastroenterology").
4. Specificity: The candidate is a more specific form of the original (e.g., "Surgeon" -> "General Surgery").

INVALID MATCH RULES:
1. Contradiction: The terms refer to completely different body systems (e.g., "Heart" vs "Dermatology").
2. Unrelated: The candidate is a hospital name or location, not a specialty for the symptom.

EXAMPLES:
- "Dentistry" vs "Dental Care" -> {"valid": true}
- "طب اسنان" vs "Dentistry" -> {"valid": true}
- "Gastroenterology" vs "Psychiatry" -> {"valid": false}
- "Stomach Pain" vs "Gastroenterology" -> {"valid": true}
- "Heart" vs "Cardiology" -> {"valid": true}
- "عظام" vs "Orthopedics" -> {"valid": true}
- "Skin rash" vs "Dermatology" -> {"valid": true}
- "Eye doctor" vs "Ophthalmology" -> {"valid": true}

Task: Determine if "Candidate" is a valid match for "Original".

Output JSON ONLY:
{ "valid": boolean }
`.trim();

    try {
        const response = await ollama.generate({
            model: LLM_MODEL,
            prompt,
            format: "json",
            stream: false
        });
        const result = JSON.parse(response.response);
        return result.valid;
    } catch (e) {
        console.error("Validation Error:", e);
        return false; // Fail safe
    }



}

async function optimizeVectorSearchStrategy(query) {
    const prompt = `
You are a vector search optimizer for a medical database.

Collections:
1. hospitals_docs: Hospital names, addresses, facilities, types.
2. doctors_docs: Doctor names, titles, qualifications, languages.
3. specialties_docs: Medical specialties, disease names, symptoms, treatments.

User Query: "${query}"

Rules:
1. Detect the language of the User Query automatically.
2. DO NOT translate the query.
3. The optimizedQuery MUST remain in the same language as the input.
4. Remove stop words ONLY for that language (e.g., Arabic or English).
5. Keep only medically relevant keywords (symptoms, diseases, specialties, doctor/hospital indicators).
6. Do NOT add new terms that were not mentioned by the user.
7. Keep the query short and suitable for vector similarity search.

Task:
1. Select the ONE best collection:
   - Disease, symptom, treatment → specialties_docs
   - Doctor name, title, language → doctors_docs
   - Hospital name, facility, location → hospitals_docs

Output JSON ONLY:
{
  "collection": "hospitals_docs" | "doctors_docs" | "specialties_docs",
  "optimizedQuery": "string"
}
`.trim();

    try {
        const response = await ollama.generate({
            model: LLM_MODEL,
            prompt,
            format: "json",
            stream: false
        });
        const result = JSON.parse(response.response);
        console.log(`🧠 Vector Strategy: Collection=${result.collection}, Query="${result.optimizedQuery}"`);
        return result;
    } catch (e) {
        console.error("Optimization Error:", e);
        return { collection: "hospitals_docs", optimizedQuery: query };
    }
}


async function generateAIResponse(question, contextText) {
    if (!contextText) {
        return "I couldn't find related information.";
    }

    const prompt = `
You are a helpful medical information assistant. Answer the user's question using ONLY the context provided below.

STRICT INSTRUCTIONS:
- You DO NOT have access to the internet or outside knowledge.
- You MUST answer ONLY using the provided CONTEXT. 
- If the answer is not in the CONTEXT, you MUST say "I could not find this information in the database".
- DO NOT halllucinate or invent information.

Database Structure Context: 
The system is built on a relational model where Doctors are linked to Hospitals and Specialties via a central 'HospitalDoctorSpecialty' table.

IMPORTANT RULES:
1. CRITICAL: List ALL items from the context. If there are 25 doctors in the context, you MUST list all 25.
2. DO NOT SUMMARIZE. DO NOT TRUNCATE.
3. LANGUAGE RULES:
   - If the user's question is in Arabic, respond in Arabic
   - Use ONLY one language for names (prefer Arabic if available in 'Name (Ar)')
4. FORMATTING RULES:
   - Use a simple list format: "- [Name] - [Specialty] - [Hospital]"
5. NAME ACCURACY:
   - COPY names EXACTLY. Do NOT translate or transliterate.

CONTEXT:
${contextText}

QUESTION:
${question}

ANSWER:
  `.trim();

    try {
        const response = await ollama.generate({
            model: LLM_MODEL,
            prompt: prompt,
            options: {
                num_ctx: 8192,
                num_predict: -1
            }
        });

        const rawAnswer = response.response;

        // Logic to fix encoding
        const hasMojibake = /[\u00D8-\u00DB]/.test(rawAnswer);

        if (hasMojibake) {
            console.log("🔧 Detected encoding issue (Mojibake), attempting to fix...");
            return fixEncoding(rawAnswer);
        }

        return rawAnswer;
    } catch (e) {
        console.error("Generation Error:", e);
        return "I'm sorry, I encountered an error providing the answer.";
    }
}

async function ragAnswer(question, user) {

    const route = await determineSearchMethod(question);
    let contextText = "";
    let vectorResults = [];
    let parseResults = []; // Lifted scope
    let specialtyRefinedFromVector = false; // Track if we already refined specialty from vector

    const entity = route.entity || "HOSPITALS";
    let collection;
    let parseQueryFn;

    if (entity === "DOCTORS") {
        collection = DOCTORS_COLLECTION;
        parseQueryFn = executeDoctorParseQuery;
    } else if (entity === "SPECIALTIES") {
        collection = SPECIALTIES_COLLECTION;
        parseQueryFn = executeSpecialtiesParseQuery;
    } else if (entity === "RELATIONSHIPS") {
        parseQueryFn = executeRelationshipQuery;
        // SMART COLLECTION SELECTION FOR RELATIONSHIPS
        // If searching for specialties, search the SPECIALTIES collection.
        // Otherwise default to HOSPITALS.
        if (route.params && (route.params.queryType === "specialistsAtHospital" || route.params.specialtyName)) {
            console.log("ℹ Switching Vector Search collection to SPECIALTIES_COLLECTION for better relevance.");
            collection = SPECIALTIES_COLLECTION;
        } else {
            collection = HOSPITALS_COLLECTION;
        }
    } else {
        collection = HOSPITALS_COLLECTION;
        parseQueryFn = executeHospitalParseQuery;
    }

    // Handle "combined" operation: Vector Search FIRST, then Parse Search
    if (route.operation === "combined") {
        console.log("🔄 Operation: COMBINED (Vector + Parse)");

        // Use LLM to decide collection and optimize query
        const strategy = await optimizeVectorSearchStrategy(question);

        let targetCollection = strategy.collection;
        // Map simplified names to actual constants if needed (Though prompt uses actual names)
        if (![HOSPITALS_COLLECTION, DOCTORS_COLLECTION, SPECIALTIES_COLLECTION].includes(targetCollection)) {
            // Fallback if LLM hallucinates a name
            if (targetCollection.includes("doctor")) targetCollection = DOCTORS_COLLECTION;
            else if (targetCollection.includes("special")) targetCollection = SPECIALTIES_COLLECTION;
            else targetCollection = HOSPITALS_COLLECTION;
        }

        console.log(`🎯 Targeted Vector Search: "${fixEncoding(strategy.optimizedQuery)}" in [${fixEncoding(targetCollection)}]`);


        // 1. Vector Search for symptoms/general info
        vectorResults = await performVectorSearch(fixEncoding(strategy.optimizedQuery), fixEncoding(targetCollection), 5, 0.4);
        // Store vector results temporarily but don't add to context immediately

        // DYNAMIC UPDATE: Use vector results to refine Parse Search params
        // If vector search extracts a specialty name, validate it matches the question then use it
        if (route.params && route.params.queryType === "specialistsAtHospital") {
            console.log("🔄 Analyzing Vector results to refine Specialty Name...");
            const extraction = await extractEntityFromContext(question, vectorResults);

            if (extraction && extraction.found && extraction.entity === "SPECIALTIES" && extraction.params.value) {
                const extractedValue = extraction.params.value;

                // Validate that extracted specialty makes sense for the question
                const isValidForQuestion = await validateSpecialtyMatch(question, extractedValue);

                if (isValidForQuestion) {
                    console.log(`✨ UPDATING specialtyName from Vector: "${route.params.specialtyName}" -> "${extractedValue}"`);
                    route.params.specialtyName = extractedValue;
                    specialtyRefinedFromVector = true;
                } else {
                    console.log(`⚠ Vector extracted "${extractedValue}" but it doesn't match question meaning. Keeping original.`);
                }
            } else {
                console.log("⚠ Vector extraction did not find a valid specialty. Keeping original params.");
            }
        }

        // 2. Parse Search for specific entities (Doctors/Hospitals)
        if (route.params) {
            parseResults = await parseQueryFn(route.params, user);
            if (parseResults.length > 0) {
                contextText += `=== RELEVANT ENTITIES (Matched Database Records) ===\n[TOTAL RESULTS: ${parseResults.length} - You MUST list all ${parseResults.length} items]\n` + parseResults.join("\n---\n");
                console.log(`✅ Using ${parseResults.length} structured records. Ignoring vector noise.`);
            } else {
                // Only use vector text if we have no structured results
                if (vectorResults.length > 0) {
                    contextText += "=== MEDICAL INFO ===\n" + vectorResults.join("\n---\n") + "\n\n";
                }
            }
        }
    }
    // Handle "parse_search"
    else if (route.operation === "parse_search") {
        console.log("🔄 Operation: PARSE SEARCH");
        parseResults = await parseQueryFn(route.params, user);
        if (parseResults.length > 0) {
            contextText = `[TOTAL RESULTS: ${parseResults.length} - You MUST list   ${parseResults.length} items]  without translation errors just list COPY EXACTLY as it is \n\n` + parseResults.join("\n---\n");
            console.log(`✅ Parse search returned ${parseResults.length} results`);
            if (parseResults.length < 6) {
                console.log("----------------contextText---------------- ");
                console.log(contextText);
                console.log("----------------contextText---------------- ");
            }
        } else {
            console.log(`⚠ ${entity} Parse search returned no results, falling back to Vector.`);
            // Fallback to Vector
            if (entity !== "RELATIONSHIPS") {
                vectorResults = await performVectorSearch(route.params.value, collection, 5, 0.4);
                if (vectorResults.length > 0) {
                    contextText = vectorResults.join("\n---\n");
                }
            }
        }
    }
    // Handle "vector_search"
    // Handle "vector_search"
    else {
        console.log("🔄 Operation: VECTOR SEARCH");

        // Use LLM to decide collection and optimize query
        const strategy = await optimizeVectorSearchStrategy(question);

        let targetCollection = strategy.collection;
        // Map simplified names to actual constants if needed (Though prompt uses actual names)
        if (![HOSPITALS_COLLECTION, DOCTORS_COLLECTION, SPECIALTIES_COLLECTION].includes(targetCollection)) {
            // Fallback if LLM hallucinates a name
            if (targetCollection.includes("doctor")) targetCollection = DOCTORS_COLLECTION;
            else if (targetCollection.includes("special")) targetCollection = SPECIALTIES_COLLECTION;
            else targetCollection = HOSPITALS_COLLECTION;
        }

        console.log(`🎯 Targeted Vector Search: "${strategy.optimizedQuery}" in [${targetCollection}]`);

        vectorResults = await performVectorSearch(strategy.optimizedQuery, targetCollection, 5, 0.4);

        if (vectorResults.length === 0) {
            console.log(`⚠ No results with optimized query, trying raw query on all collections...`);
            const collectionsToSearch = [HOSPITALS_COLLECTION, DOCTORS_COLLECTION, SPECIALTIES_COLLECTION];
            const searchPromises = collectionsToSearch.map(col => performVectorSearch(question, col, 3, 0.4));
            const allResults = await Promise.all(searchPromises);
            vectorResults = allResults.flat();
        }

        if (vectorResults.length > 0) {
            contextText = vectorResults.join("\n---\n");
        }
    }

    // Enrichment Logic (if follow_up is true or we have vector results)
    if ((route.follow_up || vectorResults.length > 0) && route.operation !== "parse_search") {

        // 4. ENRICHMENT: Try to extract entities from vector context and query Parse
        console.log("🔄 Analyzing Vector results for structured data enrichment...");
        const extraction = await extractEntityFromContext(question, vectorResults);

        if (extraction && extraction.found) {
            console.log(`🎯 Extracted entity from context: ${extraction.entity} - ${extraction.params.value}`);
            let enrichFn;
            if (extraction.entity === "HOSPITALS") enrichFn = executeHospitalParseQuery;
            else if (extraction.entity === "DOCTORS") enrichFn = executeDoctorParseQuery;
            else if (extraction.entity === "SPECIALTIES") {
                // SMART ENRICHMENT: Only search for doctors in this new specialty if:
                // 1. The primary search yielded NO results (we need a fallback).
                // 2. OR the primary search wasn't about doctors to begin with.
                // 3. AND we haven't already refined the specialty from vector (to avoid corruption).
                const primarySearchFailed = !parseResults || parseResults.length === 0;

                if (entity === "RELATIONSHIPS" && primarySearchFailed && !specialtyRefinedFromVector) {
                    console.log("✨ Enrichment Strategy: Primary search empty. Found 'SPECIALTIES' in context, searching doctors for it.");
                    enrichFn = executeRelationshipQuery;
                    extraction.params.queryType = "specialistsAtHospital";
                    extraction.params.specialtyName = extraction.params.value;
                } else if (entity === "RELATIONSHIPS" && specialtyRefinedFromVector) {
                    console.log(`ℹ Enrichment: Skipping because we already refined specialty from vector to '${route.params.specialtyName}'. Not overriding with potentially corrupted extraction.`);
                    enrichFn = null;
                } else if (entity === "RELATIONSHIPS" && !primarySearchFailed) {
                    console.log(`ℹ Enrichment: Found specialty '${extraction.params.value}' but primary search already handled '${route.params.specialtyName}'. Skipping override.`);
                    enrichFn = null; // Do not distract
                } else {
                    enrichFn = executeSpecialtiesParseQuery;
                }
            }

            if (enrichFn) {
                const enrichResults = await enrichFn(extraction.params, user);
                if (enrichResults.length > 0) {
                    console.log(`✨ Enriched context with ${enrichResults.length} structured records.`);
                    // Prepend structured data to context
                    contextText = enrichResults.join("\n---\n") + "\n\n=== RELEVANT TEXT SNIPPETS ===\n" + contextText;
                }
            }
        }
    }

    return await generateAIResponse(question, contextText);
}
async function startServer() {
    console.log("=== Medical RAG Server ===");

    const user = await parseLogin();

    const wss = new WebSocketServer({ port: WS_PORT });

    wss.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`\n❌ Error: Port ${WS_PORT} is already in use!`);
            console.error(`\n💡 Solutions:`);
            console.error(`   1. Stop the existing server first:`);
            console.error(`      netstat -ano | findstr :${WS_PORT}`);
            console.error(`      taskkill /F /PID <PID>`);
            console.error(`\n   2. Or change WS_PORT in server.js to a different port\n`);
            process.exit(1);
        } else {
            console.error('WebSocket Server Error:', error);
            process.exit(1);
        }
    });

    console.log(`\n✔ WebSocket server running on ws://localhost:${WS_PORT}`);
    console.log(`✔ Open index.html in your browser to use the UI\n`);

    wss.on('connection', (ws) => {
        console.log('Client connected');

        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data);

                if (message.type === 'question') {
                    console.log(`\n📩 Question: ${message.message}`);

                    const answer = await ragAnswer(message.message, user);

                    console.log(`📤 Answer: ${answer.substring(0, 100)}...\n`);

                    ws.send(JSON.stringify({
                        type: 'answer',
                        message: answer
                    }));
                }
            } catch (error) {
                console.error('Error processing message:', error);
                ws.send(JSON.stringify({
                    type: 'error',
                    message: error.message
                }));
            }
        });

        ws.on('close', () => {
            console.log('Client disconnected');
        });
    });
}

startServer();
