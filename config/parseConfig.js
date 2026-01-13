
import Parse from "parse/node.js";
import 'dotenv/config';

const PARSE_URL = process.env.PARSE_URL || "https://nodewemo.voycephone.com/parse";
const PARSE_APP_ID = process.env.PARSE_APP_ID || "com.voyce";
const PARSE_USERNAME = process.env.PARSE_USERNAME || "admin1";
const PARSE_PASSWORD = process.env.PARSE_PASSWORD || "12345678";

// Constants
export const PARSE_CLASS_HOSPITALS = "Hospitals";
export const PARSE_CLASS_DOCTORS = "Doctors";
export const PARSE_CLASS_SPECIALTIES = "Specialties";
export const PARSE_CLASS_CITIES = "Cities";
export const PARSE_CLASS_AREAS = "Areas";
export const PARSE_CLASS_DOCTOR_APPOINTMENTS = "DoctorAppointments";

// Initialize Parse
export function initParse() {
    Parse.initialize(PARSE_APP_ID);
    Parse.serverURL = PARSE_URL;
    Parse.CoreManager.set('REQUEST_HEADERS', {
        "Content-Type": "application/json; charset=utf-8"
    });
    console.log("✔ Parse Initialized");
}

// Parse Login Helper
export async function parseLogin() {
    try {
        const user = await Parse.User.logIn(PARSE_USERNAME, PARSE_PASSWORD);
        console.log("✔ Logged in as:", user.get("username"));
        return user;
    } catch (error) {
        console.error("❌ Parse Login Error:", error.message);
        // Do not exit process, just return undefined/null so app can decide
        return null;
    }
}

export default Parse;
