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
import { createTransactionJWT, OpenKBS } from "./sdk.mjs";
import { join, resolve } from 'path';
import { homedir } from 'os';
import { promises as fs } from 'fs';
const require = createRequire(import.meta.url);

function isSecretComplex(secret) {
    // Define the complexity rules
    const minLength = 8;
    const hasUppercase = /[A-Z]/;
    const hasLowercase = /[a-z]/;
    const hasDigit = /[0-9]/;

    // Check the password against the rules
    return (
        secret.length >= minLength &&
        hasUppercase.test(secret) &&
        hasLowercase.test(secret) &&
        hasDigit.test(secret) || new Set(secret).size > minLength
    );
}

async function loadSecrets() {
    const jsonFilePath = resolve(join(homedir(), '.openkbs', 'codeSecrets.json'));

    try {
        const jsonFileContent = await fs.readFile(jsonFilePath, 'utf-8');
        return JSON.parse(jsonFileContent);
    } catch (error) {
        return {};
    }
}

export function maskSecretsInOutput(response, secrets) {
    Object.values(secrets).forEach(secretValue => {
        if (secretValue && isSecretComplex(secretValue)) {
            // Escape special characters in the secret value for use in a regular expression
            const escapedSecretValue = secretValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const secretRegex = new RegExp(escapedSecretValue, 'g');

            try {
                response = JSON.parse(JSON.stringify(response)?.replace(secretRegex, '***MASKED_SECRET***'));
            } catch (e) {
                console.log('unable to mask secrets')
            }

        }
    });
    return response;
}

function replaceSecrets(code, secrets) {
    return code?.replace(/\{\{\s*secrets\.(\w+)\s*\}\}/g, (match, secretKey) => {
        if (secrets.hasOwnProperty(secretKey)) {
            return secrets[secretKey];
        }
        return match; // If the key is not found in the secrets map, leave the placeholder unchanged
    });
}

async function executeHandler({ userCode, event, debug, transactionProvider }) {
    let options = {
        timeout: 180 * 1000,
        displayErrors: true
    };

    const secrets = await loadSecrets();
    userCode  = replaceSecrets(userCode, secrets);

    const openkbs = new OpenKBS({transactionProvider});

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
        openkbs,
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

        let  {
            event,
            AESKey,
            secrets,
            walletPrivateKey,
            walletPublicKey,
            debug,
            accountId
        } = data;

        const transactionProvider = (toAccountId, maxAmount) => createTransactionJWT({
            toAccountId, walletPublicKey, walletPrivateKey, fromAccountId: accountId,
            AESKey, maxAmount, kbId: (data?.kbId || 'unknown')
        })

        const userCode = data.userCode;

        const response = await executeHandler({ userCode, event, debug, transactionProvider });

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