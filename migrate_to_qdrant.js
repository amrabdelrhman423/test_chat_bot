// migrate_to_qdrant.js
import dotenv from "dotenv";
dotenv.config();

import axios from "axios";
import { MongoClient } from "mongodb";

const {
  MONGO_URI,
  OLLAMA_URL = "http://localhost:11434",
  QDRANT_URL = "http://localhost:6333",
  QDRANT_COLLECTION = "parse_docs",
  VECTOR_SIZE = "768",
  DRY_RUN = "false",
} = process.env;

const DRY = (DRY_RUN + "").toLowerCase() === "true";
const VECTOR_DIMENSION = Number(VECTOR_SIZE);
if (!MONGO_URI) {
  console.error("Please set MONGO_URI in .env");
  process.exit(1);
}
if (isNaN(VECTOR_DIMENSION) || VECTOR_DIMENSION <= 0) {
  console.error("VECTOR_SIZE must be a positive number");
  process.exit(1);
}

let globalPointIdCounter = 0;

async function getEmbeddingOllama(text) {
  const payload = { model: "nomic-embed-text", prompt: text };
  try {
    const r = await axios.post(`${OLLAMA_URL}/api/embeddings`, payload, { timeout: 120_000 });
    // common shapes
    if (Array.isArray(r.data) && r.data.every(n => typeof n === "number")) return r.data;
    if (r.data?.embedding && Array.isArray(r.data.embedding)) return r.data.embedding;
    if (r.data?.embeddings && Array.isArray(r.data.embeddings) && r.data.embeddings[0]) return r.data.embeddings[0];
    throw new Error("Unexpected Ollama embedding response: " + JSON.stringify(r.data).slice(0, 200));
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      console.error("Ollama embedding failed (status):", err.response.status, err.response.data);
      throw new Error("Ollama embedding HTTP error");
    }
    console.error("Ollama embedding network error:", err.message || err);
    throw err;
  }
}

async function recreateQdrantCollection(name, size) {
  if (DRY) {
    console.log(`[DRY] Would recreate Qdrant collection "${name}" size=${size}`);
    return;
  }
  // delete then create
  try {
    await axios.delete(`${QDRANT_URL}/collections/${encodeURIComponent(name)}`);
    console.log("Deleted existing collection (if existed).");
  } catch (e) {
    // ignore
  }
  const cfg = { vectors: { size, distance: "Cosine" } };
  const r = await axios.put(`${QDRANT_URL}/collections/${encodeURIComponent(name)}`, cfg);
  if (r.status >= 300) throw new Error("Failed create qdrant collection: " + r.status);
  console.log("Qdrant collection created:", name);
}

async function upsertPointsQdrant(name, points) {
  if (DRY) {
    console.log(`[DRY] upsert ${points.length} points`);
    return;
  }
  const url = `${QDRANT_URL}/collections/${name}/points?wait=true`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await axios.put(url, { points }, {
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120_000
      });
      return;
    } catch (err) {
      console.log(`⚠️ Qdrant upsert failed (attempt ${attempt}/5):`, err.message);
      await new Promise(r => setTimeout(r, attempt * 500));
      if (attempt === 5) throw err;
    }
  }
}

function docToText(collectionName, doc, joins = {}) {
  const pieces = [];
  if (doc.fullname) pieces.push(doc.fullname);
  if (doc.firstName || doc.lastName) pieces.push([doc.firstName || "", doc.lastName || ""].join(" ").trim());
  if (doc.title) pieces.push(doc.title);
  if (doc.positionEn) pieces.push(doc.positionEn);
  if (doc.positionAr) pieces.push(doc.positionAr);
  if (doc.nameEn) pieces.push(`Name(EN): ${doc.nameEn}`);
  if (doc.nameAr) pieces.push(`Name(AR): ${doc.nameAr}`);

  // Use direct fields if available, otherwise check links
  let hUids = doc.hospitalUid ? [String(doc.hospitalUid)] : [];
  let sUids = doc.specialtyUid ? [String(doc.specialtyUid)] : [];

  // If this is a Doctor, check the links map
  if (collectionName === 'Doctors' && joins.doctorLinks) {
    const docUid = String(doc.uid || doc.objectId || doc._id || "");
    const links = joins.doctorLinks.get(docUid);
    if (links) {
      links.forEach(l => {
        if (l.hospitalUid) hUids.push(l.hospitalUid);
        if (l.specialtyUid) sUids.push(l.specialtyUid);
      });
    }
  }

  // Deduplicate
  hUids = [...new Set(hUids)];
  sUids = [...new Set(sUids)];

  hUids.forEach(uid => {
    if (joins.hospitals?.get(uid)) pieces.push("Hospital: " + joins.hospitals.get(uid));
  });
  sUids.forEach(uid => {
    if (joins.specialties?.get(uid)) pieces.push("Specialty: " + joins.specialties.get(uid));
  });

  if (doc.doctorUid && joins.doctors?.get(String(doc.doctorUid))) pieces.push("Doctor: " + joins.doctors.get(String(doc.doctorUid)));

  if (pieces.length < 5) {
    for (const k of Object.keys(doc)) {
      const v = doc[k];
      if (typeof v === "string" && v.length > 0 && !k.includes("Id") && !k.includes("Uid") && !k.startsWith("_")) {
        pieces.push(`${k}: ${v.slice(0, 120)}`);
        if (pieces.length >= 5) break;
      }
    }
  }
  const text = `Collection: ${collectionName}. ${pieces.join(" · ")}`.trim();
  return text || JSON.stringify(doc).slice(0, 500);
}

