/**
 * Prompts Index
 * Central export point for all prompt templates
 */

export { getMedicalQueryRouterPrompt } from './medicalQueryRouter.js';
export { getEntityExtractionPrompt } from './entityExtraction.js';
export { getSpecialtyValidationPrompt } from './specialtyValidation.js';
export { getDoctorValidationPrompt } from './doctorValidation.js';
export { getHospitalValidationPrompt } from './hospitalValidation.js';
export { getVectorSearchStrategyPrompt } from './vectorSearchStrategy.js';
export { getAIResponsePrompt, getLanguageInstruction } from './aiResponse.js';
