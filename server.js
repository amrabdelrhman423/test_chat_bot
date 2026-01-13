import XHR2 from 'xhr2';
import 'dotenv/config';

global.XMLHttpRequest = XHR2;

// Configure XHR2 to use UTF-8 charset
XHR2.prototype._setRequestHeader = XHR2.prototype.setRequestHeader;
XHR2.prototype.setRequestHeader = function (header, value) {
    if (header.toLowerCase() === 'content-type' && value.indexOf('charset') === -1) {
        value += '; charset=utf-8';
    }
    return this._setRequestHeader(header, value);
};

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

// Config
import { initParse, parseLogin } from './config/parseConfig.js';

// Utils
import { fixEncoding } from './utils/encoding.js';

// Services
import { ragAnswer } from './services/ragService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WS_PORT = process.env.WS_PORT || 3000;

// Initialize Parse
initParse();

async function startServer() {
    console.log("=== Medical RAG Server (Modularized) ===");

    // Login to Parse for session token
    const user = await parseLogin();

    const app = express();
    const server = createServer(app);

    // Serve static files (UI)
    app.use(express.static(__dirname));

    const wss = new WebSocketServer({ server });

    server.listen(WS_PORT, '0.0.0.0', () => {
        console.log(`\n✔ Server and WebSocket running on http://0.0.0.0:${WS_PORT}`);
        console.log(`✔ Safe to access via http://localhost:${WS_PORT}`);
    });

    wss.on('connection', (ws) => {
        console.log('Client connected');
        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data);
                if (message.type === 'question') {
                    console.log(`📩 Question received: "${message.message.substring(0, 50)}..."`);
                    const answer = await ragAnswer(fixEncoding(message.message), user);
                    ws.send(JSON.stringify({ type: 'answer', message: answer }));
                }
            } catch (error) {
                console.error("Processing Error:", error.message);
                ws.send(JSON.stringify({ type: 'error', message: error.message }));
            }
        });

        ws.on('close', () => console.log('Client disconnected'));
    });
}

startServer();
