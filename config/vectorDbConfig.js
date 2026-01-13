
import { QdrantClient } from "@qdrant/js-client-rest";
import { Client as OpenSearchClient } from "@opensearch-project/opensearch"; // Aliased for clarity
import 'dotenv/config';

// -----------------------------------------
// QDRANT CONFIG
// -----------------------------------------
const QDRANT_URL = process.env.QDRANT_URL || "http://127.0.0.1:6333";

export const HOSPITALS_COLLECTION = "hospitals_docs";
export const DOCTORS_COLLECTION = "doctors_docs";
export const SPECIALTIES_COLLECTION = "specialties_docs";
export const CITIES_COLLECTION = "cities_docs";
export const AREAS_COLLECTION = "areas_docs";

export const qdrant = new QdrantClient({ url: QDRANT_URL });

// -----------------------------------------
// OPENSEARCH CONFIG
// -----------------------------------------
const OPENSEARCH_NODE = process.env.OPENSEARCH_NODE || "https://localhost:9200";
const OPENSEARCH_USERNAME = process.env.OPENSEARCH_USERNAME || "admin";
const OPENSEARCH_PASSWORD = process.env.OPENSEARCH_PASSWORD || "admin";
const OPENSEARCH_SSL_INSECURE = process.env.OPENSEARCH_SSL_INSECURE || "true";

export const clientOS = new OpenSearchClient({
    node: OPENSEARCH_NODE,
    auth: {
        username: OPENSEARCH_USERNAME,
        password: OPENSEARCH_PASSWORD,
    },
    ssl: {
        rejectUnauthorized: OPENSEARCH_SSL_INSECURE !== "true",
    },
});

console.log("✔ Qdrant & OpenSearch Clients Initialized");
