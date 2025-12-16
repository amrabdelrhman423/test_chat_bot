
import fs from 'fs';

const prompt = `
   - User says "عين شمس" → output "عين شمس" (NOT "Ain Shams")
   - User says "السلام" → output "السلام" (NOT "Al Salam")
   - User says "الماسه" → output "الماسه" (NOT "الماسة" - keep ه not ة)
`;

console.log(prompt);
