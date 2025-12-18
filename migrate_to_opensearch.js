import dotenv from "dotenv";
dotenv.config();

import { MongoClient } from "mongodb";
import { Client } from "@opensearch-project/opensearch";

const {
    MONGO_URI,
    OPENSEARCH_NODE = "https://localhost:9200",
    OPENSEARCH_USERNAME = "admin",
    OPENSEARCH_PASSWORD = "admin",
    OPENSEARCH_SSL_INSECURE = "true",
    DRY_RUN = "false",
} = process.env;

const DRY = (DRY_RUN + "").toLowerCase() === "true";

// Helper: Arabic Normalizer
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

// Init OpenSearch Client
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

const INDICES = {
    HOSPITALS: "hospitals_docs",
    DOCTORS: "doctors_docs",
    SPECIALTIES: "specialties_docs"
};

if (!MONGO_URI) {
    console.error("Please set MONGO_URI in .env");
    process.exit(1);
}

// -----------------------------------------
// OPENSEARCH HELPERS
// -----------------------------------------
async function recreateIndex(name) {
    if (DRY) {
        console.log(`[DRY] Would recreate Index "${name}"`);
        return;
    }

    try {
        const exists = await clientOS.indices.exists({ index: name });
        if (exists.body) {
            await clientOS.indices.delete({ index: name });
            console.log(`Deleted existing index: ${name}`);
        }
    } catch (e) {
        console.warn(`Error checking/deleting index ${name}:`, e.meta?.body?.error || e.message);
    }

    // Create Index with standard settings
    // We prefer explicit mapping to ensure retrieval works as expected
    const settings = {
        settings: {
            number_of_shards: 1,
            number_of_replicas: 0
        },
        mappings: {
            properties: {
                text: { type: "text", analyzer: "standard" }, // Fallback combined text
                nameEn: { type: "text", analyzer: "standard" },
                nameAr: { type: "text", analyzer: "standard" }, // We will store normalized text here or in a separate field? Let's treat raw as text.
                nameArNormalized: { type: "text", analyzer: "standard" }, // Normalized version for matching
                fullname: { type: "text", analyzer: "standard" },
                mongoId: { type: "keyword" },
                hospitalUid: { type: "keyword" },
                doctorUid: { type: "keyword" },
                specialtyUid: { type: "keyword" }
            }
        }
    };

    try {
        await clientOS.indices.create({ index: name, body: settings });
        console.log(`Created index: ${name}`);
    } catch (e) {
        console.error(`Failed to create index ${name}:`, e.meta?.body?.error || e.message);
        throw e;
    }
}

async function bulkUpsert(indexName, docs) {
    if (DRY || docs.length === 0) return;

    const body = [];
    docs.forEach(doc => {
        // Action
        body.push({ index: { _index: indexName, _id: doc.mongoId } });
        // Document
        body.push(doc);
    });

    try {
        const { body: bulkResponse } = await clientOS.bulk({ refresh: true, body });
        if (bulkResponse.errors) {
            console.log(`⚠️ Bulk items had errors in ${indexName}`);
            // Optional: log specific errors
        }
    } catch (e) {
        console.error(`Bulk upload failed for ${indexName}:`, e.message);
    }
}

// -----------------------------------------
// DOCUMENT BUILDER
// -----------------------------------------
function docToText(collectionName, doc, joins = {}) {
    const pieces = [];
    if (doc.fullname) pieces.push(doc.fullname);
    if (doc.firstName || doc.lastName) pieces.push([doc.firstName || "", doc.lastName || ""].join(" ").trim());
    if (doc.title) pieces.push(doc.title);
    if (doc.positionEn) pieces.push(doc.positionEn);
    if (doc.positionAr) pieces.push(doc.positionAr);
    if (doc.nameEn) pieces.push(`Name(EN): ${doc.nameEn}`);
    if (doc.nameAr) pieces.push(`Name(AR): ${doc.nameAr}`);

    // Joins logic...
    let hUids = doc.hospitalUid ? [String(doc.hospitalUid)] : [];
    let sUids = doc.specialtyUid ? [String(doc.specialtyUid)] : [];

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

    // Fallback generic fields
    if (pieces.length < 5) {
        for (const k of Object.keys(doc)) {
            const v = doc[k];
            if (typeof v === "string" && v.length > 0 && !k.includes("Id") && !k.includes("Uid") && !k.startsWith("_")) {
                pieces.push(`${k}: ${v.slice(0, 120)}`);
                if (pieces.length >= 5) break;
            }
        }
    }

    return `Collection: ${collectionName}. ${pieces.join(" · ")}`.trim();
}

