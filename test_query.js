import WebSocket from 'ws';

function test() {
    const ws = new WebSocket('ws://localhost:3000');

    ws.on('open', () => {
        console.log('Connected to WebSocket');
        const query = {
            type: 'question',
            message: 'عايز دكتور خالد مصطفي'
        };
        ws.send(JSON.stringify(query));
    });

    ws.on('message', (data) => {
        const response = JSON.parse(data);
        console.log('Response:', JSON.stringify(response, null, 2));
        ws.close();
    });

    ws.on('error', (err) => {
        console.error('WebSocket Error:', err.message);
    });
}

test();
