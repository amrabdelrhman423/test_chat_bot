/**
 * Hospital Validation Prompt
 * Used by validateHospitalMatch() to verify hospital name matches
 */

export function getHospitalValidationPrompt(original, candidate) {
    return `
You are a strict medical facility validator.Your goal is to ensure that a "Candidate" hospital / clinic / medical center name refers to the same "Hospital" mentioned or implied in the "Original" search term.

Original Term: "${original}"
Candidate Match: "${candidate}"

CRITICAL REQUIREMENT:
⚠️ The candidate MUST be a HOSPITAL, CLINIC, or MEDICAL CENTER. 
⚠️ REJECT universities, schools, educational institutions, or general landmarks unless they explicitly contain "Hospital", "Clinic", "Medical Center", "مستشفى", "عيادة", or "مركز طبي".

VALID MATCH RULES:
    1. Hospitals / Clinics ONLY: Candidate must be a medical facility like "مستشفى الجلاء", "Al-Amal Hospital", "Cairo Clinic".
2. Alias / Nickname: Common names for the same facility(e.g., "الجلاء" == "مستشفى الجلاء").
3. Translation: Matches across languages(e.g., "الامل" == "Al-Amal Hospital").
4. Prefix handling: Matches regardless of "Hospital", "Clinic", "Center" prefixes / suffixes.

INVALID MATCH RULES(MUST REJECT):
    1. Universities: "جامعة القاهرة", "Cairo University", "Ain Shams University"(unless it's "Ain Shams University Hospital").
2. Educational Institutions: Schools, colleges, academies(unless they are hospital names).
3. Different Facilities: Clearly different medical locations or organizations.
4. Unrelated: The candidate is a doctor's name, specialty, street name, or landmark, not a facility.
5. General Buildings / Landmarks: Any non - medical entity.

        EXAMPLES:
✅ VALID: "الجلاء" → "مستشفى الجلاء"(same hospital)
✅ VALID: "Al-Amal" → "مستشفى الأمل"(translation match)
✅ VALID: "Ain Shams University Hospital" → "Ain Shams Hospital"(medical facility)
❌ INVALID: "جامعة" → "جامعة القاهرة"(university, not a hospital)
❌ INVALID: "Cairo" → "Cairo University"(educational institution)
❌ INVALID: "Dr. Ahmed" → "مستشفى الجلاء"(doctor name vs hospital)

Output JSON ONLY:
        { "valid": boolean }
            `.trim();
}
