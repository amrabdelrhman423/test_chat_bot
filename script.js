const chatContainer = document.getElementById('chatContainer');
const chatForm = document.getElementById('chatForm');
const userInput = document.getElementById('userInput');
const sendBtn = document.getElementById('sendBtn');
const status = document.getElementById('status');

let ws = null;
let isConnected = false;

// Connect to WebSocket server
function connect() {
    status.textContent = 'Connecting...';
    status.className = 'status connecting';

    // Connect to the same host that served this file
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host || 'localhost:3000';
    ws = new WebSocket(`${protocol}//${host}`);

    ws.onopen = () => {
        console.log('Connected to server');
        isConnected = true;
        status.textContent = 'Connected';
        status.className = 'status connected';
        removeWelcomeMessage();
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === 'answer') {
            removeTypingIndicator();
            addMessage(data.message, 'bot');
        } else if (data.type === 'error') {
            removeTypingIndicator();
            addMessage('Sorry, an error occurred: ' + data.message, 'bot');
        }
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        status.textContent = 'Connection error';
        status.className = 'status error';
    };

    ws.onclose = () => {
        console.log('Disconnected from server');
        isConnected = false;
        status.textContent = 'Disconnected - Reconnecting...';
        status.className = 'status error';

        // Attempt to reconnect after 3 seconds
        setTimeout(connect, 3000);
    };
}

function removeWelcomeMessage() {
    const welcomeMsg = chatContainer.querySelector('.welcome-message');
    if (welcomeMsg) {
        welcomeMsg.remove();
    }
}

function addMessage(text, sender) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${sender}-message`;

    const label = document.createElement('div');
    label.className = 'message-label';
    label.textContent = sender === 'user' ? 'You' : 'Assistant';

    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = text;

    messageDiv.appendChild(label);
    messageDiv.appendChild(content);
    chatContainer.appendChild(messageDiv);

    // Scroll to bottom
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function addTypingIndicator() {
    const typingDiv = document.createElement('div');
    typingDiv.className = 'message bot-message typing';
    typingDiv.innerHTML = `
        <div class="typing-indicator">
            <span></span>
            <span></span>
            <span></span>
        </div>
    `;
    chatContainer.appendChild(typingDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function removeTypingIndicator() {
    const typing = chatContainer.querySelector('.typing');
    if (typing) {
        typing.remove();
    }
}

chatForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const message = userInput.value.trim();
    if (!message || !isConnected) return;

    // Add user message to chat
    removeWelcomeMessage();
    addMessage(message, 'user');

    // Show typing indicator
    addTypingIndicator();

    // Send message to server
    ws.send(JSON.stringify({
        type: 'question',
        message: message
    }));

    // Clear input
    userInput.value = '';
    userInput.focus();
});

// Auto-focus input
userInput.focus();

// Connect on load
connect();
