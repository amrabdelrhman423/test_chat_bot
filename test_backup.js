import XHR2 from 'xhr2';

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
import Parse from "parse/node.js";
import { QdrantClient } from "@qdrant/js-client-rest";
import ollama from "ollama";
import { randomUUID } from "crypto";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

globalThis.fetch = fetch;
globalThis.FormData = FormData;

// -----------------------------------------
// CONFIG
// -----------------------------------------
const PARSE_URL = "https://nodewemo.voycephone.com/parse";
const PARSE_APP_ID = "com.voyce";

const PARSE_USERNAME = "admin1";
const PARSE_PASSWORD = "12345678";

const PARSE_CLASS_HOSPITALS = "Hospitals";
const PARSE_CLASS_DOCTORS = "Doctors";
const PARSE_CLASS_SPECIALTIES = "Specialties";

const QDRANT_URL = "http://localhost:6333";
const HOSPITALS_COLLECTION = "hospitals_docs";
const DOCTORS_COLLECTION = "doctors_docs";
const SPECIALTIES_COLLECTION = "specialties_docs";

const EMBED_MODEL = "mistral";
const LLM_MODEL = "llama3.1";

const WS_PORT = 3000;

// -----------------------------------------
// INIT PARSE
// -----------------------------------------
Parse.initialize(PARSE_APP_ID);
Parse.serverURL = PARSE_URL;
Parse.CoreManager.set('REQUEST_HEADERS', {
    "Content-Type": "application/json; charset=utf-8"
});

