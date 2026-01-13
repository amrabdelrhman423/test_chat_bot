
import {
    PARSE_CLASS_HOSPITALS,
    PARSE_CLASS_DOCTORS,
    PARSE_CLASS_SPECIALTIES,
    PARSE_CLASS_CITIES,
    PARSE_CLASS_AREAS,
    PARSE_CLASS_DOCTOR_APPOINTMENTS
} from '../config/parseConfig.js';
import Parse from '../config/parseConfig.js';
import { HOSPITALS_COLLECTION } from '../config/vectorDbConfig.js';
import { AppointmentModel } from '../models/index.js';
import { cleanSearchTerm, escapeRegex, fixEncoding } from '../utils/encoding.js';
import { formatTime, DAYS_MAP } from '../utils/timeUtils.js';
import { performVectorSearch } from './vectorSearchService.js';

export async function findHospitalsByAnyTerm(searchTerm, user) {
    if (!searchTerm) return [];

    const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);
    const cleaned = cleanSearchTerm(searchTerm);
    const pattern = new RegExp(escapeRegex(cleaned), 'i');

    console.log(`🔍 findHospitalsByAnyTerm: Searching for "${cleaned}"`);

    // 1. Hybrid Hospital Match (Semantic)
    const hospitalHybridResults = await performVectorSearch(searchTerm, HOSPITALS_COLLECTION, 1, 0.4);
    const hybridIds = hospitalHybridResults.map(r => r.parse_id || r.id).filter(Boolean);

    // 2. Keyword Match (Regex on Parse)
    const qEn = new Parse.Query(Hospitals).matches("nameEn", pattern);
    const qAr = new Parse.Query(Hospitals).matches("nameAr", pattern);
    const qLoc = new Parse.Query(Hospitals).matches("location", pattern);

    const parseQuery = Parse.Query.or(qEn, qAr, qLoc);
    parseQuery.notEqualTo("isDeleted", true);

    // Let's run Parse Query
    const parseResults = await parseQuery.find({ sessionToken: user?.getSessionToken() });

    // 3. Fetch Hybrid Objects by ID
    let hybridParseObjects = [];
    if (hybridIds.length > 0) {
        const idQuery = new Parse.Query(Hospitals);
        idQuery.containedIn("uid", hybridIds);
        hybridParseObjects = await idQuery.find({ sessionToken: user?.getSessionToken() });
    }

    // 4. Merge
    const allHospitals = [...parseResults, ...hybridParseObjects];
    const unique = new Map();
    allHospitals.forEach(h => unique.set(h.id, h));

    return Array.from(unique.values());
}

export async function executeHospitalParseQuery(params, user) {
    console.log("🔍 Executing Hospital Parse Query:", params);
    const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);
    let query = new Parse.Query(Hospitals);
    query.notEqualTo("isDeleted", true);

    if (params.hospitalName) {
        const hospitals = await findHospitalsByAnyTerm(params.hospitalName, user);
        return hospitals.map(h => `🏥 Hospital: ${h.get("nameEn")} / ${fixEncoding(h.get("nameAr"))}\n📍 Location: ${fixEncoding(h.get("location") || "N/A")}`);
    } else if (params.location || params.nameAr) {
        const term = params.location || params.nameAr;
        const hospitals = await findHospitalsByAnyTerm(term, user);
        return hospitals.map(h => `🏥 Hospital: ${h.get("nameEn")} / ${fixEncoding(h.get("nameAr"))}\n📍 Location: ${fixEncoding(h.get("location") || "N/A")}`);
    }

    query.limit(10);
    const results = await query.find({ sessionToken: user?.getSessionToken() });
    return results.map(h => `🏥 Hospital: ${h.get("nameEn")} / ${fixEncoding(h.get("nameAr"))}`);
}

export async function executeSpecialtiesParseQuery(params, user) {
    console.log("🔍 Executing Specialties Parse Query:", params);
    const Specialties = Parse.Object.extend(PARSE_CLASS_SPECIALTIES);
    const query = new Parse.Query(Specialties);
    query.notEqualTo("isDeleted", true);

    if (params.specialtyName) {
        const cleaned = cleanSearchTerm(params.specialtyName);
        const pattern = new RegExp(escapeRegex(cleaned), 'i');
        const qEn = new Parse.Query(Specialties).matches("nameEn", pattern);
        const qAr = new Parse.Query(Specialties).matches("nameAr", pattern);
        const mainQuery = Parse.Query.or(qEn, qAr);
        const results = await mainQuery.find({ sessionToken: user?.getSessionToken() });
        return results.map(s => `🩺 Specialty: ${s.get("nameEn")} / ${fixEncoding(s.get("nameAr"))}`);
    }

    query.limit(20);
    const results = await query.find({ sessionToken: user?.getSessionToken() });
    return results.map(s => `🩺 Specialty: ${s.get("nameEn")} / ${fixEncoding(s.get("nameAr"))}`);
}

