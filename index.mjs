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
import path, { join, resolve } from 'path';
import { homedir } from 'os';
import { promises as fs } from 'fs';
import readline from 'readline';
import process from 'process';

const require = createRequire(import.meta.url);

const reset = "\x1b[0m";
const bold = "\x1b[1m";
const red = "\x1b[31m";
const yellow = "\x1b[33m";
const green = "\x1b[32m";

console.red = (data) =>  console.log(`${red}${data}${reset}`)
console.green = (data) =>  console.log(`${green}${bold}${data}${reset}`)
console.yellow = (data) =>  console.log(`${yellow}${bold}${data}${reset}`)


function isSecretComplex(secret) {
    const minLength = 8;
    const hasUppercase = /[A-Z]/;
    const hasLowercase = /[a-z]/;
    const hasDigit = /[0-9]/;

    return (
        secret.length >= minLength &&
        hasUppercase.test(secret) &&
        hasLowercase.test(secret) &&
        hasDigit.test(secret) || new Set(secret).size > minLength
    );
}

function replaceSecrets(code, secrets) {
    return code?.replace(/\{\{\s*secrets\.(\w+)\s*\}\}/g, (match, secretKey) => {
        if (secrets.hasOwnProperty(secretKey)) {
            return secrets[secretKey];
        }
        return match; // If the key is not found in the secrets map, leave the placeholder unchanged
    });
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

async function saveSecrets(secrets) {
    const jsonFilePath = resolve(join(homedir(), '.openkbs', 'codeSecrets.json'));
    await fs.mkdir(resolve(join(homedir(), '.openkbs')), { recursive: true });
    await fs.writeFile(jsonFilePath, JSON.stringify(secrets, null, 2), 'utf-8');
}

export function maskSecretsInOutput(response, secrets) {
    Object.values(secrets).forEach(secretValue => {
        if (secretValue && isSecretComplex(secretValue)) {
            const escapedSecretValue = secretValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const secretRegex = new RegExp(escapedSecretValue, 'g');

            try {
                response = JSON.parse(JSON.stringify(response)?.replace(secretRegex, '***MASKED_SECRET***'));
            } catch (e) {
                console.log('unable to mask secrets');
            }
        }
    });
    return response;
}

export function parseSecrets(code) {
    const secretsPattern = /{{\s*secrets\.([a-zA-Z0-9_]+)\s*}}/g;
    let match;
    const secrets = [];

    while ((match = secretsPattern.exec(code)) !== null) {
        secrets.push(match[1]);
    }

    return secrets;
}

async function promptForSecrets(secrets) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const collectedSecrets = {};

    for (const secret of secrets) {
        collectedSecrets[secret] = await new Promise(resolve => {
            rl.question(`Enter value for secret "${secret}": `, resolve);
        });
    }

    rl.close();
    return collectedSecrets;
}

async function collectSecretsFromFiles(dir) {
    let secrets = new Set();

    async function readDirRecursive(directory) {
        const files = await fs.readdir(directory, { withFileTypes: true });

        for (const file of files) {
            const fullPath = join(directory, file.name);

            if (file.isDirectory()) {
                await readDirRecursive(fullPath);
            } else if (file.isFile()) {
                const content = await fs.readFile(fullPath, 'utf-8');
                const fileSecrets = parseSecrets(content);
                fileSecrets.forEach(secret => secrets.add(secret));
            }
        }
    }

    await readDirRecursive(dir);
    return Array.from(secrets);
}

async function executeHandler({ userCode, event, debug, transactionProvider }) {
    let options = {
        timeout: 180 * 1000,
        displayErrors: true
    };

    const secrets = await loadSecrets();
    userCode = replaceSecrets(userCode, secrets);

    const openkbs = new OpenKBS({ transactionProvider });

    let script = new vm.Script(`${userCode}`);

    let consoleLogs = [];
    let consoleErrors = [];

    const rootContext = {
        setTimeout: setTimeout,
        axios: axios,
        cheerio: cheerio,
        process: process,
        fs: fs,
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
                return AWS;
            }

            return require(id);
        },
        module: { exports: {} }
    };

    const sandbox = {
        ...rootContext,
        rootContext
    };

    script.runInNewContext(sandbox, options);

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
        };
    }

    return response;
}

const printRunning = async () => {
    const figlet = (await import('figlet')).default;
    const chalk = (await import('chalk')).default;
    console.green('\n');
    const asciiArt = await generateAsciiArt('OpenKBS', figlet);
    console.log(chalk.blue(asciiArt));
    console.log(chalk.blue(`                          Code Execution`));
}

const generateAsciiArt = async (text, figlet) => {
    return new Promise((resolve, reject) => {
        figlet(text, (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
};

async function initializeSecrets() {
    const secretsFromFiles = await collectSecretsFromFiles(path.join((process.env.KB_DIR || process.cwd()), 'src'));
    const existingSecrets = await loadSecrets();
    const newSecrets = secretsFromFiles.filter(secret => !(secret in existingSecrets));

    if (newSecrets.length > 0) {
        const userSecrets = await promptForSecrets(newSecrets);
        const updatedSecrets = { ...existingSecrets, ...userSecrets };
        await saveSecrets(updatedSecrets);
    }
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

        let {
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
        });

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

(async () => {
    await initializeSecrets();
    app.listen(38595, 'localhost', async () => {
        await printRunning()
        console.green('\nServer is running on http://localhost:38595')
    });
})();