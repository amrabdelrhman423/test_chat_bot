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
import fetch, { Headers, Request, Response } from 'node-fetch';
import Parse from "parse/node.js";
import ollama from "ollama";
import { HfInference } from '@huggingface/inference';
import { pipeline } from '@xenova/transformers';

// Polyfills for Node.js < 18
global.fetch = fetch;
global.Headers = Headers;
global.Request = Request;
global.Response = Response;
import { QdrantClient } from "@qdrant/js-client-rest";
import { Client } from "@opensearch-project/opensearch"; // Added OpenSearch
import { randomUUID } from "crypto";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

globalThis.fetch = fetch;
globalThis.FormData = FormData;
global.Headers = Headers;
global.Request = Request;
global.Response = Response;

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
const PARSE_CLASS_CITIES = "Cities";
const PARSE_CLASS_AREAS = "Areas";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const OPENSEARCH_NODE = process.env.OPENSEARCH_NODE || "https://localhost:9200";
const OPENSEARCH_USERNAME = process.env.OPENSEARCH_USERNAME || "admin";
const OPENSEARCH_PASSWORD = process.env.OPENSEARCH_PASSWORD || "admin";
const OPENSEARCH_SSL_INSECURE = process.env.OPENSEARCH_SSL_INSECURE || "true";

const HOSPITALS_COLLECTION = "hospitals_docs";
const DOCTORS_COLLECTION = "doctors_docs";
const SPECIALTIES_COLLECTION = "specialties_docs";
const CITIES_COLLECTION = "cities_docs";
const AREAS_COLLECTION = "areas_docs";

const EMBED_MODEL = "jinaai/jina-embeddings-v3";
const HF_TOKEN = process.env.HF_TOKEN;
const hf = new HfInference(HF_TOKEN);
const LLM_MODEL = process.env.LLM_MODEL || "llama3.1";

// -----------------------------------------
// INIT PARSE
// -----------------------------------------
Parse.initialize(PARSE_APP_ID);
Parse.serverURL = PARSE_URL;
Parse.CoreManager.set('REQUEST_HEADERS', {
  "Content-Type": "application/json; charset=utf-8"
});

