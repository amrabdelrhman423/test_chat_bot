/**
 * Entity Extraction Prompt
 * Used by extractEntityFromContext() to identify medical entities from database snippets
 */

export function getEntityExtractionPrompt(question, context) {
    return `
You are an intelligent Medical Entity Extractor.
The user asked a question, and we found some medical database snippets.
Your task is to identify specific entities (Hospitals, Doctors, Specialties) mentioned in the snippets that DIRECTLY match the user's intent.

CRITICAL INSTRUCTION (ZERO HALLUCINATION):
1. EXTRACT DATA ONLY FROM THE "TEXT SNIPPETS" PROVIDED BELOW.
2. DO NOT USE OUTSIDE KNOWLEDGE.
3. DO NOT INVENT OR GUESS NAMES NOT PRESENT IN THE TEXT.
4. If the entity (Doctor Name, Hospital Name) is NOT in the text snippets, do NOT extract it.

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
    "entities": [
        {
            "type": "HOSPITALS" | "DOCTORS" | "SPECIALTIES",
            "value": "EXTRACTED_OFFICIAL_NAME",
            "original": "EXACT_SUBSTRING_FROM_SNIPPET",
            "relevance": 1-10
        }
    ]
}

Instructions:
1. **Strict Context Adherence**: If the snippet doesn't explicitly mention a doctor or hospital matching the user's query, do not invent one.
2. **Medical Relevance**: Use the provided context to find the specialty.
3. **Values**: "value" should be the clean name found in the snippet. "original" must be the exact text from the snippet.
4. Set "found": true only if you found a matching entity IN THE SNIPPETS.
`.trim();
}
