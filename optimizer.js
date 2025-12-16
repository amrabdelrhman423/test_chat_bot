
async function optimizeVectorSearchStrategy(query) {
    const prompt = `
You are a vector search optimizer for a medical database.
Collections:
1. hospitals_docs: Hospital names, addresses, facilities, types.
2. doctors_docs: Doctor names, titles, qualifications, languages.
3. specialties_docs: Medical specialties, disease names, symptoms, treatments.

User Query: "${query}"

Task:
1. "collection": Select the ONE best collection to search. 
   - If asking about a disease/symptom -> specialties_docs
   - If asking about a specific doctor -> doctors_docs
   - If asking about a hospital -> hospitals_docs
2. "optimizedQuery": Rewrite the query for vector similarity.
   - Remove stop words (is, the, etc.)
   - Translate to English if needed (database is mixed but English is better for medical terms)
   - Keep key medical terms.

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