// -----------------------------------------
// MAIN MIGRATION
// -----------------------------------------
async function migrate() {
    console.log(`Starting migration -> OpenSearch: ${OPENSEARCH_NODE}`);

    const clientMongo = new MongoClient(MONGO_URI);
    await clientMongo.connect();
    const db = clientMongo.db();
    console.log("Connected to Mongo:", db.databaseName);

    // 1. Load Joins Data
    const specialties = new Map();
    const hospitals = new Map();
    const doctors = new Map();
    const doctorLinks = new Map();

    console.log("Loading auxiliary data...");
    const sdocs = await db.collection("Specialties").find({}).toArray();
    sdocs.forEach(s => specialties.set(String(s.uid || s._id), s.nameEn || s.nameAr || ""));

    const hdocs = await db.collection("Hospitals").find({}).toArray();
    hdocs.forEach(h => hospitals.set(String(h.uid || h._id), h.nameEn || h.nameAr || ""));

    const ddocs = await db.collection("Doctors").find({}).project({ uid: 1, fullname: 1 }).toArray();
    ddocs.forEach(d => doctors.set(String(d.uid || d._id), d.fullname || ""));

    const links = await db.collection("HospitalDoctorSpecialty").find({}).toArray();
    links.forEach(l => {
        const dUid = String(l.doctorUid);
        if (!doctorLinks.has(dUid)) doctorLinks.set(dUid, []);
        doctorLinks.get(dUid).push({
            hospitalUid: l.hospitalUid ? String(l.hospitalUid) : null,
            specialtyUid: l.specialtyUid ? String(l.specialtyUid) : null
        });
    });

    // 2. Prepare Indices
    const mapping = {
        "Hospitals": INDICES.HOSPITALS,
        "Doctors": INDICES.DOCTORS,
        "Specialties": INDICES.SPECIALTIES
    };

    for (const idx of Object.values(INDICES)) {
        await recreateIndex(idx);
    }

    // 3. Process Collections
    for (const [collName, indexName] of Object.entries(mapping)) {
        console.log(`Processing Mongo Collection: ${collName} -> Index: ${indexName}`);

        const cursor = db.collection(collName).find({});
        let batch = [];
        let count = 0;

        for await (const doc of cursor) {
            const text = docToText(collName, doc, { specialties, hospitals, doctors, doctorLinks });
            // Note: We are no longer embedding here, just text for BM25.
            // Embedding is done in Qdrant migration script.

            const docPayload = {
                mongoId: String(doc._id),
                text: text,
                target_text_normalized: normalizeArabicMedical(text), // normalized text field for robust search
                ...doc
            };

            // Helper: Normalize specific fields if present
            if (doc.nameAr) docPayload.nameArNormalized = normalizeArabicMedical(doc.nameAr);
            if (doc.fullnameAr) docPayload.fullnameArNormalized = normalizeArabicMedical(doc.fullnameAr);

            // Ensure IDs are strings
            if (doc.hospitalUid) docPayload.hospitalUid = String(doc.hospitalUid);
            if (doc.doctorUid) docPayload.doctorUid = String(doc.doctorUid);
            if (doc.specialtyUid) docPayload.specialtyUid = String(doc.specialtyUid);

            batch.push(docPayload);
            count++;

            if (batch.length >= 100) {
                await bulkUpsert(indexName, batch);
                process.stdout.write(".");
                batch = [];
            }
        }

        if (batch.length > 0) await bulkUpsert(indexName, batch);
        console.log(`\nFinished ${indexName}: ${count} docs`);
    }

    await clientMongo.close();
    console.log("Migration complete.");
}

migrate().catch(console.error);
