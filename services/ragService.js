import ollama from "ollama";
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { fixEncoding } from '../utils/encoding.js';
import {
    getMedicalQueryRouterPrompt,
    getEntityExtractionPrompt,
    getSpecialtyValidationPrompt,
    getDoctorValidationPrompt,
    getHospitalValidationPrompt,
    getVectorSearchStrategyPrompt,
    getAIResponsePrompt,
    getLanguageInstruction
} from '../prompts/index.js';

import { performVectorSearch } from './vectorSearchService.js';
import {
    executeHospitalParseQuery,
    executeDoctorParseQuery,
    executeSpecialtiesParseQuery,
    executeCityParseQuery,
    executeAreaParseQuery,
    executeRelationshipQuery
} from './parseSearchService.js';

import {
    HOSPITALS_COLLECTION,
    DOCTORS_COLLECTION,
    SPECIALTIES_COLLECTION,
    CITIES_COLLECTION,
    AREAS_COLLECTION
} from '../config/vectorDbConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LLM_MODEL = process.env.LLM_MODEL || "qwen3";

function loadSchema() {
    try {
        const schemaPath = path.join(process.cwd(), 'schema.json');
        if (!fs.existsSync(schemaPath)) return "";
        const schemaRaw = fs.readFileSync(schemaPath, 'utf8');
        const schemaJson = JSON.parse(schemaRaw);
        const targetClasses = ["Hospitals", "Doctors", "Specialties", "HospitalDoctorSpecialty", "Cities", "Areas", "DoctorAppointments"];
        let schemaSummary = "";
        schemaJson.forEach(cls => {
            if (targetClasses.includes(cls.className)) {
                schemaSummary += `Class: ${cls.className}\nFields:\n`;
                for (const [fieldName, fieldDef] of Object.entries(cls.fields)) {
                    schemaSummary += `  - ${fieldName} (${fieldDef.type})\n`;
                }
                schemaSummary += "\n";
            }
        });
        return schemaSummary;
    } catch (e) { return ""; }
}

export async function determineSearchMethod(query) {
    const schemaContext = loadSchema();
    const prompt = getMedicalQueryRouterPrompt(query, schemaContext);
    try {
        const response = await ollama.generate({ model: LLM_MODEL, prompt, format: "json", stream: false });
        let cleaned = response.response.trim();
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end !== -1) cleaned = cleaned.substring(start, end + 1);

        let result = JSON.parse(fixEncoding(cleaned));

        // Repair logic (Simplified for service)
        const arabicRegex = /[\u0600-\u06FF]/;
        if (arabicRegex.test(query) && result.params) {
            const hasEnglishValue = (val) => val && /^[a-zA-Z\s]+$/.test(val);
            const fieldsToCheck = ["value", "hospitalName", "doctorName", "location", "address"];
            fieldsToCheck.forEach(key => {
                if (result.params[key] && hasEnglishValue(result.params[key])) {
                    // This is a placeholder for the more complex extraction logic 
                    // which we can keep or move into a utility if needed.
                }
            });
        }

        if (result.params) {
            const clean = (val) => val ? val.replace(/^(Dr\.?|Doctor|Prof\.?|د\.|دكتور|دكتورة|مستشفى|مستشفي|د)\s+/i, "").trim() : val;
            if (result.params.doctorName) result.params.doctorName = clean(result.params.doctorName);
            if (result.params.fullname) result.params.fullname = clean(result.params.fullname);
        }
        return result;
    } catch (e) { return { operation: "vector_search", entity: "HOSPITALS", follow_up: true }; }
}

export async function extractEntityFromContext(question, contextChunks) {
    if (!contextChunks || contextChunks.length === 0) return null;
    const context = contextChunks.slice(0, 3).map(chunk => {
        if (typeof chunk === 'string') return chunk;
        return `[Source: ${chunk.collectionName || "Unknown"}] ${chunk.text || chunk.nameAr || chunk.nameEn || ""}`;
    }).join("\n");

    try {
        const response = await ollama.generate({ model: LLM_MODEL, prompt: getEntityExtractionPrompt(question, context), format: "json", stream: false });
        const result = JSON.parse(fixEncoding(response.response));
        return result.found ? result : null;
    } catch (e) { return null; }
}

export async function validateSpecialtyMatch(original, candidate) {
    if (!original) return true;
    try {
        const response = await ollama.generate({ model: LLM_MODEL, prompt: getSpecialtyValidationPrompt(original, candidate), format: "json", stream: false });
        return JSON.parse(response.response).valid;
    } catch (e) { return false; }
}

export async function validateDoctorMatch(original, candidate) {
    if (!original) return true;
    try {
        const response = await ollama.generate({ model: LLM_MODEL, prompt: getDoctorValidationPrompt(original, candidate), format: "json", stream: false });
        return JSON.parse(response.response).valid;
    } catch (e) { return false; }
}

export async function validateHospitalMatch(original, candidate) {
    if (!original) return true;
    try {
        const response = await ollama.generate({ model: LLM_MODEL, prompt: getHospitalValidationPrompt(original, candidate), format: "json", stream: false });
        return JSON.parse(response.response).valid;
    } catch (e) { return false; }
}