async function migrate() {
  console.log(`Starting migration -> Qdrant: ${QDRANT_URL}/${QDRANT_COLLECTION} (dim=${VECTOR_DIMENSION})`);
  const client = new MongoClient(MONGO_URI, { maxPoolSize: 10 });
  await client.connect();
  const db = client.db();
  console.log("Connected to Mongo:", db.databaseName);

  // Build lookup maps for hospitals, specialties, doctors
  const specialties = new Map();
  const hospitals = new Map();
  const doctors = new Map();

  try {
    const sdocs = await db.collection("Specialties").find({}).toArray().catch(() => []);
    sdocs.forEach(s => specialties.set(String(s.uid || s.objectId || s._id || ""), s.nameEn || s.nameAr || s.name || ""));
    console.log("Loaded specialties:", specialties.size);
  } catch (e) { console.warn("Specialties load error", e.message); }

  try {
    const hdocs = await db.collection("Hospitals").find({}).toArray().catch(() => []);
    hdocs.forEach(h => hospitals.set(String(h.uid || h.objectId || h._id || ""), h.nameEn || h.nameAr || h.name || ""));
    console.log("Loaded hospitals:", hospitals.size);
  } catch (e) { console.warn("Hospitals load error", e.message); }

  // Load HospitalDoctorSpecialty links
  const doctorLinks = new Map(); // doctorUid -> { hospitalUid, specialtyUid }[]
  try {
    const links = await db.collection("HospitalDoctorSpecialty").find({}).toArray().catch(() => []);
    links.forEach(l => {
      const dUid = String(l.doctorUid || "");
      if (!dUid) return;
      if (!doctorLinks.has(dUid)) doctorLinks.set(dUid, []);
      doctorLinks.get(dUid).push({
        hospitalUid: l.hospitalUid ? String(l.hospitalUid) : null,
        specialtyUid: l.specialtyUid ? String(l.specialtyUid) : null
      });
    });
    console.log("Loaded HospitalDoctorSpecialty links:", links.length);
  } catch (e) { console.warn("HospitalDoctorSpecialty load error", e.message); }

  try {
    const ddocs = await db.collection("Doctors").find({}).project({ uid: 1, fullname: 1, firstName: 1, lastName: 1 }).toArray().catch(() => []);
    ddocs.forEach(d => doctors.set(String(d.uid || d.objectId || d._id || ""), d.fullname || `${d.firstName || ""} ${d.lastName || ""}`.trim() || ""));
    console.log("Loaded doctors:", doctors.size);
  } catch (e) { console.warn("Doctors load error", e.message); }

  await recreateQdrantCollection(QDRANT_COLLECTION, VECTOR_DIMENSION);

  // list collections
  const collections = await db.listCollections().toArray();
  const skip = new Set(["system.indexes", "system.profile", "fs.files", "fs.chunks", "sessions"]);
  for (const coll of collections) {
    const collName = coll.name;
    if (skip.has(collName)) continue;
    console.log(`Processing collection: ${collName}`);

    const cursor = db.collection(collName).find({});
    const batch = [];
    let processed = 0;
    const BATCH = 128;

    for await (const doc of cursor) {
      const text = docToText(collName, doc, { specialties, hospitals, doctors, doctorLinks });
      if (!text || text.length < 6) continue;
      let vec;
      try {
        vec = await getEmbeddingOllama(text);
      } catch (e) {
        console.warn("Embedding failed for doc, skipping");
        continue;
      }

      const mongoIdStr = doc._id && doc._id.toString ? doc._id.toString() : String(doc._id || doc.objectId || "");
      const payload = { _collection: collName, mongoId: mongoIdStr };
      if (doc.hospitalUid) payload.hospitalUid = String(doc.hospitalUid);
      if (doc.doctorUid) payload.doctorUid = String(doc.doctorUid);
      if (doc.specialtyUid) payload.specialtyUid = String(doc.specialtyUid);
      if (doc.uid) payload.uid = String(doc.uid);
      if (doc.fullname) payload.name = String(doc.fullname);
      if (doc.title) payload.title = String(doc.title);

      globalPointIdCounter++;
      batch.push({ id: globalPointIdCounter, vector: vec, payload });
      processed++;

      if (batch.length >= BATCH) {
        await upsertPointsQdrant(QDRANT_COLLECTION, batch.splice(0, BATCH));
        process.stdout.write(".");
      }
    }

    if (batch.length) await upsertPointsQdrant(QDRANT_COLLECTION, batch.splice(0));
    console.log(`\nDone ${collName}: processed ${processed}`);
  }

  await client.close();
  console.log("Migration complete. Total points:", globalPointIdCounter);
}

migrate().catch(err => {
  console.error("Migration failed:", err);
  process.exit(1);
});