function fixEncoding(str) {
  // ... existing fixEncoding code ...
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

// -----------------------------------------
// HELPER: ARABIC NORMALIZER
// -----------------------------------------
function normalizeArabicMedical(text) {
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

async function parseLogin() {
  try {
    const user = await Parse.User.logIn(PARSE_USERNAME, PARSE_PASSWORD);
    console.log("✔ Logged in as:", user.get("username"));
    return user;
  } catch (error) {
    console.error("❌ Parse Login Error:", error.message);
    // process.exit(1);
  }
}

// -----------------------------------------
// INIT CLIENTS
// -----------------------------------------
const qdrant = new QdrantClient({ url: QDRANT_URL });
const clientOS = new Client({
  node: OPENSEARCH_NODE,
  auth: {
    username: OPENSEARCH_USERNAME,
    password: OPENSEARCH_PASSWORD,
  },
  ssl: {
    rejectUnauthorized: OPENSEARCH_SSL_INSECURE !== "true",
  },
});

let localEmbedder = null;

async function embed(text, task = "retrieval.query") {
  // 1. Try Local Jina v3 FastAPI Server
  try {
    console.log(`🔍 Generating Jina v3 embedding (1024 dims) via LOCAL SERVER for: "${text.substring(0, 30)}..."`);
    const response = await fetch("http://localhost:8000/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: text, task: task })
    });

    if (response.ok) {
      const result = await response.json();
      if (result.data && result.data[0].embedding) {
        const vector = result.data[0].embedding;
        if (vector.length !== 1024) {
          console.warn(`⚠️ Local Jina server returned ${vector.length} dims, expected 1024!`);
        }
        return vector;
      }
    }
    console.warn("⚠️ Local Jina server returned error or invalid format, trying HF...");
  } catch (err) {
    console.warn("⚠️ Local Jina server unreachable, trying HF...");
  }

  try {
    // 2. Try Jina v3 via Hugging Face SDK
    console.log(`🔍 Generating Jina v3 embedding (1024 dims) via HF SDK for: "${text.substring(0, 30)}..."`);
    const result = await hf.featureExtraction({
      model: EMBED_MODEL,
      inputs: text,
      parameters: { task: task }
    });

    // HF SDK handles different return formats
    if (Array.isArray(result)) return result;
    if (result.data) return result.data;
    return result;

  } catch (error) {
    console.warn("⚠️ Jina v3 SDK failed, falling back to local 768 model:", error.message);

    // 3. Fallback to Local Multilingual Model (768 dims)
    try {
      if (!localEmbedder) {
        const LOCAL_MODEL = "Xenova/paraphrase-multilingual-mpnet-base-v2";
        localEmbedder = await pipeline('feature-extraction', LOCAL_MODEL);
      }
      const output = await localEmbedder(text, { pooling: 'mean', normalize: true });
      return Array.from(output.data);
    } catch (localErr) {
      console.error("❌ All embedding methods failed:", localErr.message);
      throw localErr;
    }
  }
}

// -----------------------------------------
// ROUTER & PARSE SEARCH
// -----------------------------------------

// ... schema loading ...

function loadSchema() {
  // ...
  // No change needed here, just keeping context for tool

  try {
    const schemaPath = path.join(__dirname, 'schema.json');
    if (!fs.existsSync(schemaPath)) {
      console.warn("⚠ schema.json not found, skipping schema injection.");
      return "";
    }
    const schemaRaw = fs.readFileSync(schemaPath, 'utf8');
    const schemaJson = JSON.parse(schemaRaw);

    const targetClasses = ["Hospitals", "Doctors", "Specialties", "HospitalDoctorSpecialty", "Cities", "Areas"];
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

  const prompt = `
You are a medical query router for a healthcare assistant.

Your job:
1. Understand the user's intent.
2. Decide which backend operation(s) are needed.
3. Always return a structured JSON response with:
   - "operation" (one of: "vector_search", "parse_search", "combined")
   - "query" (the clean search phrase)
   - "follow_up" (true/false if doctors/hospitals should be suggested)
   - "entity" (if parse_search or combined: "HOSPITALS", "DOCTORS", "SPECIALTIES", "RELATIONSHIPS")
   - "params" (if parse_search or combined: the filter parameters)

----------------------
ROUTING RULES
----------------------

1. If the user asks about:
   - Symptoms, Diseases, Causes, Treatment, Diagnosis, Side effects
   - "What is this condition?"
   - Pain in body part
   - أي أعراض لمرض
   - عندي وجع في …

→ Use: "operation": "vector_search"
Because these require deep semantic search inside medical knowledge.
Always set "follow_up": true so we suggest doctors/hospitals after.

----------------------

2. If the user asks about:
   - Hospitals, Doctors, Specialties, Clinics, Locations, Opening hours
   - مستشفى, دكتور, تخصص
   
   IMPORTANT DISTINCTION:
   - If asking about "doctors IN/AT a hospital" or "hospitals FOR a doctor" → Use entity: "RELATIONSHIPS" (see examples below)
   - If asking about a doctor's NAME, qualifications, or info → Use entity: "DOCTORS"
   - If asking about a hospital's NAME, address, or info → Use entity: "HOSPITALS"
   - If asking about a city or location info → Use entity: "CITIES"
   - If asking about a specific area or district info → Use entity: "AREAS"

→ Use: "operation": "parse_search"
You MUST also extract the "entity" and "params" following the schema below.

----------------------

3. If the user asks symptoms + where to go:
   Example: "عندي ألم في المعدة أروح أنهي دكتور؟" or "I have chest pain, what hospital should I go to?"
   IMPORTANT: Use "combined" ONLY when BOTH conditions are met:
   a) User mentions a SYMPTOM or MEDICAL CONDITION (pain, fever, disease, etc.)
   b) User asks WHERE to go or WHICH doctor/hospital

→ Use: "operation": "combined"
Meaning: Step1 vector search for symptoms, Step2 parse search to find suitable doctors/hospitals.
Set "follow_up": true.
You MUST also extract the "entity" and "params" for the Step 2 search.
IMPORTANT: Map the symptom to a medical specialty (e.g. "chest pain" -> "Cardiology") and use queryType: "specialistsAtHospital" with "specialtyName".
   - If the user ALSO mentions a specific hospital, you MUST include "hospitalName" in params.

ARABIC SPECIALTY MAPPING (Use these English names for "specialtyName"):
- "علاج الخصوبة", "تأخر الإنجاب", "حقن مجهري" -> "Infertility Treatment"
- "عيون", "رمد" -> "Ophthalmology"
- "قلب", "أوعية دموية" -> "Cardiology"
- "عظام" -> "Orthopedics"
- "أطفال" -> "Pediatrics"
- "جلدية" -> "Dermatology"
- "نساء وتوليد" -> "Obstetrics and Gynecology"
- "أسنان" -> "Dentistry"
- "نفسي" -> "Psychiatry"
- "مخ وأعصاب" -> "Neurology"
- "مناظير", "تنظير", "Endoscopy" -> "Endoscopy"

341. PRICE & COST RULES:
   - If the user asks for "price", "cost", "fees", "سعر", "بكام", "تكلفة" of a DOCTOR:
   - Entity: "RELATIONSHIPS"
   - Operation: "combined"
   - Params: { "queryType": "hospitalsForDoctor", "fullname": <FULL NAME STRING> }
   - Example: "سعر دكتورة فاطيمة حسن" -> params: { "queryType": "hospitalsForDoctor", "fullname": "فاطيمة حسن" }

342. LOCATION NULL RULE (CRITICAL):
   - If the user does NOT explicitly mention a city, area, or region, you MUST set 'location': null in the 'params' object.
   - If the user does NOT explicitly mention a city, area, or region, you MUST set 'location': null in the 'params' object.
   - NEVER guess or infer a location based on other context.

343. DOCTOR NAME NULL RULE:
   - If the user does NOT explicitly mention a specific doctor's name, 'doctorName' and 'fullname' MUST be null.
   - Do NOT infer a name from the hospital or specialty.

344. EXCLUSION/NEGATIVE RULE:
   - If the user uses "غير" (other than), "مش" (not), "other", "another", "change" followed by a name:
   - Extract that name into 'excludeFullname'.
   - Example: "غير دكتور المستقبل" -> params: { "excludeFullname": "المستقبل", "doctorName": null }

NOTE: If the user asks "doctors in [Hospital Name]" WITHOUT mentioning symptoms, use "parse_search" with "doctorsAtHospital", NOT "combined".
1. **RELATIONSHIPS RULE**:
   - IF entity = "RELATIONSHIPS"
   - THEN operation MUST be "combined"
   - AND follow_up MUST be true
   - (Exception: For "allDoctors", "allHospitals", "allSpecialties", "allCities", "allAreas", you MAY use operation: "parse_search" with follow_up: false)

----------------------

4. If user sends a long natural description:
   Example: "أنا بحس بصداع ودوخة وبطن بتوجعني"

→ Treat as symptoms → vector_search + follow_up = true

----------------------

5. If the user asks for "ALL doctors" or "list all doctors" or "عايز كل الدكاترة" or "Show me all doctors":
   - WARNING: Do NOT use this if the user names a specific doctor (e.g. "Dr. Ahmed"). In that case, use "hospitalsForDoctor".
   - NOTE: If the user asks for "ALL doctors" of a specific SPECIALTY, include "specialtyName".
   → Use: "operation": "parse_search"
   → entity: "RELATIONSHIPS"
   → params: { "queryType": "allDoctors" }

----------------------

----------------------

6. If the user asks for "ALL hospitals" or "list all hospitals" or "عايز كل المستشفيات" or "Show me all hospitals":
   → Use: "operation": "parse_search"
   → entity: "HOSPITALS"
   → params: { "queryType": "allHospitals" }

----------------------

7. If the user asks for "ALL specialties" or "list all specialties" or "عايز كل التخصصات" or "Show me all specialties":
   → Use: "operation": "parse_search"
   → entity: "SPECIALTIES"
   → params: { "queryType": "allSpecialties" }

----------------------

8. If the user asks to COMPARE two doctors:
   Example: "Compare Dr. Ahmed and Dr. Mohamed" or "قارن بين د. احمد و د. محمد"
   → Use: "operation": "parse_search"
   → entity: "RELATIONSHIPS"
   → params: { 
       "queryType": "specialtiesComparison",
       "doctor1Name": "<Name 1>",
       "doctor2Name": "<Name 2>"
     }

----------------------

DATABASE SCHEMA (For "params" extraction):
${schemaContext}

Schema for PARSE Params:
- entity: "HOSPITALS" or "DOCTORS" or "SPECIALTIES" or "RELATIONSHIPS" or "CITIES" or "AREAS"
- field: The database column to FILTER by. CHOOSE INTELLIGENTLY:
    - If user mentions LOCATION/ADDRESS keywords ("in Zamalek", "at Cairo", "في الزمالك", "address", "location", "area", "district", "city", "Alexandria"), use "addressEn" for hospitals.
    - CRITICAL: City names (Alexandria, Cairo, Giza, etc) ARE NOT hospital names. Use entity: "HOSPITALS" and field: "addressEn" for these.
    - If user asks for a SPECIFIC HOSPITAL BY NAME (e.g., Al-Amal, German):
        - If the name is in ARABIC (e.g., "حورس", "الألماني", "دار الفؤاد"), use "nameAr"
        - If the name is in ENGLISH (e.g., "German", "Horus"), use "nameEn"
    - If user asks for hospital TYPE ("specialized", "general"), use "hospitalType"
    - For doctors:
        - If the name is in ARABIC, use "fullnameAr"
        - If the name is in ENGLISH, use "fullname"
    - CRITICAL: If the user asks for an attribute (like description, address, phone) of a SPECIFIC named entity (e.g., "descAr for Hospital X"), you MUST filter by the NAME field ("nameEn"/"nameAr" for hospitals, "fullname"/"fullnameAr" for doctors), NOT the attribute field.
- For RELATIONSHIPS queryType:
    - "doctorsAtHospital": Use when user asks for "doctors in/at [Hospital]". If doctor is mentioned, MUST include "doctorName" AND "fullname".
    - "specialistsAtHospital": Use ONLY when user specifies BOTH a specialty AND a hospital (e.g., "cardiologists at Hospital X")
    - "hospitalsForDoctor": Use when user asks which hospitals a specific doctor works at OR Price. MUST include "doctorName" AND "fullname".
    - "specialtiesAtHospital": Use when user asks what specialties a hospital has
    - "specialtiesForDoctor": Use when user asks what specialties a doctor has
    - "specialtiesComparison": Use when user asks to compare two doctors
- value: <extracted name or pattern>. IMPORTANT: 
    - For hospital names, remove generic suffixes like 'Hospital', 'Center', 'Clinic', 'مستشفى' to improve partial matching (e.g., output "German" instead of "German Hospital").
    - Keep the value in its original language (Arabic or English) - DO NOT translate.
    - For addressEn searches: If the user provides an Arabic location name (e.g., "الزمالك"), transliterate it to English (e.g., "Zamalek") because the database stores addresses in English.

Language Detection:
- If the value is in Arabic, set "includeArabic": true in params.
- If the user uses Arabic keywords or asks for Arabic fields (nameAr, descAr, etc.), set "includeArabic": true.

----------------------
EXAMPLES
----------------------

Example 1 (Vector):
Query: "What are the symptoms of flu?"
Output: { "operation": "vector_search", "query": "symptoms of flu", "follow_up": true }

Example 2 (Parse - English name):
Query: "Where is Dar Al Fouad Hospital?"
Output: { "operation": "parse_search", "query": "Dar Al Fouad Hospital", "follow_up": false, "entity": "HOSPITALS", "params": { "field": "nameEn", "value": "Dar Al Fouad" } }

Example 2b (Parse - Arabic name):
Query: "فين مستشفى حورس"
Output: { "operation": "parse_search", "query": "مستشفى حورس", "follow_up": false, "entity": "HOSPITALS", "params": { "field": "nameAr", "value": "حورس", "includeArabic": true } }

Example 3 (Combined):
Query: "I have heart pain, which doctor should I see?"
Output: { "operation": "combined", "query": "heart pain doctor", "follow_up": true, "entity": "RELATIONSHIPS", "params": { "queryType": "specialistsAtHospital", "specialtyName": "Cardiology" } }

Example 4 (Parse Relationship):
Query: "Doctors in Ain Shams Hospital"
Output: { "operation": "parse_search", "query": "Doctors in Ain Shams Hospital", "follow_up": false, "entity": "RELATIONSHIPS", "params": { "queryType": "doctorsAtHospital", "hospitalName": "Ain Shams" } }

Example 4b (Parse Relationship - doctors work in):
Query: "doctors work in Horus hospital"
Output: { "operation": "parse_search", "query": "doctors in Horus hospital", "follow_up": false, "entity": "RELATIONSHIPS", "params": { "queryType": "doctorsAtHospital", "hospitalName": "Horus" } }

Example 4c (Parse Relationship - list doctors):
Query: "list doctors who work at German Hospital"
Output: { "operation": "parse_search", "query": "doctors at German Hospital", "follow_up": false, "entity": "RELATIONSHIPS", "params": { "queryType": "doctorsAtHospital", "hospitalName": "German" } }

Example 4d (Parse Relationship - Arabic):
Query: "ممكن تجبلي الدكاترة في مستشفي الالمانيا"
Output: { "operation": "parse_search", "query": "doctors in الالمانيا Hospital", "follow_up": false, "entity": "RELATIONSHIPS", "params": { "queryType": "doctorsAtHospital", "hospitalName": "الالمانيا", "includeArabic": true } }

IMPORTANT: When the user provides a name in Arabic (e.g., "روفيدة", "الالماني", "دار الفؤاد"), DO NOT translate it. Keep the Arabic name as-is in hospitalName/doctorName and set "includeArabic": true.

Example 4e (Parse Relationship - Doctor Specialties):
Query: "What are the specialties for Dr. Mahmoud Salah?"
Output: { "operation": "parse_search", "query": "specialties for Dr. Mahmoud Salah", "follow_up": false, "entity": "RELATIONSHIPS", "params": { "queryType": "specialtiesForDoctor", "doctorName": "Mahmoud Salah" } }

Example 5 (Vector):
Query: "Best treatment for headache"
Output: { "operation": "vector_search", "query": "treatment for headache", "follow_up": true }

Example 6 (Parse - Address Search):
Query: "I want hospital in Zamalek address"
Output: { "operation": "parse_search", "query": "hospital in Zamalek", "follow_up": false, "entity": "HOSPITALS", "params": { "field": "addressEn", "value": "Zamalek" } }

Example 7 (Parse - Address Search Arabic):
Query: "مستشفى في الزمالك"
Output: { "operation": "parse_search", "query": "hospital in Zamalek", "follow_up": false, "entity": "HOSPITALS", "params": { "field": "addressEn", "value": "Zamalek", "includeArabic": true } }

Example 8 (Parse - Hospital Type):
Query: "specialized hospitals"
Output: { "operation": "parse_search", "query": "specialized hospitals", "follow_up": false, "entity": "HOSPITALS", "params": { "field": "hospitalType", "value": "specialized" } }

Example 9 (All Doctors):
Query: "عايز كل الدكاترة"
Output: { "operation": "parse_search", "query": "all doctors", "follow_up": false, "entity": "RELATIONSHIPS", "params": { "queryType": "allDoctors" } }

Example 10 (All Hospitals):
Query: "عايز كل المستشفيات"
Output: { "operation": "parse_search", "query": "all hospitals", "follow_up": false, "entity": "RELATIONSHIPS", "params": { "queryType": "allHospitals" } }

Example 11 (All Specialties):
Query: "عايز كل التخصصات"
Output: { "operation": "parse_search", "query": "all specialties", "follow_up": false, "entity": "RELATIONSHIPS", "params": { "queryType": "allSpecialties" } }

Example 11b (All Cities):
Query: "What are the cities in the database?"
Output: { "operation": "parse_search", "query": "all cities", "follow_up": false, "entity": "RELATIONSHIPS", "params": { "queryType": "allCities" } }

Example 11c (All Areas):
Query: "قائمة المناطق"
Output: { "operation": "parse_search", "query": "all areas", "follow_up": false, "entity": "RELATIONSHIPS", "params": { "queryType": "allAreas", "includeArabic": true } }

Example 12 (Comparison):
Query: "قارن بين د. محمد و د. احمد"
Output: { "operation": "parse_search", "query": "compare Dr. Mohamed and Dr. Ahmed", "follow_up": false, "entity": "RELATIONSHIPS", "params": { "queryType": "specialtiesComparison", "doctor1Name": "محمد", "doctor2Name": "احمد", "includeArabic": true } }

Example 13 (Location-based Hospitals):
Query: "Hospitals in Alexandria"
Output: { "operation": "parse_search", "query": "Hospitals in Alexandria", "follow_up": false, "entity": "HOSPITALS", "params": { "field": "addressEn", "value": "Alexandria" } }

Example 14 (Price with Fullname):
Query: "عايز سعر دكتورة فاطيمة حسن"
Output: { "operation": "combined", "entity": "RELATIONSHIPS", "params": { "queryType": "hospitalsForDoctor", "fullname": "فاطيمة حسن", "doctorName": "فاطيمة حسن" } }

Example 15 (All Doctors with Specialty):
Query: "عايز كل دكاترة طب الاطفال"
Output: { "operation": "combined", "entity": "RELATIONSHIPS", "params": { "queryType": "allDoctors", "specialtyName": "Pediatrics" } }

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

    const result = JSON.parse(fixEncoding(response.response));
    console.log("🤖 Router Decision:", result);

    // 🔧 FIX: Sync doctorName and fullname to ensure 'fullname' param exists
    if (result.params) {
      if (result.params.excludeFullname) {
        console.log(`🚫 EXCLUSION DETECTED: removing doctorName/fullname matching "${result.params.excludeFullname}"`);
        result.params.doctorName = null;
        result.params.fullname = null;
      }

      if (result.params.doctorName && !result.params.fullname) {
        result.params.fullname = result.params.doctorName;
      }
      else if (result.params.fullname && !result.params.doctorName) {
        result.params.doctorName = result.params.fullname;
      }
    }

    // 🔧 FINAL SAFEGUARD: Ensure location is null if not asked
    if (result.params && (result.params.location === undefined || result.params.location === "")) {
      result.params.location = null;
    }

    // Compatibility mapping
    if (!result.entity && result.operation === "vector_search") {
      result.entity = "HOSPITALS"; // Default for vector
    }
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
  // English: Hospital, Dr, City, Governorate
  // Arabic: مستشفى, دكتور, محافظة, مدينة
  return term.replace(/\b(Hospital|Hospitals|Clinic|Clinics|Center|Centers|Centre|Centres|Dr|Doctor|Doctors|City|Governorate)\.?\b/gi, "")
    .replace(/^(د\.|دكتور|دكتورة|مستشفى|عيادة|مركز|محافظة|مدينة|حي|منطقة)\s+/g, "")
    .trim();
}

async function executeHospitalParseQuery(params, user) {
  console.log("🔍 Executing Hospital Parse Query:", params);
  const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);
  const query = new Parse.Query(Hospitals);
  query.notEqualTo("isDeleted", true);

  if (params.queryType === "allHospitals") {
    console.log("🔍 Fetching ALL hospitals...");
    query.limit(100);
  } else {
    query.limit(20);
  }

  const searchField = params.field;
  const searchValue = params.value;

  if (searchField && searchValue) {
    const cleanedValue = cleanSearchTerm(searchValue);
    console.log(`🧹 Cleaned search term: "${searchValue}" -> "${cleanedValue}"`);
    const safe = escapeRegex(cleanedValue);
    const searchPattern = new RegExp(safe, 'i');

    if (searchField === "nameEn" || searchField === "nameAr") {
      const qEn = new Parse.Query(Hospitals).matches("nameEn", searchPattern);
      const qAr = new Parse.Query(Hospitals).matches("nameAr", searchPattern);
      const nameQuery = Parse.Query.or(qEn, qAr);
      nameQuery.notEqualTo("isDeleted", true);
      query = nameQuery;
    } else if (searchField === "addressEn" || searchField === "addressAr") {
      // 1. Try City Match
      const Cities = Parse.Object.extend(PARSE_CLASS_CITIES);
      const cityQueryEn = new Parse.Query(Cities).matches("nameEn", searchPattern);
      const cityQueryAr = new Parse.Query(Cities).matches("nameAr", searchPattern);
      const citiesQuery = Parse.Query.or(cityQueryEn, cityQueryAr);
      citiesQuery.notEqualTo("isDeleted", true);
      const cities = await citiesQuery.find({ sessionToken: user.getSessionToken() });

      if (cities.length > 0) {
        console.log(`🏙  City Match Found: ${cities.map(c => c.get('nameEn')).join(', ')}`);
        const cityIds = cities.map(c => c.id);
        const Areas = Parse.Object.extend(PARSE_CLASS_AREAS);
        const areaByCityQuery = new Parse.Query(Areas);
        areaByCityQuery.containedIn("cityId", cityIds);
        areaByCityQuery.notEqualTo("isDeleted", true);
        const areas = await areaByCityQuery.find({ sessionToken: user.getSessionToken() });

        if (areas.length > 0) {
          const areaIds = areas.map(a => a.id);
          console.log(`🏘  Found ${areas.length} areas for these cities. Filtering hospitals by areaId...`);
          query.containedIn("areaId", areaIds);
        } else {
          query.matches(searchField, searchPattern);
        }
      } else {
        // 2. Try Area Match directly
        const Areas = Parse.Object.extend(PARSE_CLASS_AREAS);
        const areaQueryEn = new Parse.Query(Areas).matches("nameEn", searchPattern);
        const areaQueryAr = new Parse.Query(Areas).matches("nameAr", searchPattern);
        const areaQuery = Parse.Query.or(areaQueryEn, areaQueryAr);
        areaQuery.notEqualTo("isDeleted", true);
        const areas = await areaQuery.find({ sessionToken: user.getSessionToken() });

        if (areas.length > 0) {
          const areaIds = areas.map(a => a.id);
          console.log(`🏘  Area Match Found: ${areas.map(a => a.get('nameEn')).join(', ')}. Filtering hospitals by areaId...`);
          query.containedIn("areaId", areaIds);
        } else {
          // 3. Fallback to direct address regex
          query.matches(searchField, searchPattern);
        }
      }
    } else {
      query.matches(searchField, searchPattern);
    }
  }

  const results = await query.find({ sessionToken: user.getSessionToken() });

  if (!results.length) return [];

  const includeArabic = params.includeArabic || false;

  return results.map(obj => {
    let output = `
Name: ${obj.get("nameEn") || "Unknown"}
Type: ${obj.get("hospitalType") || "Unknown"}
Address: ${obj.get("addressEn") || "Unknown"}
Description: ${obj.get("descEn") || "Unknown"}
Working Hours: ${obj.get("workingDaysHrs") || "Unknown"}`;

    if (includeArabic) {
      output += `
Name (Ar): ${fixEncoding(obj.get("nameAr") || "Unknown")}
Description (Ar): ${fixEncoding(obj.get("descAr") || "Unknown")}`;
    }

    return output.trim();
  });
}

async function executeDoctorParseQuery(params, user) {
  console.log("🔍 Executing Doctor Parse Query:", params);
  const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
  const query = new Parse.Query(Doctors);
  query.notEqualTo("isDeleted", true);

  if (params.field && params.value) {
    const cleanedValue = cleanSearchTerm(params.value);
    console.log(`🧹 Cleaned search term: "${params.value}" -> "${cleanedValue}"`);
    const safe = escapeRegex(cleanedValue);
    const searchPattern = new RegExp(safe, 'i');
    query.matches(params.field, searchPattern);
  }

  query.limit(20);

  const results = await query.find({ sessionToken: user.getSessionToken() });

  if (!results.length) return [];

  const includeArabic = params.includeArabic || false;

  return results.map(obj => {
    let output = `
Name: ${obj.get("fullname") || "Unknown"}
Title: ${obj.get("title") || "Unknown"}
Position: ${obj.get("positionEn") || "Unknown"}
Qualifications: ${obj.get("qualificationsEn") || "Unknown"}
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
  const query = new Parse.Query(Specialties);
  query.notEqualTo("isDeleted", true);

  if (params.queryType === "allSpecialties") {
    console.log("🔍 Fetching ALL specialties...");
    query.limit(100);
  } else {
    query.limit(20);
  }

  if (params.field && params.value) {
    const cleanedValue = cleanSearchTerm(params.value);
    console.log(`🧹 Cleaned search term: "${params.value}" -> "${cleanedValue}"`);
    const safe = escapeRegex(cleanedValue);
    const searchPattern = new RegExp(safe, 'i');
    query.matches(params.field, searchPattern);
  }

  const results = await query.find({ sessionToken: user.getSessionToken() });

  if (!results.length) return [];

  const includeArabic = params.includeArabic || false;

  return results.map(obj => {
    let output = `
Specialty Name: ${obj.get("nameEn") || "Unknown"}`;

    if (includeArabic) {
      output += `
Arabic Name: ${fixEncoding(obj.get("nameAr") || "Unknown")}`;
    }

    return output.trim();
  });
}

async function executeCityParseQuery(params, user) {
  console.log("🔍 Executing City Parse Query:", params);
  const Cities = Parse.Object.extend(PARSE_CLASS_CITIES);
  const query = new Parse.Query(Cities);
  query.notEqualTo("isDeleted", true);
  query.limit(20);

  if (params.field && params.value) {
    const safe = escapeRegex(params.value);
    const searchPattern = new RegExp(safe, 'i');
    query.matches(params.field, searchPattern);
  }

  const results = await query.find({ sessionToken: user.getSessionToken() });
  if (!results.length) return [];

  const includeArabic = params.includeArabic || false;
  return results.map(obj => {
    let output = `City: ${obj.get("nameEn") || "Unknown"}`;
    if (includeArabic) {
      output += `\nCity (Ar): ${fixEncoding(obj.get("nameAr") || "Unknown")}`;
    }
    return output.trim();
  });
}

async function executeAreaParseQuery(params, user) {
  console.log("🔍 Executing Area Parse Query:", params);
  const Areas = Parse.Object.extend(PARSE_CLASS_AREAS);
  const query = new Parse.Query(Areas);
  query.notEqualTo("isDeleted", true);
  query.limit(20);

  if (params.field && params.value) {
    const safe = escapeRegex(params.value);
    const searchPattern = new RegExp(safe, 'i');
    query.matches(params.field, searchPattern);
  }

  const results = await query.find({ sessionToken: user.getSessionToken() });
  if (!results.length) return [];

  const includeArabic = params.includeArabic || false;
  return results.map(obj => {
    let output = `Area: ${obj.get("nameEn") || "Unknown"}`;
    if (includeArabic) {
      output += `\nArea (Ar): ${fixEncoding(obj.get("nameAr") || "Unknown")}`;
    }
    return output.trim();
  });
}

async function executeRelationshipQuery(params, user) {
  console.log("🔍 Executing Relationship Query:", params);

  // 🔧 Custom Request: Support 'fullname' as alias for 'doctorName'
  if (params.fullname && !params.doctorName) {
    console.log(`🔄 Aliasing params.fullname "${params.fullname}" to params.doctorName`);
    params.doctorName = params.fullname;
  }

  const HospitalDoctorSpecialty = Parse.Object.extend("HospitalDoctorSpecialty");
  const query = new Parse.Query(HospitalDoctorSpecialty);

  query.equalTo("isDeleted", false);
  query.include("doctorDetails");
  query.include("hospitalDetails");
  query.include("specialtyDetails");
  query.limit(20); // Default limit

  const queryType = params.queryType;
  const validTypes = ["doctorsAtHospital", "hospitalsForDoctor", "specialistsAtHospital", "specialtiesAtHospital", "specialtiesForDoctor", "specialtiesComparison", "allDoctors"];

  if (!validTypes.includes(queryType)) {
    console.warn(`⚠ Invalid queryType: "${queryType}". Returning empty results.`);
    return [];
  }

  if (queryType === "doctorsAtHospital" && params.hospitalName) {
    const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);

    const cleanedHospital = cleanSearchTerm(params.hospitalName);
    console.log(`🧹 Cleaned hospital name: "${params.hospitalName}" -> "${cleanedHospital}"`);

    const safe = escapeRegex(cleanedHospital);
    const searchPattern = new RegExp(safe, 'i');

    // Search in BOTH nameEn and nameAr using OR query
    const hospitalQueryEn = new Parse.Query(Hospitals).matches("nameEn", searchPattern);
    const hospitalQueryAr = new Parse.Query(Hospitals).matches("nameAr", searchPattern);
    const hospitalQuery = Parse.Query.or(hospitalQueryEn, hospitalQueryAr);
    hospitalQuery.notEqualTo("isDeleted", true);
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
      const docGenderQuery = new Parse.Query(Doctors).matches("gender", genderPattern);
      docGenderQuery.notEqualTo("isDeleted", true);
      const doctors = await docGenderQuery.find({ sessionToken: user.getSessionToken() });

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
      const docSearchQuery = new Parse.Query(Doctors).matches("fullname", searchPattern);
      docSearchQuery.notEqualTo("isDeleted", true);
      const doctors = await docSearchQuery.find({ sessionToken: user.getSessionToken() });

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
      const specSearchQuery = new Parse.Query(Specialties).matches("nameEn", searchPattern);
      specSearchQuery.notEqualTo("isDeleted", true);
      const specialties = await specSearchQuery.find({ sessionToken: user.getSessionToken() });

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
    const specSearchQuery = new Parse.Query(Specialties).matches("nameEn", searchPattern);
    specSearchQuery.notEqualTo("isDeleted", true);
    const specialties = await specSearchQuery.find({ sessionToken: user.getSessionToken() });

    if (specialties.length > 0) {
      const specialtyIds = specialties.map(s => s.id);
      query.containedIn("specialtyUid", specialtyIds);
    } else {
      return [];
    }

    if (params.hospitalName) {
      const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);

      const cleanedHospital = cleanSearchTerm(params.hospitalName);

      const safeName = escapeRegex(cleanedHospital);
      const hospitalPattern = new RegExp(safeName, 'i');

      // Search in BOTH nameEn and nameAr
      const hospitalQueryEn = new Parse.Query(Hospitals).matches("nameEn", hospitalPattern);
      const hospitalQueryAr = new Parse.Query(Hospitals).matches("nameAr", hospitalPattern);
      const hospitalSearchQuery = Parse.Query.or(hospitalQueryEn, hospitalQueryAr);
      hospitalSearchQuery.notEqualTo("isDeleted", true);
      const hospitals = await hospitalSearchQuery.find({ sessionToken: user.getSessionToken() });

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
    const hospitalQueryEn = new Parse.Query(Hospitals).matches("nameEn", searchPattern);
    const hospitalQueryAr = new Parse.Query(Hospitals).matches("nameAr", searchPattern);
    const hospitalQuery = Parse.Query.or(hospitalQueryEn, hospitalQueryAr);
    hospitalQuery.notEqualTo("isDeleted", true);
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
    const docQuery = new Parse.Query(Doctors).matches("fullname", searchPattern);
    docQuery.notEqualTo("isDeleted", true);
    const doctors = await docQuery.find({ sessionToken: user.getSessionToken() });

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
    const d1Query = new Parse.Query(Doctors).matches("fullname", new RegExp(safe1, 'i'));
    d1Query.notEqualTo("isDeleted", true);
    const doctors1 = await d1Query.find({ sessionToken: user.getSessionToken() });

    // Find Doctor 2
    const d2Query = new Parse.Query(Doctors).matches("fullname", new RegExp(safe2, 'i'));
    d2Query.notEqualTo("isDeleted", true);
    const doctors2 = await d2Query.find({ sessionToken: user.getSessionToken() });

    if (doctors1.length === 0 && doctors2.length === 0) return [];

    const doctorUids = [];
    if (doctors1.length > 0) doctorUids.push(...doctors1.map(d => d.get("uid")));
    if (doctors2.length > 0) doctorUids.push(...doctors2.map(d => d.get("uid")));

    query.containedIn("doctorUid", doctorUids);
  } else if (queryType === "allDoctors") {
    // Fetch all doctors (relationships)
    // No specific filters, just ensure we get the relationships
    console.log("🔍 Fetching ALL doctors with relationships...");
    query.limit(100); // Increase limit for "all" query
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

  return results.map(obj => {
    const doctor = obj.get("doctorDetails");
    const hospital = obj.get("hospitalDetails");
    const specialty = obj.get("specialtyDetails");

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
  });
}

// -----------------------------------------
// INGESTION
// -----------------------------------------


async function ensureOpenSearchIndex(indexName) {
  try {
    const exists = await clientOS.indices.exists({ index: indexName });
    if (exists.body) {
      console.log(`[OpenSearch] Deleting existing index: ${indexName}`);
      await clientOS.indices.delete({ index: indexName });
    }

    console.log(`[OpenSearch] Creating index: ${indexName}`);
    await clientOS.indices.create({
      index: indexName,
      body: {
        settings: {
          index: {
            max_ngram_diff: 10
          },
          number_of_shards: 1,
          number_of_replicas: 0,
          analysis: {
            char_filter: {
              arabic_char_normalizer: {
                type: "mapping",
                mappings: [
                  "أ=>ا",
                  "إ=>ا",
                  "آ=>ا",
                  "ة=>ه",
                  "ى=>ي"
                ]
              }
            },
            tokenizer: {
              arabic_ngram_tokenizer: {
                type: "ngram",
                min_gram: 3,
                max_gram: 5,
                token_chars: ["letter"]
              }
            },
            analyzer: {
              ar_index_analyzer: {
                type: "custom",
                char_filter: ["arabic_char_normalizer"],
                tokenizer: "arabic_ngram_tokenizer",
                filter: ["lowercase", "arabic_normalization"]
              },
              ar_search_analyzer: {
                type: "custom",
                char_filter: ["arabic_char_normalizer"],
                tokenizer: "standard",
                filter: ["lowercase", "arabic_normalization"]
              }
            }
          }
        },
        mappings: {
          properties: {
            text: {
              type: "text",
              analyzer: "ar_index_analyzer",
              search_analyzer: "ar_search_analyzer"
            },
            nameAr: {
              type: "text",
              analyzer: "ar_index_analyzer",
              search_analyzer: "ar_search_analyzer"
            },
            nameEn: {
              type: "text",
              analyzer: "standard"
            },
            title: {
              type: "text",
              analyzer: "ar_index_analyzer",
              search_analyzer: "ar_search_analyzer"
            },
            hospitalType: {
              type: "keyword"
            },
            isDeleted: {
              type: "boolean"
            }
          }
        }
      }
    });
  } catch (e) {
    console.warn(`[OpenSearch] Index check/create failed for ${indexName}:`, e.message);
  }
}

async function ingestHospitalsToQdrant(user) {
  console.log("Recreating collection:", HOSPITALS_COLLECTION);

  // Qdrant Init
  try { await qdrant.deleteCollection(HOSPITALS_COLLECTION); } catch (e) { }
  try {
    await qdrant.createCollection(HOSPITALS_COLLECTION, { vectors: { size: 1024, distance: "Cosine" } });
  } catch (e) { console.error("Error creating Qdrant collection:", e); }

  // OpenSearch Init
  await ensureOpenSearchIndex(HOSPITALS_COLLECTION);

  const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);
  const query = new Parse.Query(Hospitals);
  query.notEqualTo("isDeleted", true);
  query.limit(1000);
  const results = await query.find({ sessionToken: user.getSessionToken() });

  console.log(`Found ${results.length} hospitals to ingest...`);

  const points = [];
  const osDocs = [];

  for (const obj of results) {
    const text = `
Hospital: ${obj.get("nameEn") || "Unknown"}
Hospital (Ar): ${fixEncoding(obj.get("nameAr") || "") || "Unknown"}
Type: ${obj.get("hospitalType") || "Unknown"}
Address: ${obj.get("addressEn") || "Unknown"}
Address (Ar): ${fixEncoding(obj.get("addressAr") || "") || "Unknown"}
Description: ${obj.get("descEn") || "Unknown"}
Description (Ar): ${fixEncoding(obj.get("descAr") || "") || "Unknown"}
Working Hours: ${obj.get("workingDaysHrs") || "Unknown"}
    `.trim();

    const embedding = await embed(text, "retrieval.passage");

    // Qdrant Point
    points.push({
      id: randomUUID(),
      vector: embedding,
      payload: {
        parse_id: obj.id,
        text: text,
        type: "HOSPITAL",
        type_Hospital: obj.get("hospitalType"),
        address: obj.get("addressEn"),
        address_Ar: fixEncoding(obj.get("addressAr") || ""),
        Description: obj.get("descEn"),
        Description_Ar: fixEncoding(obj.get("descAr") || ""),
        isDeleted: false
      }
    });

    // OpenSearch Doc
    osDocs.push({ index: { _index: HOSPITALS_COLLECTION, _id: obj.id } });
    osDocs.push({
      text: text,
      nameEn: obj.get("nameEn"),
      nameAr: fixEncoding(obj.get("nameAr") || ""),
      type_Hospital: obj.get("hospitalType"),
      address: obj.get("addressEn"),
      descEn: obj.get("descEn"),
      isDeleted: false
    });

    process.stdout.write(".");
  }

  console.log("\nUpserting hospitals...");
  if (points.length > 0) {
    await qdrant.upsert(HOSPITALS_COLLECTION, { points });
    try {
      const { body: bulkResponse } = await clientOS.bulk({ refresh: true, body: osDocs });
      if (bulkResponse.errors) console.log("⚠️ OpenSearch Bulk had errors");
      else console.log(`✅ Indexed ${points.length} docs to OpenSearch`);
    } catch (e) {
      console.error("❌ OpenSearch Bulk Failed:", e.message);
    }
  }
  console.log("Done ingesting hospitals.");
}

async function ingestDoctorsToQdrant(user) {
  console.log("Recreating collection:", DOCTORS_COLLECTION);
  try { await qdrant.deleteCollection(DOCTORS_COLLECTION); } catch (e) { }
  try {
    await qdrant.createCollection(DOCTORS_COLLECTION, { vectors: { size: 1024, distance: "Cosine" } });
  } catch (e) { console.error("Error creating collection:", e); }

  // OpenSearch Init
  await ensureOpenSearchIndex(DOCTORS_COLLECTION);

  const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
  const query = new Parse.Query(Doctors);
  query.notEqualTo("isDeleted", true);
  query.limit(1000);
  const results = await query.find({ sessionToken: user.getSessionToken() });

  console.log(`Found ${results.length} doctors to ingest...`);

  const points = [];
  const osDocs = [];

  for (const obj of results) {
    const text = `
Doctor: ${obj.get("fullname") || "Unknown"}
Doctor (Ar): ${fixEncoding(obj.get("fullnameAr") || "") || "Unknown"}
Title: ${obj.get("title") || "Unknown"}
Position: ${obj.get("positionEn") || "Unknown"}
Position (Ar): ${fixEncoding(obj.get("positionAr") || "") || "Unknown"}
Qualifications: ${obj.get("qualificationsEn") || "Unknown"}
Qualifications (Ar): ${fixEncoding(obj.get("qualificationsAr") || "") || "Unknown"}
Experience: ${obj.get("yrsExp") || "Unknown"} years
Gender: ${obj.get("gender") || "Unknown"}
Rating: ${obj.get("averageRating") || "Unknown"}
    `.trim();

    const embedding = await embed(text, "retrieval.passage");
    // Qdrant Point
    points.push({
      id: randomUUID(),
      vector: embedding,
      payload: {
        parse_id: obj.id,
        text: text,
        type: "DOCTOR",
        isDeleted: false
      }
    });

    // OpenSearch Doc
    osDocs.push({ index: { _index: DOCTORS_COLLECTION, _id: obj.id } });
    osDocs.push({
      text: text,
      fullname: obj.get("fullname"),
      fullnameAr: fixEncoding(obj.get("fullnameAr") || ""),
      title: obj.get("title"),
      positionEn: obj.get("positionEn"),
      qualificationsEn: obj.get("qualificationsEn"),
      // Map main name fields for standardized search
      nameEn: obj.get("fullname"),
      nameAr: fixEncoding(obj.get("fullnameAr") || ""),
      isDeleted: false
    });

    process.stdout.write(".");
  }
  console.log("\nUpserting doctors...");
  if (points.length > 0) {
    await qdrant.upsert(DOCTORS_COLLECTION, { points });
    try {
      const { body: bulkResponse } = await clientOS.bulk({ refresh: true, body: osDocs });
      if (bulkResponse.errors) console.log("⚠️ OpenSearch Bulk had errors");
      else console.log(`✅ Indexed ${points.length} docs to OpenSearch`);
    } catch (e) {
      console.error("❌ OpenSearch Bulk Failed:", e.message);
    }
  }
  console.log("Done ingesting doctors.");
}

async function ingestSpecialtiesToQdrant(user) {
  console.log("Recreating collection:", SPECIALTIES_COLLECTION);
  try { await qdrant.deleteCollection(SPECIALTIES_COLLECTION); } catch (e) { }
  try {
    await qdrant.createCollection(SPECIALTIES_COLLECTION, { vectors: { size: 1024, distance: "Cosine" } });
  } catch (e) { console.error("Error creating collection:", e); }

  // OpenSearch Init
  await ensureOpenSearchIndex(SPECIALTIES_COLLECTION);

  const Specialties = Parse.Object.extend(PARSE_CLASS_SPECIALTIES);
  const query = new Parse.Query(Specialties);
  query.notEqualTo("isDeleted", true);
  query.limit(1000);
  const results = await query.find({ sessionToken: user.getSessionToken() });

  console.log(`Found ${results.length} specialties to ingest...`);

  const points = [];
  const osDocs = [];

  for (const obj of results) {
    const text = `
${obj.get("nameEn") || "Unknown"}
${fixEncoding(obj.get("nameAr") || "") || "Unknown"}
    `.trim();

    const embedding = await embed(text, "retrieval.passage");
    // Qdrant Point
    points.push({
      id: randomUUID(),
      vector: embedding,
      payload: {
        parse_id: obj.id,
        text: text,
        type: "SPECIALTY",
        isDeleted: false
      }
    });

    // OpenSearch Doc
    osDocs.push({ index: { _index: SPECIALTIES_COLLECTION, _id: obj.id } });
    osDocs.push({
      text: text,
      nameEn: obj.get("nameEn"),
      nameAr: fixEncoding(obj.get("nameAr") || ""),
      isDeleted: false
    });

    process.stdout.write(".");
  }
  console.log("\nUpserting specialties...");
  if (points.length > 0) {
    await qdrant.upsert(SPECIALTIES_COLLECTION, { points });
    try {
      const { body: bulkResponse } = await clientOS.bulk({ refresh: true, body: osDocs });
      if (bulkResponse.errors) console.log("⚠️ OpenSearch Bulk had errors");
      else console.log(`✅ Indexed ${points.length} docs to OpenSearch`);
    } catch (e) {
      console.error("❌ OpenSearch Bulk Failed:", e.message);
    }
  }
  console.log("Done ingesting specialties.");
}

async function ingestCitiesToQdrant(user) {
  console.log("Recreating collection:", CITIES_COLLECTION);
  try { await qdrant.deleteCollection(CITIES_COLLECTION); } catch (e) { }
  try {
    await qdrant.createCollection(CITIES_COLLECTION, { vectors: { size: 1024, distance: "Cosine" } });
  } catch (e) { console.error("Error creating collection:", e); }

  await ensureOpenSearchIndex(CITIES_COLLECTION);

  const Cities = Parse.Object.extend(PARSE_CLASS_CITIES);
  const query = new Parse.Query(Cities);
  query.notEqualTo("isDeleted", true);
  query.limit(1000);
  const results = await query.find({ sessionToken: user.getSessionToken() });

  console.log(`Found ${results.length} cities to ingest...`);

  const points = [];
  const osDocs = [];

  for (const obj of results) {
    const text = `
City: ${obj.get("nameEn") || "Unknown"}
City (Ar): ${fixEncoding(obj.get("nameAr") || "") || "Unknown"}
    `.trim();

    const embedding = await embed(text, "retrieval.passage");
    points.push({
      id: randomUUID(),
      vector: embedding,
      payload: {
        parse_id: obj.id,
        text: text,
        type: "CITY",
        isDeleted: false
      }
    });

    osDocs.push({ index: { _index: CITIES_COLLECTION, _id: obj.id } });
    osDocs.push({
      text: text,
      nameEn: obj.get("nameEn"),
      nameAr: fixEncoding(obj.get("nameAr") || ""),
      isDeleted: false
    });

    process.stdout.write(".");
  }
  console.log("\nUpserting cities...");
  if (points.length > 0) {
    await qdrant.upsert(CITIES_COLLECTION, { points });
    try {
      const { body: bulkResponse } = await clientOS.bulk({ refresh: true, body: osDocs });
      if (bulkResponse.errors) console.log("⚠️ OpenSearch Bulk had errors");
      else console.log(`✅ Indexed ${points.length} docs to OpenSearch`);
    } catch (e) {
      console.error("❌ OpenSearch Bulk Failed:", e.message);
    }
  }
  console.log("Done ingesting cities.");
}

async function ingestAreasToQdrant(user) {
  console.log("Recreating collection:", AREAS_COLLECTION);
  try { await qdrant.deleteCollection(AREAS_COLLECTION); } catch (e) { }
  try {
    await qdrant.createCollection(AREAS_COLLECTION, { vectors: { size: 1024, distance: "Cosine" } });
  } catch (e) { console.error("Error creating collection:", e); }

  await ensureOpenSearchIndex(AREAS_COLLECTION);

  const Areas = Parse.Object.extend(PARSE_CLASS_AREAS);
  const query = new Parse.Query(Areas);
  query.notEqualTo("isDeleted", true);
  query.limit(1000);
  const results = await query.find({ sessionToken: user.getSessionToken() });

  console.log(`Found ${results.length} areas to ingest...`);

  const points = [];
  const osDocs = [];

  for (const obj of results) {
    let text = "";
    if (obj.get("nameEn") === "Misr Gadeda") {

      text = `
Area: ${obj.get("nameEn") || "Unknown"} "Heliopolis"
Area (Ar): ${fixEncoding(obj.get("nameAr") || "هيليوبليس") || "Unknown"}
City ID: ${obj.get("cityId") || "Unknown"}
    `.trim();

    } else {
      text = `
Area: ${obj.get("nameEn") || "Unknown"}
Area (Ar): ${fixEncoding(obj.get("nameAr") || "") || "Unknown"}
City ID: ${obj.get("cityId") || "Unknown"}
    `.trim();
    }
    const embedding = await embed(text, "retrieval.passage");
    points.push({
      id: randomUUID(),
      vector: embedding,
      payload: {
        parse_id: obj.id,
        text: text,
        type: "AREA",
        cityId: obj.get("cityId"),
        isDeleted: false
      }
    });

    osDocs.push({ index: { _index: AREAS_COLLECTION, _id: obj.id } });
    osDocs.push({
      text: text,
      nameEn: obj.get("nameEn"),
      nameAr: fixEncoding(obj.get("nameAr") || ""),
      cityId: obj.get("cityId"),
      isDeleted: false
    });

    process.stdout.write(".");
  }
  console.log("\nUpserting areas...");
  if (points.length > 0) {
    await qdrant.upsert(AREAS_COLLECTION, { points });
    try {
      const { body: bulkResponse } = await clientOS.bulk({ refresh: true, body: osDocs });
      if (bulkResponse.errors) console.log("⚠️ OpenSearch Bulk had errors");
      else console.log(`✅ Indexed ${points.length} docs to OpenSearch`);
    } catch (e) {
      console.error("❌ OpenSearch Bulk Failed:", e.message);
    }
  }
  console.log("Done ingesting areas.");
}

// -----------------------------------------
// IMPROVED VECTOR SEARCH
// -----------------------------------------

// Helper: Hybrid Merge Strategy (Weighted Score Fuse)
function hybridMerge(bm25Results, vectorResults) {
  const map = new Map();

  // Process BM25 Results (OpenSearch)
  bm25Results.forEach(r => {
    const score = (r._score || 0) * 0.6;
    map.set(r._id, { ...r._source, score, matchType: ['bm25'], collectionName });
  });

  // Process Vector Results (Qdrant)
  vectorResults.forEach(r => {
    const id = r.payload?.mongoId || r.id; // Ensure ID alignment
    const score = (r.score || 0) * 0.4;

    if (map.has(id)) {
      const entry = map.get(id);
      entry.score += score;
      entry.score *= 1.5; // Boost intersection
      entry.matchType.push('vector');
      if (collectionName) entry.collectionName = collectionName;
    } else {
      map.set(id, { ...r.payload, score, matchType: ['vector'], collectionName });
    }
  });

  return [...map.values()].sort((a, b) => b.score - a.score);
}

// -----------------------------------------
// IMPROVED VECTOR SEARCH (HYBRID)
// -----------------------------------------

async function performVectorSearch(query, collection, limit = 5, scoreThreshold = 0.5) {
  const normalizedQuery = normalizeArabicMedical(query);
  console.log(`🔍 Performing Hybrid Search on ${collection} for: "${normalizedQuery}"`);

  const searchLimit = limit * 2; // Fetch more for better intersection

  // 1. Generate Vector
  const vectorPromise = embed(query, "retrieval.query");

  // 2. Parallel Search Execution
  try {
    const [vector, bm25Res] = await Promise.all([
      vectorPromise,
      clientOS.search({
        index: collection, // Ensure OS index names match Qdrant collection names
        body: {
          size: searchLimit,
          query: {
            bool: {
              must: [
                {
                  multi_match: {
                    query: normalizedQuery,
                    fields: ['text^2', 'nameAr', 'nameEn', 'title'], // Search across relevant text fields
                    fuzziness: "AUTO"
                  }
                }
              ],
              must_not: [
                { term: { isDeleted: true } }
              ]
            }
          }
        }
      }).catch(e => {
        console.error("OpenSearch BM25 Failed:", e.message);
        return { body: { hits: { hits: [] } } };
      })
    ]);

    const vectorRes = await qdrant.search(collection, {
      vector: vector,
      limit: searchLimit,
      score_threshold: scoreThreshold,
      filter: {
        must_not: [
          {
            key: "isDeleted",
            match: {
              value: true
            }
          }
        ]
      }
    }).catch(e => {
      console.error("Qdrant Vector Search Failed:", e.message);
      return [];
    });

    const bm25Hits = bm25Res.body.hits.hits;
    console.log(`📊 Raw Results: OpenSearch(BM25)=${bm25Hits.length}, Qdrant(Vector)=${vectorRes.length}`);

    // 3. Fusion
    const fusedResults = hybridMerge(bm25Hits, vectorRes, collection).slice(0, limit);

    console.log(`🤝 Hybrid Fusion yielded ${fusedResults.length} unique results.`);
    fusedResults.forEach((r, i) => {
      console.log(` ${fixEncoding(r.text || r.name)} ➤ Score: ${r.score.toFixed(4)} [${r.matchType.join('+')}]`);
    });

    return fusedResults.map(r => r.text);

  } catch (e) {
    console.error("Hybrid Search Error:", e);
    return [];
  }
}

async function extractEntityFromContext(question, contextChunks) {
  if (!contextChunks || contextChunks.length === 0) return null;

  const context = contextChunks.slice(0, 3).map(chunk => {
    if (typeof chunk === 'string') return chunk;
    const text = chunk.text || chunk.nameAr || chunk.nameEn || "";
    const source = chunk.collectionName || "Unknown";
    return `[Source: ${source}] ${text}`;
  }).join("\n");

  const prompt = `
You are an intelligent assistant. The user asked a question, and we found some text snippets.
Analyze the snippets to see if they refer to a SPECIFIC Hospital, Doctor, or Specialty that matches the user's intent.

CRITICAL INSTRUCTION (ZERO HALLUCINATION):
1. EXTRACT DATA ONLY FROM THE "TEXT SNIPPETS" PROVIDED BELOW.
2. DO NOT USE OUTSIDE KNOWLEDGE.
3. DO NOT INVENT OR HALLUCINATE NAMES.
4. If the entity is NOT in the text snippets, set "found": false.

SOURCE INFERENCE RULES:
- If a snippet starts with "[Source: hospitals_docs]", it refers to a HOSPITAL.
- If a snippet starts with "[Source: specialties_docs]", it refers to a SPECIALTY.
- If a snippet starts with "[Source: doctors_docs]", it refers to a DOCTOR.

User Question: "${question}"

Text Snippets:
${context}

Output JSON ONLY:
{
  "found": boolean,
  "entity": "HOSPITALS" or "DOCTORS" or "SPECIALTIES",
  "params": { 
    "field": "nameEn" (for hospitals/specialties) or "fullname" (for doctors), 
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

async function ragAnswer(question, user) {
  const route = await determineSearchMethod(question);
  let contextText = "";
  let vectorResults = [];

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
    collection = HOSPITALS_COLLECTION; // Default to hospitals for vector search in relationships
  } else if (entity === "CITIES") {
    collection = CITIES_COLLECTION;
    parseQueryFn = executeCityParseQuery;
  } else if (entity === "AREAS") {
    collection = AREAS_COLLECTION;
    parseQueryFn = executeAreaParseQuery;
  } else {
    collection = HOSPITALS_COLLECTION;
    parseQueryFn = executeHospitalParseQuery;
  }

  // 1. Try PARSE if routed that way
  // Handle "combined" operation: Vector Search FIRST, then Parse Search
  if (route.operation === "combined") {
    console.log("🔄 Operation: COMBINED (Vector + Parse)");

    // 1. Vector Search for symptoms/general info
    vectorResults = await performVectorSearch(question, collection, 5, 0.4);
    if (vectorResults.length > 0) {
      contextText += "=== MEDICAL INFO ===\n" + vectorResults.join("\n---\n") + "\n\n";
    }

    // 2. Parse Search for specific entities (Doctors/Hospitals)
    if (route.params) {
      const parseResults = await parseQueryFn(route.params, user);
      if (parseResults.length > 0) {
        contextText += "=== RELEVANT ENTITIES ===\n" + parseResults.join("\n---\n");
      }
    }
  }
  // Handle "parse_search"
  else if (route.operation === "parse_search") {
    console.log("🔄 Operation: PARSE SEARCH");
    const parseResults = await parseQueryFn(route.params, user);
    if (parseResults.length > 0) {
      contextText = `[TOTAL RESULTS: ${parseResults.length} - You MUST list all ${parseResults.length} items]\n\n` + parseResults.join("\n---\n");
      console.log(`✅ Parse search returned ${parseResults.length} results`);
    } else {
      console.log(`⚠ ${entity} Parse search returned no results, falling back to Vector.`);
      // Fallback to Vector
      if (entity !== "RELATIONSHIPS") {
        vectorResults = await performVectorSearch(question, collection, 5, 0.4);
        if (vectorResults.length > 0) {
          contextText = vectorResults.join("\n---\n");
        }
      }
    }
  }
  // Handle "vector_search"
  else {
    console.log("🔄 Operation: VECTOR SEARCH");
    vectorResults = await performVectorSearch(question, collection, 5, 0.4);
    if (vectorResults.length === 0) {
      console.log(`⚠ No results with standard threshold, trying lower threshold...`);
      vectorResults = await performVectorSearch(question, collection, 5, 0.2);
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
      else if (extraction.entity === "SPECIALTIES") enrichFn = executeSpecialtiesParseQuery;
      else if (extraction.entity === "CITIES") enrichFn = executeCityParseQuery;
      else if (extraction.entity === "AREAS") enrichFn = executeAreaParseQuery;

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

  if (!contextText) {
    return "I couldn't find related information.";
  }

  // Improved prompt with better instructions
  const prompt = `
You are a helpful medical and location information assistant. Answer the user's question using ONLY the context provided below.

IMPORTANT RULES:
1. Base your answer ONLY on the information in the context
2. If the context doesn't contain the answer, say: "I don't have that information in my database."
3. Be specific and cite details from the context
4. CRITICAL: List ALL items from the context (Doctors, Hospitals, Cities, Areas) - DO NOT skip, summarize, or truncate any results.
5. LANGUAGE RULES:
   - If the user's question is in Arabic, respond in Arabic
   - For Arabic responses: Use ONLY the Arabic field value, not both languages
   - DO NOT translate - use exact text from context
6. FORMATTING RULES:
   - Be concise and clean
   - List items simply: "- [Name] - [Info]"
7. Forbidden: hallucinations, external knowledge, translating, or repeating content

CONTEXT:
${contextText}

QUESTION:
${question}

ANSWER:
  `.trim();

  const response = await ollama.generate({
    model: LLM_MODEL,
    prompt: prompt
  });

  return response.response;
}

// -----------------------------------------
// MAIN
// -----------------------------------------
async function main() {
  console.log("=== Parse + Qdrant + Ollama (RAG Bot) ===");

  const user = await parseLogin();

  console.log("\n[Ingestion] Starting data ingestion...");
  // Note: Comment out ingestion if data is already in Qdrant
  await ingestHospitalsToQdrant(user);
  await ingestDoctorsToQdrant(user);
  await ingestSpecialtiesToQdrant(user);
  await ingestCitiesToQdrant(user);
  await ingestAreasToQdrant(user);
  console.log("[Ingestion] Skipping data ingestion (already done).\n");

  console.log("\nBot is ready! Ask anything (type 'exit' to quit):\n");

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", async (input) => {
    const q = input.trim();
    if (q === "exit") process.exit(0);

    const answer = await ragAnswer(q, user);
    console.log("\nBOT:", fixEncoding(answer), "\n");
  });
}

main();