export async function executeCityParseQuery(params, user) {
    const Cities = Parse.Object.extend(PARSE_CLASS_CITIES);
    const query = new Parse.Query(Cities);
    const results = await query.find({ sessionToken: user?.getSessionToken() });
    return results.map(c => `City: ${c.get("nameEn")}`);
}

export async function executeAreaParseQuery(params, user) {
    const Areas = Parse.Object.extend(PARSE_CLASS_AREAS);
    const query = new Parse.Query(Areas);
    const results = await query.find({ sessionToken: user?.getSessionToken() });
    return results.map(c => `Area: ${c.get("nameEn")}`);
}

export async function safeFetch(ptr, user) {
    if (!ptr) return null;
    try {
        return await ptr.fetch({ sessionToken: user?.getSessionToken() });
    } catch (e) {
        return null;
    }
}

export async function executeDoctorAppointmentsQuery(params, user) {
    console.log("🔍 Executing Doctor Appointments Query:", params);
    const DoctorAppointments = Parse.Object.extend(PARSE_CLASS_DOCTOR_APPOINTMENTS);
    const query = new Parse.Query(DoctorAppointments);
    query.notEqualTo("isDeleted", true);

    if (params.isOnline !== undefined && params.isOnline !== null) {
        query.equalTo("isOnline", params.isOnline === true || params.isOnline === "true");
    }

    if (params.doctorName || params.fullname) {
        const dName = params.doctorName || params.fullname;
        const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
        const docQuery = new Parse.Query(Doctors);
        const safeName = escapeRegex(cleanSearchTerm(dName));
        docQuery.matches("fullname", new RegExp(safeName, 'i'));
        const doctors = await docQuery.find({ sessionToken: user?.getSessionToken() });

        if (doctors.length > 0) {
            const uids = doctors.map(d => d.get("uid"));
            query.containedIn("doctorUid", uids);
            console.log(`Appointments for doctors: ${doctors.map(d => d.get("fullname")).join(", ")}`);
        } else {
            return ["Could not find doctor named " + dName];
        }
    }

    query.notEqualTo("isBooked", true);
    query.ascending("appointmentDate");

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    query.greaterThanOrEqualTo("appointmentDate", today);

    const results = await query.find({ sessionToken: user?.getSessionToken() });

    if (results.length === 0) return ["No available appointments found."];

    return results.map(r => {
        const d = r.get("appointmentDate");
        const dateStr = d ? d.toDateString() : "Unknown Date";
        const start = r.get("startTime") || "?";
        const end = r.get("endTime") || "?";
        const price = r.get("price") || "Free";
        const currency = (r.get("currency") || "EGP").toUpperCase();
        const type = r.get("isOnline") === true ? "ONLINE" : "OFFLINE";

        return `📅 ${dateStr} | ⏰ ${start} - ${end} | 💰 ${price} ${currency} | [${type}]`;
    });
}

