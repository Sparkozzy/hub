const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Servir os arquivos da pasta frontend automaticamente
const frontendPath = path.join(__dirname, '../frontend');
app.use(express.static(frontendPath));

// Rota explícita para o arquivo principal
app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
    }
});

const PORT = process.env.PORT || 3001;

// Z-API Configuration (Environment Variables for Production)
const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID || '3F593841D8F6F1D722D88699EC5A47CF';
const ZAPI_TOKEN = process.env.ZAPI_TOKEN || '11BBEB710E926E64F5AF73AD';
const CLIENT_TOKEN = process.env.CLIENT_TOKEN || 'F5724b7f8bf0e456bbdad95a16886f435S';

const getCreds = (req) => ({
    instanceId: req.query.instanceId || ZAPI_INSTANCE_ID,
    token: req.query.token || ZAPI_TOKEN,
    clientToken: req.query.clientToken || CLIENT_TOKEN
});

// Webhook URL (Dynamic for Railway/Public URL)
const MY_WEBHOOK_URL = process.env.MY_WEBHOOK_URL || 'https://mindflow-ia-connect.loca.lt/webhook/zapi-connected';
// 1. Endpoint to Register the Webhook Automatically
app.get('/api/setup-webhook', async (req, res) => {
    try {
        const { instanceId, token, clientToken } = getCreds(req);
        const customUrl = req.query.url;
        const finalWebhookUrl = customUrl ? `${customUrl}/webhook/zapi-connected` : MY_WEBHOOK_URL;
        const url = `https://api.z-api.io/instances/${instanceId}/token/${token}/update-webhook-connected`;
        const response = await axios.put(url, {
            value: finalWebhookUrl
        }, {
            headers: { 'Client-Token': clientToken }
        });

        res.json({ success: true, message: 'Webhook registered successfully', data: response.data, registeredUrl: finalWebhookUrl });
    } catch (error) {
        console.error('Error registering webhook:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. QR Code Proxy (Format: Base64)
app.get('/api/qr-code', async (req, res) => {
    try {
        const { instanceId, token, clientToken } = getCreds(req);
        // 1. Verifica o status primeiro (para evitar erro 403 se já estiver conectada)
        const statusUrl = `https://api.z-api.io/instances/${instanceId}/token/${token}/status`;
        const statusResponse = await axios.get(statusUrl, {
            headers: { 'Client-Token': clientToken }
        });

        if (statusResponse.data.connected) {
            return res.json({ connected: true });
        }

        // 2. Se não estiver conectada (apagada/deslogada), pede o QR Code
        const qrUrl = `https://api.z-api.io/instances/${instanceId}/token/${token}/qr-code`;
        const qrResponse = await axios.get(qrUrl, {
            headers: { 'Client-Token': clientToken }
        });

        if (qrResponse.data.connected) {
            return res.json({ connected: true });
        }

        res.json({ base64: qrResponse.data.value });
    } catch (error) {
        console.error('ERRO NA Z-API:', error.message);
        
        // Se der erro 403, quase sempre é porque a instância conectou no meio tempo
        if (error.response && (error.response.status === 403 || error.response.status === 400)) {
             return res.json({ connected: true });
        }

        res.status(500).json({ error: 'Erro ao buscar QR code' });
    }
});

// 4. Disconnect Instance (For testing)
app.get('/api/disconnect', async (req, res) => {
    try {
        const { instanceId, token, clientToken } = getCreds(req);
        const url = `https://api.z-api.io/instances/${instanceId}/token/${token}/disconnect`;
        await axios.get(url, {
            headers: { 'Client-Token': clientToken }
        });
        res.json({ success: true, message: 'Instância desconectada com sucesso!' });
    } catch (error) {
        console.error('Erro ao desconectar:', error.message);
        res.status(500).json({ error: 'Erro ao desconectar' });
    }
});

app.post('/webhook/zapi-connected', (req, res) => {
    const data = req.body;
    console.log('Z-API Connection Webhook Received:', data);

    if (data.type === 'connected' && data.connected) {
        // Notify the frontend via Socket.io
        io.emit('whatsapp-connected', {
            phone: data.phone,
            instanceId: data.instanceId
        });
    }

    res.status(200).send('OK');
});

io.on('connection', (socket) => {
    console.log('Client connected to socket:', socket.id);
});

server.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
