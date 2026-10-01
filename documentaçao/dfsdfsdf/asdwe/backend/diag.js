const axios = require('axios');

const INSTANCE = '3E5F252F583800117B3E5ED75F1870FF';
const TOKEN = 'B2DBDB410613AA53131EC271';
const CLIENT = 'F0d852a09139d4b6b94b23c77c8a67debS';

async function diagnose() {
    console.log('--- DIAGNÓSTICO MINDFLOW ---');
    try {
        const statusRes = await axios.get(`https://api.z-api.io/instances/${INSTANCE}/token/${TOKEN}/status`, {
            headers: { 'Client-Token': CLIENT }
        });
        console.log('1. STATUS DA INSTÂNCIA:', statusRes.data);

        const qrRes = await axios.get(`https://api.z-api.io/instances/${INSTANCE}/token/${TOKEN}/qr-code`, {
            headers: { 'Client-Token': CLIENT }
        });
        console.log('2. DADOS DO QR CODE (JSON):', JSON.stringify(qrRes.data).substring(0, 100) + '...');
        
        if (qrRes.data.value) {
            console.log('   - Base64 detectado! Tamanho:', qrRes.data.value.length);
        } else {
            console.log('   - AVISO: Campo "value" está vazio!');
        }

    } catch (error) {
        console.error('ERRO NO DIAGNÓSTICO:', error.response ? error.response.status : error.message);
        if (error.response) console.error('BODY:', error.response.data);
    }
}

diagnose();