export async function executeDoctorParseQuery(params, user) {
    console.log("🔍 Executing Doctor Parse Query:", params);
    const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
    let query = new Parse.Query(Doctors);
    query.notEqualTo("isDeleted", true);

    // Detect field and value from params
    let searchField = params.field;
    let searchValue = params.value;

    // Compatibility with direct keys (e.g., { fullnameAr: '...' })
    if (!searchField || !searchValue) {
        const knownFields = ["fullname", "fullnameAr", "title", "positionEn", "positionAr", "qualificationsEn", "qualificationsAr"];
        for (const key of knownFields) {
            if (params[key]) {
                searchField = key;
                searchValue = params[key];
                break;
            }
        }
    }

    if (searchField && searchValue) {
        const cleanedValue = cleanSearchTerm(searchValue);
        console.log(`🧹 Cleaned search term: "${searchValue}" -> "${cleanedValue}"`);
        const safe = escapeRegex(cleanedValue);
        const searchPattern = new RegExp(safe, 'i');

        if (searchField === "fullname" || searchField === "fullnameAr") {
            const qEn = new Parse.Query(Doctors);
            qEn.matches("fullname", searchPattern);
            const qAr = new Parse.Query(Doctors);
            qAr.matches("fullnameAr", searchPattern);
            query = Parse.Query.or(qEn, qAr);
        } else {
            query.matches(searchField, searchPattern);
        }
    }

    // Add Gender Filter
    if (params.gender) {
        console.log(`⚧ Applying gender filter: ${params.gender}`);
        const safeGender = escapeRegex(params.gender);
        const genderPattern = new RegExp(`^${safeGender}`, 'i');
        query.matches("gender", genderPattern);
    }

    query.limit(1000);

    const results = await query.find({ sessionToken: user?.getSessionToken() });

    if (!results.length) return [];

    // Deduplicate results by Name (English + Arabic) to avoid same doctor appearing multiple times
    const uniqueDocs = new Map();
    results.forEach(doc => {
        const key = (doc.get("fullname") || "").trim() + "|" + (doc.get("fullnameAr") || "").trim();
        if (!uniqueDocs.has(key)) {
            uniqueDocs.set(key, doc);
        }
    });

    const dedupedResults = Array.from(uniqueDocs.values());
    console.log(`Summary: Found ${results.length} raw results. After deduplication: ${dedupedResults.length} unique doctors.`);

    const includeArabic = params.includeArabic || false;

    return await Promise.all(dedupedResults.map(async obj => {
        const doctorUid = obj.get("uid");
        let pricesDetail = "";
        let appointmentsDetail = "";

        if (doctorUid) {
            // We need to fetch appointments for ALL hospitals this doctor is associated with.
            // 1. Get List of unique Hospital UIDs for this doctor via HospitalDoctorSpecialty
            const hdsQuery = new Parse.Query("HospitalDoctorSpecialty");
            hdsQuery.equalTo("doctorUid", doctorUid);
            hdsQuery.notEqualTo("isDeleted", true);
            const hdsResults = await hdsQuery.find({ sessionToken: user?.getSessionToken() }).catch(() => []);

            const hospitalUids = [...new Set(hdsResults.map(r => r.get("hospitalUid")).filter(Boolean))];

            for (const hUid of hospitalUids) {
                // Determine which statuses to fetch
                const statusesToFetch = [];
                if (params.isOnline === true || params.isOnline === "true") {
                    statusesToFetch.push(true);
                } else if (params.isOnline === false || params.isOnline === "false") {
                    statusesToFetch.push(false);
                } else {
                    statusesToFetch.push(false); // Fetch Offline
                    statusesToFetch.push(true);  // Fetch Online
                }

                for (const onlStatus of statusesToFetch) {
                    try {
                        const logicResult = await Parse.Cloud.run("getDoctorAppointments", {
                            doctorUid: doctorUid,
                            hospitalUid: hUid,
                            isOnline: onlStatus
                        }, { sessionToken: user?.getSessionToken() });

                        const appModel = AppointmentModel.fromLogicResult(logicResult);
                        const availableApps = appModel.doctorAppointments || [];
                        const bookedSlots = appModel.bookedSlots || [];

                        if (availableApps.length > 0) {
                            const generatedSlots = [];

                            availableApps.forEach(app => {
                                const timeSlots = app.timeSlots || [];
                                if (timeSlots.length < 2) return;
                                const startHour = timeSlots[0];
                                const endHour = timeSlots[1];
                                const durationMin = app.sessionDuration || 30;
                                const durationHrs = durationMin / 60;
                                const targetDayName = app.day;
                                const today = new Date();
                                const currentDayIndex = today.getDay();
                                const targetDayIndex = DAYS_MAP[targetDayName] !== undefined ? DAYS_MAP[targetDayName] : -1;

                                if (targetDayIndex === -1) return;

                                let daysToAdd = targetDayIndex - currentDayIndex;
                                if (daysToAdd < 0) daysToAdd += 7;

                                for (let week = 0; week < 6; week++) {
                                    const targetDate = new Date();
                                    targetDate.setDate(today.getDate() + daysToAdd + (week * 7));
                                    targetDate.setHours(0, 0, 0, 0);

                                    const targetDateStr = targetDate.toISOString().split('T')[0];

                                    if (app.startDate) {
                                        const appStartDateStr = app.startDate.toISOString().split('T')[0];
                                        if (targetDateStr < appStartDateStr) continue;
                                    }

                                    // Handle expiration via "every" field
                                    if (app.startDate && app.every) {
                                        const expirationDate = new Date(app.startDate);
                                        if (app.every === "month") {
                                            expirationDate.setMonth(expirationDate.getMonth() + 1);
                                        } else if (app.every === "year") {
                                            expirationDate.setFullYear(expirationDate.getFullYear() + 1);
                                        }

                                        const expirationDateStr = expirationDate.toISOString().split('T')[0];
                                        if (targetDateStr > expirationDateStr) continue;
                                    }

                                    let currentSlot = startHour;
                                    const validSlots = [];

                                    while (currentSlot < endHour) {
                                        const h = Math.floor(currentSlot);
                                        const m = Math.round((currentSlot - h) * 60);
                                        const slot24 = `${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}`;

                                        const isBooked = bookedSlots.some(b => {
                                            if (!b.bookingDate) return false;
                                            return (b.bookingDate.toISOString().split('T')[0] === targetDateStr &&
                                                b.slot === slot24);
                                        });

                                        if (!isBooked) validSlots.push(formatTime(currentSlot));
                                        currentSlot += durationHrs;
                                    }

                                    if (validSlots.length > 0) {
                                        generatedSlots.push(`📅 ${targetDate.toDateString()} (${targetDayName}) @ HospitalID:${hUid} [${onlStatus ? "ONLINE" : "OFFLINE"}] : ${validSlots.join(", ")}`);
                                    }
                                }
                            });

                            if (generatedSlots.length > 0) {
                                appointmentsDetail += "\n" + generatedSlots.join("\n");
                            }
                        }
                    } catch (e) {
                        console.error(`Error fetching appointments for Doctor ${doctorUid} at Hospital ${hUid}:`, e.message);
                    }
                }
            }

            if (appointmentsDetail) {
                appointmentsDetail = "\nAvailable Appointments:\n" + appointmentsDetail;
            }
        }

        let output = `
Name: ${obj.get("fullname") || "Unknown"}
Name (Ar): ${fixEncoding(obj.get("fullnameAr") || "Unknown")}
Title: ${obj.get("title") || "Unknown"}
Position: ${obj.get("positionEn") || "Unknown"}
Position (Ar): ${fixEncoding(obj.get("positionAr") || "Unknown")}
Qualifications: ${obj.get("qualificationsEn") || "Unknown"}
Qualifications (Ar): ${fixEncoding(obj.get("qualificationsAr") || "Unknown")}
Years of Experience: ${obj.get("yrsExp") || "Unknown"}
Gender: ${obj.get("gender") || "Unknown"}
Rating: ${obj.get("averageRating") || "Unknown"}${pricesDetail}
${appointmentsDetail}`;

        if (includeArabic) {
            output += `
Name (Ar): ${fixEncoding(obj.get("fullnameAr") || "Unknown")}
Position (Ar): ${fixEncoding(obj.get("positionAr") || "Unknown")}
Qualifications (Ar): ${fixEncoding(obj.get("qualificationsAr") || "Unknown")}`;
        }

        return output.trim();
    }));
}

