/**
 * qa_server.js — Robust final version
 * - extractFilters (LLM + regex fallback)
 * - resolve hospital by name or uid
 * - if Qdrant gives no doctorUids, read HospitalDoctorSpecialty links
 * - apply gender + specialty filters correctly (no random doctors)
 * - deduplicate results
 */

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import axios from "axios";
import { MongoClient } from "mongodb";

const {
  OLLAMA_URL = "http://localhost:11434",
  QDRANT_URL = "http://localhost:6333",
  QDRANT_COLLECTION = "parse_docs",
  PORT = 3000,
  MONGO_URI
} = process.env;

console.log("DEBUG: QDRANT_URL is:", QDRANT_URL);


const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

let mongoDb = null;
if (MONGO_URI) {
  const client = new MongoClient(MONGO_URI, { maxPoolSize: 10 });
  client.connect().then(() => {
    mongoDb = client.db();
    console.log("Connected to Mongo:", mongoDb.databaseName);
  }).catch(err => {
    console.warn("Mongo connect error:", err.message || err);
  });
}

// -----------------------------
// Helper: normalize gender
// -----------------------------
function normalizeGender(g) {
  if (!g) return null;
  const s = String(g).trim().toLowerCase();
  if (["female", "f", "woman", "women"].some(x => s.includes(x))) return "female";
  if (["male", "m", "man", "men"].some(x => s.includes(x))) return "male";
  return null;
}

