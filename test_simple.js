import axios from 'axios';

async function test() {
    try {
        console.log('Testing query: "Find me a cardiologist"');
        const res = await axios.post('http://localhost:3000/query', {
            question: 'Find me a cardiologist'
        });
        console.log('Response:', JSON.stringify(res.data, null, 2));
    } catch (err) {
        console.error('Error:', err.message);
        if (err.response) {
            console.error('Data:', err.response.data);
        }
    }
}

test();
