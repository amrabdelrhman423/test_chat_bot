import { Client } from "@opensearch-project/opensearch";

const PASSWORDS = [
    "admin",
    "admin1",
    "12345678",
    "password",
    "root",
    "SecretPassword123!",
    "StrongPassword123!"
];

async function check(password) {
    const client = new Client({
        node: "https://localhost:9200",
        auth: { username: "admin", password },
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.cluster.health();
        return true;
    } catch (e) {
        return false;
    }
}

async function main() {
    console.log("🔍 Checking common passwords...");
    for (const pw of PASSWORDS) {
        process.stdout.write(`Testing '${pw}'... `);
        const success = await check(pw);
        if (success) {
            console.log("✅ SUCCESS!");
            console.log(`\nFOUND PASSWORD: ${pw}`);
            console.log("Please update your .env file with this password.");
            process.exit(0);
        } else {
            console.log("❌ Failed");
        }
    }
    console.log("\n❌ Could not find password. Please verify your OpenSearch configuration.");
}

main();