function fixEncoding(str) {
    return Buffer.from(str, 'latin1').toString('utf8');
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

    const prompt = `
You are a router. Decide how to search for the user's query.
Output JSON ONLY.

DATABASE SCHEMA:
${schemaContext}

Entity Types:
- "HOSPITALS": Questions about hospitals, clinics, medical facilities
- "DOCTORS": Questions about doctors, physicians, specialists
- "SPECIALTIES": Questions about medical specialties, fields of medicine
- "RELATIONSHIPS": Questions about which doctors work at which hospitals, or which specialties are available where

Search Types:
- "PARSE": Use when the user asks for a specific entity by name OR description, OR asks about relationships.
- "VECTOR": Use for general questions or semantic queries (e.g., "Best cardiologists", "Hospitals for IVF").

Language Detection:
- If the user asks for Arabic fields (nameAr, descAr, positionAr, qualificationsAr, etc.) or uses Arabic keywords, set "includeArabic": true in params.
- Otherwise, set "includeArabic": false or omit it.

Schema for PARSE:
- entity: "HOSPITALS" or "DOCTORS" or "SPECIALTIES" or "RELATIONSHIPS"
- field: The database column to FILTER by.
    - CRITICAL: If the user asks for an attribute (like description, address, phone) of a SPECIFIC named entity (e.g., "descAr for Hospital X"), you MUST filter by the NAME field ("nameEn" for hospitals, "fullname" for doctors), NOT the attribute field.
- For RELATIONSHIPS: queryType: "doctorsAtHospital" or "hospitalsForDoctor" or "specialistsAtHospital" or "specialtiesAtHospital"
- value: <extracted name or pattern>. IMPORTANT: For hospital names, remove generic suffixes like 'Hospital', 'Center', 'Clinic' to improve partial matching (e.g., output "German" instead of "German Hospital").

Example 1:
Query: "Where is Dar Al Fouad Hospital?"
Output: { "type": "PARSE", "entity": "HOSPITALS", "params": { "field": "nameEn", "value": "Dar Al Fouad" } }

Example 2:
Query: "Find Dr. Ahmed"
Output: { "type": "PARSE", "entity": "DOCTORS", "params": { "field": "fullname", "value": "Ahmed" } }

Example 3:
Query: "What is Cardiology?"
Output: { "type": "PARSE", "entity": "SPECIALTIES", "params": { "field": "nameEn", "value": "Cardiology" } }

Example 4:
Query: "Best hospitals for heart surgery?"
Output: { "type": "VECTOR", "entity": "HOSPITALS", "params": {} }

Example 5:
Query: "What specialties are available?"
Output: { "type": "VECTOR", "entity": "SPECIALTIES", "params": {} }

Example 6:
Query: "Hospitals with description starting with 'Leading'"
Output: { "type": "PARSE", "entity": "HOSPITALS", "params": { "field": "descEn", "value": "Leading" } }

Example 7:
Query: "Which doctors work at Dar Al Fouad Hospital?"
Output: { "type": "PARSE", "entity": "RELATIONSHIPS", "params": { "queryType": "doctorsAtHospital", "hospitalName": "Dar Al Fouad" } }

Example 8:
Query: "Where does Dr. Ahmed work?"
Output: { "type": "PARSE", "entity": "RELATIONSHIPS", "params": { "queryType": "hospitalsForDoctor", "doctorName": "Ahmed" } }

Example 9:
Query: "Which cardiologists work at Dar Al Fouad?"
Output: { "type": "PARSE", "entity": "RELATIONSHIPS", "params": { "queryType": "specialistsAtHospital", "specialtyName": "Cardiology", "hospitalName": "Dar Al Fouad" } }

Example 10:
Query: "What specialties are available at this hospital?"
Output: { "type": "PARSE", "entity": "RELATIONSHIPS", "params": { "queryType": "specialtiesAtHospital", "hospitalName": "this hospital" } }

Example 11:
Query: "can give me doctors male from hospital Ain Shams Specialized Hospital"
Output: { "type": "PARSE", "entity": "RELATIONSHIPS", "params": { "queryType": "doctorsAtHospital", "hospitalName": "Ain Shams", "gender": "male" } }

Example 12:
Query: "doctors in German hospital"
Output: { "type": "PARSE", "entity": "RELATIONSHIPS", "params": { "queryType": "doctorsAtHospital", "hospitalName": "German" } }

Example 13:
Query: "give me descAr for Hospital Ain Shams"
Output: { "type": "PARSE", "entity": "HOSPITALS", "params": { "field": "nameEn", "value": "Ain Shams", "includeArabic": true } }

Example 14:
Query: "أعطني معلومات عن مستشفى عين شمس"
Output: { "type": "PARSE", "entity": "HOSPITALS", "params": { "field": "nameEn", "value": "عين شمس", "includeArabic": true } }

Example 15:
Query: "i need info about Ain Shams Hospital"
Output: { "type": "PARSE", "entity": "HOSPITALS", "params": { "field": "nameEn", "value": "Ain Shams" } }

Example 16:
Query: "Compare the specialties of Dr. Ahmed and Dr. Mohamed"
Output: { "type": "PARSE", "entity": "RELATIONSHIPS", "params": { "queryType": "specialtiesComparison", "doctor1Name": "Ahmed", "doctor2Name": "Mohamed" } }

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
        if (!result.entity) {
            result.entity = "HOSPITALS";
        }
        return result;
    } catch (e) {
        console.error("Router Error:", e);
        return { type: "VECTOR", entity: "HOSPITALS" };
    }
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function executeHospitalParseQuery(params, user) {
    console.log("🔍 Executing Hospital Parse Query:", params);
    const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);
    const query = new Parse.Query(Hospitals);

    if (params.field && params.value) {
        const safe = escapeRegex(params.value);
        const searchPattern = new RegExp(`^${safe}`, 'i');
        query.matches(params.field, searchPattern);
    }

    query.limit(15);

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

    if (params.field && params.value) {
        const searchPattern = new RegExp(`^${params.value}`, 'i');
        query.matches(params.field, searchPattern);
    }

    query.limit(15);

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

    if (params.field && params.value) {
        const searchPattern = new RegExp(`^${params.value}`, 'i');
        query.matches(params.field, searchPattern);
    }

    query.limit(15);

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

async function executeRelationshipQuery(params, user) {
    console.log("🔍 Executing Relationship Query:", params);
    const HospitalDoctorSpecialty = Parse.Object.extend("HospitalDoctorSpecialty");
    const query = new Parse.Query(HospitalDoctorSpecialty);

    query.equalTo("isDeleted", false);
    query.include("doctorDetails");
    query.include("hospitalDetails");
    query.include("specialtyDetails");

    const queryType = params.queryType;

    if (queryType === "doctorsAtHospital" && params.hospitalName) {
        const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);
        const hospitalQuery = new Parse.Query(Hospitals);
        const safe = escapeRegex(params.hospitalName);
        const searchPattern = new RegExp(`^${safe}`, 'i');
        hospitalQuery.matches("nameEn", searchPattern);
        const hospitals = await hospitalQuery.find({ sessionToken: user.getSessionToken() });

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
    } else if (queryType === "hospitalsForDoctor" && params.doctorName) {
        const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
        const doctorQuery = new Parse.Query(Doctors);
        const safe = escapeRegex(params.doctorName);
        const searchPattern = new RegExp(`^${safe}`, 'i');
        doctorQuery.matches("fullname", searchPattern);
        const doctors = await doctorQuery.find({ sessionToken: user.getSessionToken() });

        if (doctors.length > 0) {
            const doctorUids = doctors.map(d => d.get("uid"));
            query.containedIn("doctorUid", doctorUids);
        } else {
            return [];
        }
    } else if (queryType === "specialistsAtHospital" && params.specialtyName) {
        const Specialties = Parse.Object.extend(PARSE_CLASS_SPECIALTIES);
        const specialtyQuery = new Parse.Query(Specialties);
        const safe = escapeRegex(params.specialtyName);
        const searchPattern = new RegExp(`^${safe}`, 'i');
        specialtyQuery.matches("nameEn", searchPattern);
        const specialties = await specialtyQuery.find({ sessionToken: user.getSessionToken() });

        if (specialties.length > 0) {
            const specialtyIds = specialties.map(s => s.id);
            query.containedIn("specialtyUid", specialtyIds);
        } else {
            return [];
        }

        if (params.hospitalName) {
            const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);
            const hospitalQuery = new Parse.Query(Hospitals);
            const safeName = escapeRegex(params.hospitalName);
            const hospitalPattern = new RegExp(`^${safeName}`, 'i');
            hospitalQuery.matches("nameEn", hospitalPattern);
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
        const hospitalQuery = new Parse.Query(Hospitals);
        const safe = escapeRegex(params.hospitalName);
        const searchPattern = new RegExp(`^${safe}`, 'i');
        hospitalQuery.matches("nameEn", searchPattern);
        const hospitals = await hospitalQuery.find({ sessionToken: user.getSessionToken() });

        if (hospitals.length > 0) {
            const hospitalUids = hospitals.map(h => h.get("uid"));
            query.containedIn("hospitalUid", hospitalUids);
        } else {
            return [];
        }
    } else if (queryType === "specialtiesComparison" && params.doctor1Name && params.doctor2Name) {
        // Handle comparison of two doctors
        const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);

        // Find Doctor 1
        const doctor1Query = new Parse.Query(Doctors);
        const safe1 = escapeRegex(params.doctor1Name);
        doctor1Query.matches("fullname", new RegExp(`^${safe1}`, 'i'));
        const doctors1 = await doctor1Query.find({ sessionToken: user.getSessionToken() });

        // Find Doctor 2
        const doctor2Query = new Parse.Query(Doctors);
        const safe2 = escapeRegex(params.doctor2Name);
        doctor2Query.matches("fullname", new RegExp(`^${safe2}`, 'i'));
        const doctors2 = await doctor2Query.find({ sessionToken: user.getSessionToken() });

        if (doctors1.length === 0 && doctors2.length === 0) return [];

        const doctorUids = [];
        if (doctors1.length > 0) doctorUids.push(...doctors1.map(d => d.get("uid")));
        if (doctors2.length > 0) doctorUids.push(...doctors2.map(d => d.get("uid")));

        query.containedIn("doctorUid", doctorUids);
    }

    query.limit(20);
    const results = await query.find({ sessionToken: user.getSessionToken() });

    if (!results.length) return [];

    return results.map(obj => {
        const doctor = obj.get("doctorDetails");
        const hospital = obj.get("hospitalDetails");
        const specialty = obj.get("specialtyDetails");

        return `
Doctor: ${doctor ? doctor.get("fullname") : "Unknown"}
Hospital: ${hospital ? hospital.get("nameEn") : "Unknown"}
Specialty: ${specialty ? specialty.get("nameEn") : "Unknown"}
Doctor Title: ${doctor ? doctor.get("title") : "Unknown"}
Hospital Address: ${hospital ? hospital.get("addressEn") : "Unknown"}
    `.trim();
    });
}

// -----------------------------------------
// IMPROVED VECTOR SEARCH
// -----------------------------------------

async function performVectorSearch(query, collection, limit = 5, scoreThreshold = 0.5) {
    console.log(`🔍 Performing vector search on ${collection}`);

    // Generate embedding for the query
    const vector = await embed(query);

    // Search with higher limit to get more candidates
    const results = await qdrant.search(collection, {
        vector,
        limit: limit * 2,  // Get more results for filtering
        score_threshold: scoreThreshold  // Only get results above threshold
    });

    // Filter and deduplicate results
    const seen = new Set();
    const filtered = results
        .filter(r => {
            const id = r.payload.parse_id;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .slice(0, limit);  // Take top N after deduplication

    console.log(`📊 Vector search found ${filtered.length} unique results (score threshold: ${scoreThreshold})`);

    return filtered.map(r => r.payload.text);
}

async function ragAnswer(question, user) {
    const route = await determineSearchMethod(question);
    let contextText = "";

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
    } else {
        collection = HOSPITALS_COLLECTION;
        parseQueryFn = executeHospitalParseQuery;
    }

    if (route.type === "PARSE") {
        const parseResults = await parseQueryFn(route.params, user);
        if (parseResults.length > 0) {
            contextText = parseResults.join("\n---\n");
            console.log(`✅ Parse search returned ${parseResults.length} results`);
        } else {
            if (entity !== "RELATIONSHIPS") {
                console.log(`⚠ ${entity} Parse search returned no results, falling back to Vector.`);

                // Improved vector search with better parameters
                const vectorResults = await performVectorSearch(question, collection, 5, 0.4);

                if (vectorResults.length > 0) {
                    contextText = vectorResults.join("\n---\n");
                } else {
                    // Try again with lower threshold if no results
                    console.log(`⚠ Retrying with lower score threshold...`);
                    const retryResults = await performVectorSearch(question, collection, 3, 0.2);
                    contextText = retryResults.join("\n---\n");
                }
            } else {
                console.log(`⚠ ${entity} Parse search returned no results.`);
            }
        }
    } else {
        // VECTOR search - use improved method
        const vectorResults = await performVectorSearch(question, collection, 5, 0.4);

        if (vectorResults.length > 0) {
            contextText = vectorResults.join("\n---\n");
        } else {
            // Fallback with lower threshold
            console.log(`⚠ No results with standard threshold, trying lower threshold...`);
            const retryResults = await performVectorSearch(question, collection, 3, 0.2);
            contextText = retryResults.join("\n---\n");
        }
    }

    if (!contextText) {
        return "I couldn't find related information.";
    }

    // Improved prompt with better instructions
    const prompt = `
You are a helpful medical information assistant. Answer the user's question using ONLY the context provided below.

IMPORTANT RULES:
1. Base your answer ONLY on the information in the context
2. If the context doesn't contain the answer, say: "I don't have that information in my database."
3. Be specific and cite details from the context
4. If multiple options are available, list them clearly
5. For Arabic queries or when Arabic fields are requested, include Arabic information if available

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
// WEBSOCKET SERVER
// -----------------------------------------
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
                    const fixedAnswer = fixEncoding(answer);

                    console.log(`📤 Answer: ${fixedAnswer.substring(0, 100)}...\n`);

                    ws.send(JSON.stringify({
                        type: 'answer',
                        message: fixedAnswer
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