// -----------------------------
// extractFilters(question)
// - tries Llama3; falls back to regex extraction
// returns { hospital, gender, specialty }
// -----------------------------
async function extractFilters(question) {
  // Try LLM extraction first (best-effort)
  try {
    const system = `
You are a JSON-extractor. Given a user question about doctors/hospitals, return STRICT JSON only with keys:
{ "hospital": <string|null>, "gender": "male"|"female"|null, "specialty": <string|null> }
If uncertain about a field, return null for it. No extra text.`;
    const payload = {
      model: "mistral",
      messages: [
        { role: "system", content: system },
        { role: "user", content: question }
      ],
      stream: false
    };
    const r = await axios.post(`${OLLAMA_URL}/api/chat`, payload, { timeout: 60_000 });
    const txt = r.data?.message?.content || (r.data?.choices && r.data.choices[0]?.message?.content) || "";
    const cleaned = String(txt).replace(/```json|```/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      // Normalize gender
      if (parsed && parsed.gender) parsed.gender = normalizeGender(parsed.gender);
      return {
        hospital: parsed?.hospital ?? null,
        gender: parsed?.gender ?? null,
        specialty: parsed?.specialty ?? null
      };
    } catch (e) {
      // fall through to deterministic fallback below
      console.warn("LLM returned non-JSON or unparsable content for filters; fallback to regex.");
    }
  } catch (e) {
    console.warn("LLM filter extraction failed, using fallback. Err:", e.message || e);
  }

  // -----------------------------
  // Regex / heuristic fallback
  // -----------------------------
  const q = question.toLowerCase();

  // Gender detection
  const gender = normalizeGender(
    q.includes("female") || q.includes("women") ? "female" : q.includes("male") || q.includes("men") ? "male" : null
  );

  // Hospital extraction heuristics: search for "in <NAME>" or "at <NAME>" or trailing "hospital"
  let hospital = null;
  const hospRegex = /\b(?:in|at)\s+([A-Za-z\u0600-\u06FF0-9 .'-]{3,100}?(?:hospital|clinic|center|centre)?)(?=$|\swith|\swho|\sthat|\sfor|,|\.)/i;
  const hMatch = question.match(hospRegex);
  if (hMatch && hMatch[1]) hospital = hMatch[1].trim();

  // Specialty detection: find keywords like "cardiologist", "dermatologist", or words before "specialist" etc.
  let specialty = null;
  const specRegex = /\b(cardiolog(?:ist|y)|dermatolog(?:ist|y)|pediatr(?:ician|ics)|gynecolog(?:ist|y)|urolog(?:ist|y)|orthoped(?:ic|rics)|dentist|neurolog(?:ist|y)|psychiatr(?:ist|y)|oncolog(?:ist|y)|infertility|cardiology|obstetric|general practitioner|gp|surgeon|endocrinolog(?:ist|y)|ophthalmolog(?:ist|y))\b/i;
  const sMatch = question.match(specRegex);
  if (sMatch) specialty = sMatch[1].toLowerCase();

  // If not matched, try simple noun before "doctor(s)" or "specialist(s)"
  if (!specialty) {
    const beforeDoctor = question.match(/([A-Za-z\u0600-\u06FF0-9 '-]{3,50})\s+(?:doctor|doctors|specialist|specialists|physician|physicians)/i);
    if (beforeDoctor && beforeDoctor[1]) {
      specialty = beforeDoctor[1].trim();
    }
  }

  return {
    hospital: hospital || null,
    gender: gender || null,
    specialty: specialty || null
  };
}

// -----------------------------
// getEmbeddingOllama
// -----------------------------
async function getEmbeddingOllama(text) {
  const payload = { model: "nomic-embed-text", prompt: text };
  const r = await axios.post(`${OLLAMA_URL}/api/embeddings`, payload, { timeout: 60_000 });
  if (r.data?.embedding) return r.data.embedding;
  if (r.data?.embeddings?.[0]) return r.data.embeddings[0];
  if (Array.isArray(r.data)) return r.data;
  throw new Error("Unexpected embedding output");
}

// -----------------------------
// qdrantSearch
// -----------------------------
async function qdrantSearch(vec, top = 5) {
  const url = `${QDRANT_URL}/collections/${QDRANT_COLLECTION}/points/search`;
  console.log("DEBUG: qdrantSearch URL:", url);
  const r = await axios.post(url, { vector: vec, limit: top, with_payload: true }, { timeout: 120_000 });
  return r.data?.result || [];
}

// -----------------------------
// Summarize answer (short)
// -----------------------------
async function summarizeDoctors(question, doctors, hospitalName = "") {
  try {
    const payload = {
      model: "mistral",
      messages: [
        { role: "system", content: "You answer with one short factual sentence." },
        {
          role: "user",
          content: `Question: ${question}
Hospital: ${hospitalName}
Doctors (${doctors.length}):
${JSON.stringify(doctors.slice(0, 30), null, 2)}

Write a short factual one-sentence answer.`
        }
      ],
      stream: false
    };
    const r = await axios.post(`${OLLAMA_URL}/api/chat`, payload, { timeout: 120_000 });
    return r.data?.message?.content || (r.data?.choices?.[0]?.message?.content) || "";
  } catch (e) {
    // fallback textual summary if LLM fails
    const names = doctors.map(d => d.fullname || d.name).filter(Boolean).slice(0, 5);
    return `Found ${doctors.length} doctor(s) in ${hospitalName}: ${names.join(", ")}${doctors.length > 5 ? "..." : ""}`;
  }
}

// -----------------------------
// MAIN /query
// -----------------------------
app.post("/query", async (req, res) => {
  try {
    const { question, topK } = req.body;

    console.log("DEBUG: Received question:", question);

    if (!question) return res.status(400).json({ error: "question required" });
    console.log("DEBUG: Received question:", question);
    if (!mongoDb) return res.status(500).json({ error: "MongoDB not connected" });

    const k = Number(topK) || 5;

    // 1) Extract filters (LLM + fallback)
    console.log("DEBUG: Calling extractFilters");
    const filters = await extractFilters(question);
    console.log("DEBUG: extractFilters done", filters);
    const requestedGender = normalizeGender(filters.gender);
    const requestedSpecialtyRaw = filters.specialty ? String(filters.specialty).trim() : null;
    const requestedHospitalName = filters.hospital ? String(filters.hospital).trim() : null;

    // 2) Embed & retrieve RAG contexts (still useful for hospital uid detection)
    console.log("DEBUG: Calling getEmbeddingOllama");
    const qVec = await getEmbeddingOllama(question);
    console.log("DEBUG: getEmbeddingOllama done");
    console.log("DEBUG: Calling qdrantSearch");
    const matches = await qdrantSearch(qVec, k);
    console.log("DEBUG: qdrantSearch done");

    // 3) Extract detected hospitalUid and doctorUids from Qdrant results
    let detectedHospitalUid = null;
    const doctorUidsFromQdrant = new Set();
    for (const m of matches) {
      const p = m.payload || {};
      if (p._collection && p._collection.toLowerCase() === "hospitaldoctorspecialty") {
        if (p.hospitalUid) detectedHospitalUid = p.hospitalUid;
        if (p.doctorUid) doctorUidsFromQdrant.add(String(p.doctorUid));
      }
      // also accept payloads that directly come from Hospitals or Doctors collections
      if (p._collection && p._collection.toLowerCase() === "hospitals" && !detectedHospitalUid) {
        if (p.uid) detectedHospitalUid = p.uid;
      }
    }

    // 4) Resolve hospital record (priority: explicit request > qdrant-detected)
    let hospitalRecord = null;
    if (requestedHospitalName) {
      hospitalRecord = await mongoDb.collection("Hospitals").findOne({
        $or: [{ nameEn: requestedHospitalName }, { nameAr: requestedHospitalName }]
      });
    }
    if (!hospitalRecord && detectedHospitalUid) {
      hospitalRecord = await mongoDb.collection("Hospitals").findOne({ uid: detectedHospitalUid });
    }

    if (!hospitalRecord) {
      return res.json({
        answer: "Hospital not found in our system.",
        hospitalUid: null,
        hospitalName: null,
        totalDoctors: 0,
        doctors: [],
        matches: []
      });
    }

    const hospitalUid = hospitalRecord.uid;
    const hospitalName = hospitalRecord.nameEn || hospitalRecord.nameAr || "";

    // 5) Determine doctor UIDs to query:
    // - prefer Qdrant doctor UIDs if present
    // - otherwise load all doctorUid links for this hospital from HospitalDoctorSpecialty
    let doctorUidsToQuery = [...doctorUidsFromQdrant];
    if (doctorUidsToQuery.length === 0) {
      // load links for this hospital
      const links = await mongoDb.collection("HospitalDoctorSpecialty").find({ hospitalUid }).project({ doctorUid: 1 }).toArray();
      doctorUidsToQuery = links.map(l => String(l.doctorUid)).filter(Boolean);
    }

    // If hospital has zero linked doctors -> say so
    if (doctorUidsToQuery.length === 0) {
      return res.json({
        answer: "No doctors available in this hospital.",
        hospitalUid,
        hospitalName,
        totalDoctors: 0,
        doctors: [],
        matches: []
      });
    }

    // 6) Build doctor query: must belong to these UIDs AND (optionally) match gender
    const doctorQuery = { uid: { $in: doctorUidsToQuery } };

    if (requestedGender) doctorQuery.gender = requestedGender;

    // 7) Pull doctors from Doctors collection
    let doctors = await mongoDb.collection("Doctors")
      .find(doctorQuery)
      .project({ uid: 1, fullname: 1, gender: 1, yrsExp: 1, specialtyUid: 1, hospitalUid: 1 })
      .toArray();

    // 8) If specialty requested, resolve specialty uid then filter
    if (requestedSpecialtyRaw) {
      // first try exact nameEn/nameAr match
      const spec = await mongoDb.collection("Specialties").findOne({
        $or: [{ nameEn: requestedSpecialtyRaw }, { nameAr: requestedSpecialtyRaw }]
      });

      if (!spec) {
        // try matching by substring (case-insensitive) as fallback
        const specCandidate = await mongoDb.collection("Specialties")
          .findOne({ nameEn: { $regex: requestedSpecialtyRaw, $options: "i" } }) ||
          await mongoDb.collection("Specialties")
            .findOne({ nameAr: { $regex: requestedSpecialtyRaw, $options: "i" } });

        if (specCandidate) {
          doctors = doctors.filter(d => d.specialtyUid === specCandidate.uid);
        } else {
          // no specialty match => no doctors
          doctors = [];
        }
      } else {
        doctors = doctors.filter(d => d.specialtyUid === spec.uid);
      }
    }

    // 9) No doctors after applying filters
    if (!doctors || doctors.length === 0) {
      return res.json({
        answer: `No doctors found matching your request in ${hospitalName}.`,
        hospitalUid,
        hospitalName,
        totalDoctors: 0,
        doctors: [],
        matches: []
      });
    }

    // 10) Deduplicate by uid and ensure hospitalUid is set to hospitalUid (safety)
    const uniqueMap = new Map();
    for (const d of doctors) {
      uniqueMap.set(d.uid, { ...d, hospitalUid: d.hospitalUid || hospitalUid });
    }
    const uniqueDoctors = Array.from(uniqueMap.values());

    // 11) Build enriched matches: attach doctor_info where available
    const enrichedMatches = matches.map(m => {
      const p = m.payload || {};
      const docInfo = p.doctorUid ? uniqueDoctors.find(d => d.uid === String(p.doctorUid)) : null;
      return { ...m, doctor_info: docInfo || null };
    });

    // 12) Summarize using Llama (short)
    const summary = await summarizeDoctors(question, uniqueDoctors, hospitalName);

    // 13) Return
    return res.json({
      answer: summary,
      hospitalUid,
      hospitalName,
      totalDoctors: uniqueDoctors.length,
      doctors: uniqueDoctors,
      matches: enrichedMatches
    });

  } catch (err) {
    console.error("Query error:", err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.listen(PORT, () => console.log(`QA Server running at http://localhost:${PORT}`));
