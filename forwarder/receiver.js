const express = require('express');
const fs = require('fs');
const { BalenaLogForwarder } = require('./forwarder.js');

const PORT = process.env.PORT || 4224;
const uuid = process.env.BALENA_DEVICE_UUID;
const deviceApiKey = process.env.BALENA_API_KEY;
const apiEndpoint = process.env.BALENA_API_URL;

const app = express();
const forwarder = new BalenaLogForwarder({ apiEndpoint, uuid, deviceApiKey });

app.use(express.json());

if (typeof uuid !== 'string' || uuid == null) {
    console.error('BALENA_DEVICE_UUID does not exist as an env var');
} else if (typeof deviceApiKey !== 'string' || deviceApiKey == null) {
    console.error('BALENA_API_KEY does not exist as an env var');
}

const healthy = () => true;

app.get('/healthy', (_req, res) => {
    if (healthy()) {
        return res.sendStatus(200);
    }
    return res.sendStatus(500);
});

const writeStream = fs.createWriteStream('/usr/src/app/logs/intake.log');

app.post('/intake', (req, res) => {
    if (req.body.timestamp === 0) {
        req.body.timestamp = Date.now();
    } else {
        req.body.timestamp = Math.floor(req.body.timestamp / 1000);
    }

    // Temporary logic to ensure backend receives logs
    if (req.body.isSystem || !/test/.test(req.body.message)) {
        delete req.body.serviceId;
        delete req.body.imageId;
        req.body.isSystem = true;
    }

    writeStream.write(JSON.stringify(req.body) + '\n');
    forwarder.log(req.body);
    res.sendStatus(200);
});

app.listen(PORT, () => {
    console.log(`Log receiver listening on port ${PORT}`);
});
