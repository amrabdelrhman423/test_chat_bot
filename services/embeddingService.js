
import fetch from 'node-fetch';

/**
 * Generate embeddings for the given text using local Jina v3 server or fallbacks
 * @param {string} text - Text to embed
 * @param {string} task - Task type for the embedding model
 * @returns {Promise<Array<number>>} - 1024-dimensional embedding vector
 */
export async function embed(text, task = "retrieval.query") {

    // 1. Try Local Jina v3 FastAPI Server (Port 8000)
    try {
        console.log(`🔍 Generating Jina v3 embedding (1024 dims) via LOCAL SERVER for: "${text.substring(0, 30)}..."`);
        const localResponse = await fetch("http://localhost:8000/v1/embeddings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: text, task: task })
        });

        if (localResponse.ok) {
            const result = await localResponse.json();
            console.log("✅ Local Jina server response:", result);

            if (result.data && result.data[0].embedding) {
                const vector = result.data[0].embedding;
                if (vector.length !== 1024) {
                    console.warn(`⚠️ Local Jina server returned ${vector.length} dims, expected 1024!`);
                }
                return vector;
            }
        }
        console.warn("⚠️ Local Jina server returned error or invalid format, trying HF API...");
    } catch (err) {
        console.warn("⚠️ Local Jina server unreachable, trying HF API...");
    }

    // 2. Try Hugging Face API Fallback
    try {
        const HF_TOKEN = process.env.HF_TOKEN;
        const MODEL_ID = process.env.EMBED_MODEL || "jinaai/jina-embeddings-v3";

        if (HF_TOKEN) {
            console.log(`🔍 Generating Jina v3 embedding via HF API for: "${text.substring(0, 30)}..."`);
            const hfResponse = await fetch(`https://api-inference.huggingface.co/models/${MODEL_ID}`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${HF_TOKEN}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ inputs: text, parameters: { task: task } })
            });

            if (hfResponse.ok) {
                const vector = await hfResponse.json();
                if (Array.isArray(vector)) return vector;
                // Handle complex response if any
                if (vector.data && Array.isArray(vector.data)) return vector.data;
                return vector;
            }
        }
    } catch (hfErr) {
        console.warn("⚠️ HF API Fallback failed:", hfErr.message);
    }

    return [];
}