export async function executeRelationshipQuery(params, user) {
    console.log("🔍 Executing Relationship Query:", params);

    // 🔧 Custom Request: Support 'fullname' as alias for 'doctorName'
    if (params.fullname && !params.doctorName) {
        console.log(`🔄 Aliasing params.fullname "${params.fullname}" to params.doctorName`);
        params.doctorName = params.fullname;
    }

    if (params.queryType === "allDoctors") {
        if (params.specialtyName) {
            console.log("⚡ Detected allDoctors with specialtyName - converting to specialistsAtHospital");
            // Assuming specialistsAtHospital logic is handled by general flow below if queryType changed
            params.queryType = "specialistsAtHospital";
        } else {
            return executeDoctorParseQuery(params, user);
        }
    }
    if (params.queryType === "allHospitals") {
        return executeHospitalParseQuery(params, user);
    }
    if (params.queryType === "allSpecialties") {
        return executeSpecialtiesParseQuery(params, user);
    }
    if (params.queryType === "allCities") {
        return executeCityParseQuery(params, user);
    }
    if (params.queryType === "allAreas") {
        return executeAreaParseQuery(params, user);
    }
    if (params.queryType === "doctorAppointments") {
        return executeDoctorAppointmentsQuery(params, user);
    }

    const HospitalDoctorSpecialty = Parse.Object.extend("HospitalDoctorSpecialty");
    const query = new Parse.Query(HospitalDoctorSpecialty);
    query.notEqualTo("isDeleted", true);

    query.include("doctorDetails");
    query.include("hospitalDetails");
    query.include("specialtyDetails");

    const queryType = params.queryType;
    const validTypes = ["doctorsAtHospital", "hospitalsForDoctor", "specialistsAtHospital", "specialtiesAtHospital", "specialtiesForDoctor", "specialtiesComparison", "allDoctors", "allHospitals", "allSpecialties", "doctorAppointments", "checkDoctorAtHospital", "checkDoctorSpecialty"];

    if (!validTypes.includes(queryType)) {
        console.warn(`⚠ Invalid queryType: "${queryType}". Returning empty results.`);
        return [];
    }

    // ---------------------------------------------------------
    // 1. VERIFICATION & COMPARISON (Special Handling - Return Strings)
    // ---------------------------------------------------------

    if (queryType === "checkDoctorAtHospital" && params.doctorName && params.hospitalName) {
        // 1. Find Doctor
        const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
        const docQuery = new Parse.Query(Doctors);
        docQuery.matches("fullname", new RegExp(escapeRegex(cleanSearchTerm(params.doctorName)), 'i'));
        docQuery.notEqualTo("isDeleted", true);
        const doctors = await docQuery.find({ sessionToken: user?.getSessionToken() });
        if (doctors.length === 0) return [`Verification Result: Doctor "${params.doctorName}" NOT FOUND in database.`];

        // 2. Find Hospital
        const Hospitals = Parse.Object.extend(PARSE_CLASS_HOSPITALS);
        const hospQuery = new Parse.Query(Hospitals);
        const hospPattern = new RegExp(escapeRegex(cleanSearchTerm(params.hospitalName)), 'i');
        const hospQueryEn = new Parse.Query(Hospitals).matches("nameEn", hospPattern);
        const hospQueryAr = new Parse.Query(Hospitals).matches("nameAr", hospPattern);
        const hospitalsQuery = Parse.Query.or(hospQueryEn, hospQueryAr);
        hospitalsQuery.notEqualTo("isDeleted", true);
        const hospitals = await hospitalsQuery.find({ sessionToken: user?.getSessionToken() });
        if (hospitals.length === 0) return [`Verification Result: Hospital "${params.hospitalName}" NOT FOUND in database.`];

        // 3. Check Relationship
        const relQuery = new Parse.Query(HospitalDoctorSpecialty);
        relQuery.containedIn("doctorUid", doctors.map(d => d.get("uid")));
        relQuery.containedIn("hospitalUid", hospitals.map(h => h.get("uid")));
        relQuery.notEqualTo("isDeleted", true);
        relQuery.include(["doctorDetails", "hospitalDetails"]);

        const rels = await relQuery.find({ sessionToken: user?.getSessionToken() });

        if (rels.length > 0) {
            const dName = rels[0].get("doctorDetails").get("fullname");
            const hName = rels[0].get("hospitalDetails").get("nameEn");
            return [`VERIFIED: YES. Dr. ${dName} WORKS at ${hName}.`];
        } else {
            return [`VERIFIED: NO. No record found linking Dr. ${params.doctorName} to ${params.hospitalName}.`];
        }
    }

    if (queryType === "checkDoctorSpecialty" && params.doctorName && params.specialtyName) {
        // 1. Find Doctor
        const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
        const docQuery = new Parse.Query(Doctors);
        docQuery.matches("fullname", new RegExp(escapeRegex(cleanSearchTerm(params.doctorName)), 'i'));
        const doctors = await docQuery.find({ sessionToken: user?.getSessionToken() });
        if (doctors.length === 0) return [`Verification Result: Doctor "${params.doctorName}" NOT FOUND in database.`];

        // 2. Find Specialty
        const Specialties = Parse.Object.extend(PARSE_CLASS_SPECIALTIES);
        const specQuery = new Parse.Query(Specialties);
        const specPattern = new RegExp(escapeRegex(cleanSearchTerm(params.specialtyName)), 'i');
        const specQueryEn = new Parse.Query(Specialties).matches("nameEn", specPattern);
        const specQueryAr = new Parse.Query(Specialties).matches("nameAr", specPattern);
        const specialtiesQuery = Parse.Query.or(specQueryEn, specQueryAr);
        specialtiesQuery.notEqualTo("isDeleted", true);
        const specialties = await specialtiesQuery.find({ sessionToken: user?.getSessionToken() });

        if (specialties.length === 0) return [`Verification Result: Specialty "${params.specialtyName}" NOT FOUND in database.`];

        // 3. Check Relationship
        const relQuery = new Parse.Query(HospitalDoctorSpecialty);
        relQuery.containedIn("doctorUid", doctors.map(d => d.get("uid")));
        relQuery.containedIn("specialtyUid", specialties.map(s => s.id));
        relQuery.include(["doctorDetails", "specialtyDetails"]);

        const rels = await relQuery.find({ sessionToken: user?.getSessionToken() });

        if (rels.length > 0) {
            const dName = rels[0].get("doctorDetails").get("fullname");
            const sName = rels[0].get("specialtyDetails").get("nameEn");
            return [`VERIFIED: YES. Dr. ${dName} is a specialist in ${sName}.`];
        } else {
            return [`VERIFIED: NO. No record found linking Dr. ${params.doctorName} to specialty ${params.specialtyName}.`];
        }
    }

    if (queryType === "specialtiesComparison" && params.doctor1Name && params.doctor2Name) {
        const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
        const d1Query = new Parse.Query(Doctors).matches("fullname", new RegExp(escapeRegex(cleanSearchTerm(params.doctor1Name)), 'i'));
        const d2Query = new Parse.Query(Doctors).matches("fullname", new RegExp(escapeRegex(cleanSearchTerm(params.doctor2Name)), 'i'));

        const [docs1, docs2] = await Promise.all([
            d1Query.find({ sessionToken: user?.getSessionToken() }),
            d2Query.find({ sessionToken: user?.getSessionToken() })
        ]);

        if (docs1.length === 0 && docs2.length === 0) return [];

        const doctorUids = [];
        if (docs1.length > 0) doctorUids.push(...docs1.map(d => d.get("uid")));
        if (docs2.length > 0) doctorUids.push(...docs2.map(d => d.get("uid")));
        query.containedIn("doctorUid", doctorUids);
    }

    // ---------------------------------------------------------
    // 2. SEARCH & LIST (Composable Logic / Unified Filter)
    // ---------------------------------------------------------

    if (queryType === "allDoctors") {
        console.log("🔍 Fetching ALL doctors...");
        query.limit(100);
    } else {
        query.limit(25);
    }

    let resultDoctors = await query.find({ sessionToken: user?.getSessionToken() });

    // A. Filter by Hospital (if exists)
    if (params.hospitalName || params.nameAr || params.nameEn || params.location || params.address) {
        const val = params.hospitalName || params.nameAr || params.nameEn || params.location || params.address;
        const hospitals = await findHospitalsByAnyTerm(val, user);
        if (hospitals.length > 0) {
            query.containedIn("hospitalUid", hospitals.map(h => h.get("uid")).filter(id => !!id));
        } else {
            console.log(`⚠ Hospital/Location "${val}" not found. Broader lookup may occur.`);
            query.limit(100);
        }
    }

    let resultHospitals = await query.find({ sessionToken: user?.getSessionToken() });

    // B. Filter by Specialty
    if (params.specialtyName) {
        const cleaned = cleanSearchTerm(params.specialtyName);
        console.log(`🩺 Filtering by Specialty: "${cleaned}"`);
        const Specialties = Parse.Object.extend(PARSE_CLASS_SPECIALTIES);
        const pattern = new RegExp(escapeRegex(cleaned), 'i');
        const qEn = new Parse.Query(Specialties).matches("nameEn", pattern);
        const qAr = new Parse.Query(Specialties).matches("nameAr", pattern);
        const specQuery = Parse.Query.or(qEn, qAr);
        specQuery.notEqualTo("isDeleted", true);
        const specialties = await specQuery.find({ sessionToken: user?.getSessionToken() });

        if (specialties.length > 0) {
            query.containedIn("specialtyDetails", specialties);
        } else {
            console.log(`⚠ Specialty "${cleaned}" not found. Returning empty.`);
            query.limit(100);
        }
    }
    let resultSpecialties = await query.find({ sessionToken: user?.getSessionToken() });

    // C. Filter by Doctor / Gender
    let candidateDoctors = null;
    const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);

    if (params.doctorName) {
        const cleaned = cleanSearchTerm(params.doctorName);
        console.log(`👨‍⚕️ Filtering by Doctor Name: "${cleaned}"`);
        const pattern = new RegExp(escapeRegex(cleaned), 'i');
        const qEn = new Parse.Query(Doctors).matches("fullname", pattern);
        const qAr = new Parse.Query(Doctors).matches("fullnameAr", pattern);
        const docQueryName = Parse.Query.or(qEn, qAr);
        docQueryName.notEqualTo("isDeleted", true);
        const docs = await docQueryName.find({ sessionToken: user?.getSessionToken() });
        candidateDoctors = docs;
        if (docs.length === 0) {
            console.log(`⚠ Doctor "${cleaned}" not found. Returning empty.`);
            query.limit(100);
        }
    }

    if (params.gender) {
        console.log(`⚧ Filtering by Gender: "${params.gender}"`);
        const safeGender = escapeRegex(params.gender);
        const pattern = new RegExp(`^${safeGender}`, 'i');
        const genderQuery = new Parse.Query(Doctors).matches("gender", pattern);
        genderQuery.notEqualTo("isDeleted", true);
        const docs = await genderQuery.find({ sessionToken: user?.getSessionToken() });

        if (candidateDoctors === null) {
            candidateDoctors = docs;
        } else {
            const genderIds = docs.map(d => d.id);
            candidateDoctors = candidateDoctors.filter(d => genderIds.includes(d.id));
        }

        if (candidateDoctors.length === 0) {
            console.log(`⚠ No doctors found matching gender "${params.gender}" (and name if provided).`);
            return [];
        }
    }

    if (candidateDoctors !== null) {
        query.containedIn("doctorDetails", candidateDoctors);
    }

    let results = await query.find({ sessionToken: user?.getSessionToken() });

    // Combine (Union)
    let allResults = results;
    if (allResults.length === 0) {
        if (params.specialtyName && resultSpecialties.length > 0) {
            allResults = resultSpecialties;
        }
        if ((params.hospitalName || params.nameAr || params.nameEn || params.location) && resultHospitals.length > 0 && allResults.length === 0) {
            allResults = allResults.concat(resultHospitals);
        }
        if (params.doctorName && resultDoctors.length > 0 && allResults.length === 0) {
            allResults = allResults.concat(resultDoctors);
        }
    }

    // Deduplicate
    const uniqueResults = new Map();
    allResults.forEach(item => {
        if (item && item.id) uniqueResults.set(item.id, item);
    });
    let finalResults = Array.from(uniqueResults.values());

    if (!finalResults.length && (params.hospitalName || params.nameAr || params.nameEn || params.specialtyName)) {
        console.log(`⚠ No direct relationship results found. Attempting broader lookup...`);
        if (params.hospitalName || params.nameAr || params.nameEn) {
            const broadQuery = new Parse.Query(Parse.Object.extend("HospitalDoctorSpecialty"));
            broadQuery.include(["doctorDetails", "hospitalDetails", "specialtyDetails"]);
            if (params.specialtyName) {
                const Specialties = Parse.Object.extend(PARSE_CLASS_SPECIALTIES);
                const pattern = new RegExp(escapeRegex(cleanSearchTerm(params.specialtyName)), 'i');
                const specResults = await Parse.Query.or(
                    new Parse.Query(Specialties).matches("nameEn", pattern),
                    new Parse.Query(Specialties).matches("nameAr", pattern)
                ).find({ sessionToken: user?.getSessionToken() });

                if (specResults.length > 0) {
                    broadQuery.containedIn("specialtyDetails", specResults);
                }
            }
            if (params.doctorName) {
                const Doctors = Parse.Object.extend(PARSE_CLASS_DOCTORS);
                const pattern = new RegExp(escapeRegex(cleanSearchTerm(params.doctorName)), 'i');
                const docResults = await Parse.Query.or(
                    new Parse.Query(Doctors).matches("fullname", pattern),
                    new Parse.Query(Doctors).matches("fullnameAr", pattern)
                ).find({ sessionToken: user?.getSessionToken() });

                if (docResults.length > 0) {
                    broadQuery.containedIn("doctorDetails", docResults);
                }
            }
            try {
                results = await broadQuery.find({ sessionToken: user?.getSessionToken() });
                if (results.length > 0) finalResults = results;
            } catch (e) { }
        }
    }

    if (!finalResults.length) {
        console.log(`⚠ No results found for query: ${queryType}`);
        return [];
    }

    if (queryType === "specialtiesForDoctor") {
        const specialtiesMap = new Map();
        finalResults.forEach(obj => {
            const specialty = obj.get("specialtyDetails");
            if (specialty) {
                const specialtyId = specialty.id;
                if (!specialtiesMap.has(specialtyId)) {
                    specialtiesMap.set(specialtyId, {
                        name: specialty.get("nameEn") || "Unknown",
                        nameAr: specialty.get("nameAr") || "Unknown"
                    });
                }
            }
        });
        return Array.from(specialtiesMap.values()).map(spec => `
Specialty: ${spec.name}
Arabic Name: ${fixEncoding(spec.nameAr)}
        `.trim());
    }

    const formattedResults = await Promise.all(
        finalResults.map(async (obj) => {
            const doctorPtr = obj.get("doctorDetails");
            const hospitalPtr = obj.get("hospitalDetails");
            const specialtyPtr = obj.get("specialtyDetails");

            const doctor = await safeFetch(doctorPtr, user);
            const hospital = await safeFetch(hospitalPtr, user);
            const specialty = await safeFetch(specialtyPtr, user);

            if (!doctor && !hospital && !specialty) return null;

            // Fetch Area/City
            let areaNameEn = "", areaNameAr = "", cityNameEn = "", cityNameAr = "";
            if (hospital && hospital.get("areaId")) {
                const areaId = hospital.get("areaId");
                const Area = Parse.Object.extend("Areas");
                const area = await new Parse.Query(Area).get(areaId, { sessionToken: user?.getSessionToken() }).catch(() => null);
                if (area) {
                    areaNameEn = area.get("nameEn") || "";
                    areaNameAr = area.get("nameAr") || "";
                    const cityId = area.get("cityId");
                    if (cityId) {
                        const City = Parse.Object.extend("Cities");
                        const city = await new Parse.Query(City).get(cityId, { sessionToken: user?.getSessionToken() }).catch(() => null);
                        if (city) {
                            cityNameEn = city.get("nameEn") || "";
                            cityNameAr = city.get("nameAr") || "";
                        }
                    }
                }
            }

            let appointmentsDetailOnline = "";
            let appointmentsDetailOffline = "";
            let priceInfo = "";

            if (hospital && doctor) {
                // Online Appointments
                try {
                    const logicResult = await Parse.Cloud.run("getDoctorAppointments", {
                        doctorUid: doctor.get("uid"),
                        hospitalUid: hospital.get("uid"),
                        isOnline: true
                    }, { sessionToken: user?.getSessionToken() });

                    const appModel = AppointmentModel.fromLogicResult(logicResult);
                    const availableApps = appModel.doctorAppointments || [];
                    const bookedSlots = appModel.bookedSlots || [];

                    if (availableApps.length > 0) {
                        const generatedSlots = [];
                        availableApps.forEach(app => {
                            const timeSlots = app.timeSlots || [];
                            if (timeSlots.length < 2) return;
                            const startHour = timeSlots[0];
                            const endHour = timeSlots[1];
                            const durationMin = app.sessionDuration || 30;
                            const durationHrs = durationMin / 60;
                            const targetDayName = app.day;
                            const today = new Date();
                            const currentDayIndex = today.getDay();
                            const targetDayIndex = DAYS_MAP[targetDayName] !== undefined ? DAYS_MAP[targetDayName] : -1;

                            if (targetDayIndex === -1) return;

                            let daysToAdd = targetDayIndex - currentDayIndex;
                            if (daysToAdd < 0) daysToAdd += 7;

                            for (let week = 0; week < 6; week++) {
                                const targetDate = new Date();
                                targetDate.setDate(today.getDate() + daysToAdd + (week * 7));
                                targetDate.setHours(0, 0, 0, 0);
                                const targetDateStr = targetDate.toISOString().split('T')[0];
                                if (app.startDate && targetDateStr < app.startDate.toISOString().split('T')[0]) continue;

                                // Every check ...

                                let currentSlot = startHour;
                                const validSlots = [];
                                while (currentSlot < endHour) {
                                    const h = Math.floor(currentSlot);
                                    const m = Math.round((currentSlot - h) * 60);
                                    const slot24 = `${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}`;

                                    const isBooked = bookedSlots.some(b => b.bookingDate && b.bookingDate.toISOString().split('T')[0] === targetDateStr && b.slot === slot24);
                                    if (!isBooked) validSlots.push(formatTime(currentSlot));
                                    currentSlot += durationHrs;
                                }
                                if (validSlots.length > 0) {
                                    generatedSlots.push(`📅 (${targetDayName}) [Online]: ${validSlots.join(", ")}`);
                                }
                            }
                        });
                        if (generatedSlots.length > 0) appointmentsDetailOnline = "\nAvailable Online:\n" + generatedSlots.join("\n");
                        else appointmentsDetailOnline = "Not available";
                    }
                } catch (e) {
                }

                // Offline Appointments (Simplified but functional)
                try {
                    const logicResult = await Parse.Cloud.run("getDoctorAppointments", {
                        doctorUid: doctor.get("uid"),
                        hospitalUid: hospital.get("uid"),
                        isOnline: false
                    }, { sessionToken: user?.getSessionToken() });

                    const appModel = AppointmentModel.fromLogicResult(logicResult);
                    const availableApps = appModel.doctorAppointments || [];
                    const bookedSlots = appModel.bookedSlots || [];

                    if (availableApps.length > 0) {
                        const generatedSlots = [];
                        availableApps.forEach(app => {
                            const timeSlots = app.timeSlots || [];
                            if (timeSlots.length < 2) return;
                            const startHour = timeSlots[0];
                            const endHour = timeSlots[1];
                            const durationMin = app.sessionDuration || 30;
                            const durationHrs = durationMin / 60;
                            const targetDayName = app.day;
                            const today = new Date();
                            const currentDayIndex = today.getDay();
                            const targetDayIndex = DAYS_MAP[targetDayName] !== undefined ? DAYS_MAP[targetDayName] : -1;

                            if (targetDayIndex === -1) return;

                            let daysToAdd = targetDayIndex - currentDayIndex;
                            if (daysToAdd < 0) daysToAdd += 7;

                            for (let week = 0; week < 6; week++) {
                                const targetDate = new Date();
                                targetDate.setDate(today.getDate() + daysToAdd + (week * 7));
                                targetDate.setHours(0, 0, 0, 0);
                                const targetDateStr = targetDate.toISOString().split('T')[0];
                                if (app.startDate && targetDateStr < app.startDate.toISOString().split('T')[0]) continue;

                                let currentSlot = startHour;
                                const validSlots = [];
                                while (currentSlot < endHour) {
                                    const h = Math.floor(currentSlot);
                                    const m = Math.round((currentSlot - h) * 60);
                                    const slot24 = `${h < 10 ? '0' + h : h}:${m < 10 ? '0' + m : m}`;

                                    const isBooked = bookedSlots.some(b => b.bookingDate && b.bookingDate.toISOString().split('T')[0] === targetDateStr && b.slot === slot24);
                                    if (!isBooked) validSlots.push(formatTime(currentSlot));
                                    currentSlot += durationHrs;
                                }
                                if (validSlots.length > 0) {
                                    generatedSlots.push(`📅 (${targetDayName}) [Offline]: ${validSlots.join(", ")}`);
                                }
                            }
                        });
                        if (generatedSlots.length > 0) appointmentsDetailOffline = "\nAvailable Offline:\n" + generatedSlots.join("\n");
                        else appointmentsDetailOffline = "Not available";
                    }
                } catch (e) {
                }
            }

            const result = `
____________________________________________________________________________________________________
Doctor: ${doctor ? doctor.get("fullname") : "Unknown"}
Doctor (Ar): ${doctor ? fixEncoding(doctor.get("fullnameAr") || "") : ""}
Doctor title: ${doctor ? fixEncoding(doctor.get("title") || "") : ""}
Doctor position : ${doctor ? fixEncoding(doctor.get("positionEn") || "") : ""}
Doctor position (Ar): ${doctor ? fixEncoding(doctor.get("positionAr") || "") : ""}
Hospital name: ${hospital ? hospital.get("nameEn") : "Unknown"}
Hospital name (Ar): ${hospital ? fixEncoding(hospital.get("nameAr") || "") : ""}
for online ${appointmentsDetailOnline == "" ? "not available" : appointmentsDetailOnline}
for offline ${appointmentsDetailOffline == "" ? "not available" : appointmentsDetailOffline}
Hospital City: ${cityNameEn}
Hospital City (Ar): ${fixEncoding(cityNameAr)}
Hospital Area: ${areaNameEn}
Hospital Area (Ar): ${fixEncoding(areaNameAr)}
Specialty name: ${specialty ? specialty.get("nameEn") : "Unknown"}
Specialty name (Ar): ${specialty ? fixEncoding(specialty.get("nameAr") || "") : ""}
Hospital Address: ${hospital ? hospital.get("addressEn") : "Unknown"}
Hospital Address (Ar): ${hospital ? fixEncoding(hospital.get("addressAr") || "") : "Unknown"}
_____________________________________________________________________________________________________
`.trim();
            return result;
        })
    );

    return formattedResults.filter(item => item !== null);
}