export async function optimizeVectorSearchStrategy(query) {
    try {
        const response = await ollama.generate({ model: LLM_MODEL, prompt: getVectorSearchStrategyPrompt(query), format: "json", stream: false });
        return JSON.parse(response.response);
    } catch (e) { return { collection: HOSPITALS_COLLECTION, optimizedQuery: query }; }
}

export async function generateAIResponse(question, contextText) {
    if (!contextText) return "I couldn't find related information.";
    try {
        const response = await ollama.generate({
            model: LLM_MODEL,
            prompt: getAIResponsePrompt(question, contextText, getLanguageInstruction(question)),
            options: { num_ctx: 8192, num_predict: -1, stop: ["QUESTION:", "CONTEXT:", "ANSWER:"] }
        });
        let rawAnswer = (response.response || "").trim();
        if (/[\u00D8-\u00DB]/.test(rawAnswer)) rawAnswer = fixEncoding(rawAnswer);
        return rawAnswer;
    } catch (e) { return "I'm sorry, I encountered an error."; }
}

function determineVectorStrategyFromParams(params) {
    if (!params) return null;
    if (params.hospitalName && params.specialtyName) {
        return { type: 'multi', queries: [{ collection: HOSPITALS_COLLECTION, query: params.hospitalName }, { collection: SPECIALTIES_COLLECTION, query: params.specialtyName }] };
    }
    if (params.doctorName && params.hospitalName) {
        return { type: 'multi', queries: [{ collection: DOCTORS_COLLECTION, query: params.doctorName }, { collection: HOSPITALS_COLLECTION, query: params.hospitalName }] };
    }
    if (params.hospitalName) return { collection: HOSPITALS_COLLECTION, optimizedQuery: params.hospitalName };
    return null;
}

export async function ragAnswer(question, user) {
    const route = await determineSearchMethod(question);
    let contextText = "";
    let vectorResults = [];
    let parseResults = [];
    const entity = route.entity || "HOSPITALS";

    let collection;
    let parseQueryFn;

    if (entity === "DOCTORS") { collection = DOCTORS_COLLECTION; parseQueryFn = executeDoctorParseQuery; }
    else if (entity === "SPECIALTIES") { collection = SPECIALTIES_COLLECTION; parseQueryFn = executeSpecialtiesParseQuery; }
    else if (entity === "RELATIONSHIPS") {
        parseQueryFn = executeRelationshipQuery;
        collection = (route.params?.queryType === "specialistsAtHospital" || route.params?.specialtyName) ? SPECIALTIES_COLLECTION : HOSPITALS_COLLECTION;
    }
    else if (entity === "AREAS") { collection = AREAS_COLLECTION; parseQueryFn = executeAreaParseQuery; }
    else if (entity === "CITIES") { collection = CITIES_COLLECTION; parseQueryFn = executeCityParseQuery; }
    else { collection = HOSPITALS_COLLECTION; parseQueryFn = executeHospitalParseQuery; }

    if (route.operation === "combined") {
        let strategy = determineVectorStrategyFromParams(route.params) || await optimizeVectorSearchStrategy(question);
        if (strategy.type === 'multi') {
            const results = await Promise.all(strategy.queries.map(q => performVectorSearch(fixEncoding(q.query), fixEncoding(q.collection), 5, 0.4)));
            const uniqueMap = new Map();
            results.flat().forEach(r => { const id = r.mongoId || r.id; if (!uniqueMap.has(id) || r.score > uniqueMap.get(id).score) uniqueMap.set(id, r); });
            vectorResults = [...uniqueMap.values()].sort((a, b) => b.score - a.score);
        } else {
            let targetCol = strategy.collection || HOSPITALS_COLLECTION;
            vectorResults = await performVectorSearch(fixEncoding(strategy.optimizedQuery), targetCol, 5, 0.4);
        }

        if (route.params) {
            const extraction = await extractEntityFromContext(question, vectorResults);
            if (extraction?.entities) {
                for (const ent of extraction.entities) {
                    if (ent.type === "SPECIALTIES" && route.params.queryType === "specialistsAtHospital" && await validateSpecialtyMatch(question, ent.value)) {
                        route.params.specialtyName = ent.value;
                        break;
                    }
                }
            }
            parseResults = await parseQueryFn(route.params, user);
            if (parseResults.length > 0) contextText = `=== RECORD MATCHES ===\n` + parseResults.join("\n---\n");
            else contextText = `=== TEXT DATA ===\n` + vectorResults.map(r => r.text || r.nameAr || r.nameEn || "").join("\n---\n");
        }
    } else if (route.operation === "parse_search") {
        parseResults = await parseQueryFn(route.params, user);
        contextText = parseResults.length > 0 ? parseResults.join("\n---\n") : "";
    } else {
        const strategy = await optimizeVectorSearchStrategy(question);
        vectorResults = await performVectorSearch(fixEncoding(strategy.optimizedQuery), strategy.collection, 5, 0.4);
        contextText = vectorResults.map(r => r.text || r.nameAr || r.nameEn || "").join("\n---\n");
    }

    return await generateAIResponse(question, contextText);
}
