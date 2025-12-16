
import fetch, { Headers, Request, Response } from 'node-fetch';
global.fetch = fetch;
global.Headers = Headers;
global.Request = Request;
global.Response = Response;

async function run() {
    console.log(" importing chroma...");
    const { CloudClient } = await import("chromadb");
    console.log(" initializing client...");
    const client = new CloudClient({
        apiKey: 'ck-DG7HveJwcYR22dBvLmJVSM5xES4obFkPm4eZeWfbJWe7',
        tenant: '93fe2e23-2fab-4375-8ac9-b76143332c06',
        database: 'trav_med'
    });

    console.log(" listing collections...");
    try {
        const collections = await client.listCollections();
        console.log("Collections:", collections);
    } catch (e) {
        console.error("Error:", e);
    }
}

run();
