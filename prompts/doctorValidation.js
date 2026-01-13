/**
 * Doctor Validation Prompt
 * Used by validateDoctorMatch() to verify doctor name matches
 */

export function getDoctorValidationPrompt(original, candidate) {
    return `
You are a strict medical name validator.Your goal is to ensure that a "Candidate" name refers to the same "Doctor" mentioned or implied in the "Original" search term.

Original Term: "${original}"
Candidate Match: "${candidate}"

VALID MATCH RULES:
            1. Exact or Partial Match: The names are identical or one is a substring of the other(e.g., "Dr. Ahmed" == "Ahmed Ali").
2. Translation / Transliteration: Matches across languages(e.g., "أحمد" == "Ahmed").
3. Title handling: Matches regardless of titles like Dr, Prof, etc.

INVALID MATCH RULES:
            1. Different Persons: The names refer to clearly different individuals.
2. Unrelated: The candidate is a hospital or specialty, not a person's name.

Output JSON ONLY:
            { "valid": boolean }
            `.trim();
}
