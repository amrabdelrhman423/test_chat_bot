
import fetch from 'node-fetch';
import XHR2 from 'xhr2';
globalThis.fetch = fetch;

import { FormData } from 'formdata-node';

global.XMLHttpRequest = XHR2;
globalThis.FormData = FormData;
// globalThis.fetch = fetch;


import Parse from "parse/node.js";

const PARSE_URL = "https://nodewemo.voycephone.com/parse";
const PARSE_APP_ID = "com.voyce";
const PARSE_USERNAME = "admin1";
const PARSE_PASSWORD = "12345678";

Parse.initialize(PARSE_APP_ID);
Parse.serverURL = PARSE_URL;

async function run() {
    try {
        await Parse.User.logIn(PARSE_USERNAME, PARSE_PASSWORD);

        const Doctors = Parse.Object.extend("Doctors");
        const query = new Parse.Query(Doctors);

        // query.matches("gender", new RegExp("^Female", "i"));
        query.limit(100);

        const results = await query.find();
        console.log(`Found ${results.length} female doctors.`);

        const names = results.map(d => d.get("fullname"));
        const seen = new Set();
        const duplicates = [];

        names.forEach(n => {
            if (seen.has(n)) duplicates.push(n);
            seen.add(n);
        });

        if (duplicates.length > 0) {
            console.log("Duplicates found:", duplicates);
        } else {
            console.log("No duplicates found in raw Parse query.");
        }

    } catch (e) {
        console.error(e);
    }
}

run();
