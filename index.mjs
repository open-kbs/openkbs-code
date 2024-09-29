import express from 'express';
import jwt from 'jsonwebtoken';
import AWS from 'aws-sdk';
import crypto from 'crypto';
import url from 'url';
import https from 'https';
import axios from 'axios';
import * as cheerio from 'cheerio';
import vm from 'vm';
import Decimal from 'decimal.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

async function executeHandler({ userCode, event, debug }) {
    let options = {
        timeout: 180 * 1000,
        displayErrors: true
    };

    // Create a new Script object
    let script = new vm.Script(`${userCode}`);

    let consoleLogs = [];
    let consoleErrors = [];

    const rootContext = {
        setTimeout: setTimeout,
        axios: axios,
        cheerio: cheerio,
        console: {
            log: (...args) => consoleLogs.push(args),
            error: (...args) => consoleErrors.push(args)
        },
        Buffer,
        URL,
        Decimal,
        crypto,
        openkbs: () => console.log("OpenKBS sdk not available while running onPremises infrastructure"),
        url,
        https,
        jwt,
        AWS: AWS,
        __dirname: '/tmp',
        require: (id) => {
            if (id === 'aws-sdk') {
                return AWS
            }

            return require(id)
        },
        module: { exports: {} }
    }

    const sandbox = {
        ...rootContext,
        rootContext
    };

    // Run the script in the sandbox context
    script.runInNewContext(sandbox, options);

    // Run the handler with the event
    const handler = sandbox.module.exports.handler;

    let response = await handler(event);

    if (response) {
        // response = maskSecretsInOutput(response, decryptedSecrets)
    }

    if (debug) {
        return {
            response,
            consoleLogs: consoleLogs,
            consoleErrors: consoleErrors
        }
    }

    return response
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, transaction-jwt');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,POST');
    res.setHeader('Access-Control-Max-Age', 600);
    next();
});

app.options('*', (req, res) => {
    res.status(200).json({ message: 'CORS preflight successful' });
});

app.all('/', async (req, res) => {
    const method = req.method;

    try {
        let data;

        if (method === 'GET') {
            data = req.query;
        } else if (method === 'POST') {
            data = req.body;
        }

        const userCode = data.userCode;

        const event = {
            method,
            queryParams: req.query,
            ...req.body?.event
        }

        const response = await executeHandler({ userCode, event });

        if (response?.body) {
            res.status(200).json(response);
        } else {
            res.status(200).json(response);
        }

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({
            error: error?.message || error
        });
    }
});

app.listen(38595, 'localhost', () => {
    console.log('Server is running on http://localhost:38595');
});