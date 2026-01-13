
/**
 * Format decimal time (e.g., 14.5) to AM/PM string (e.g., "02:30 PM")
 * @param {number} decimalTime - Time in decimal format
 * @returns {string} - Formatted time string
 */
export function formatTime(decimalTime) {
    const hrs = Math.floor(decimalTime);
    const mins = Math.round((decimalTime - hrs) * 60);
    const ampm = hrs >= 12 ? "PM" : "AM";
    const fHrs = hrs % 12 || 12;
    const fMins = mins < 10 ? "0" + mins : mins;
    return `${fHrs}:${fMins} ${ampm}`;
}

export const DAYS_MAP = { "Sunday": 0, "Monday": 1, "Tuesday": 2, "Wednesday": 3, "Thursday": 4, "Friday": 5, "Saturday": 6 };
