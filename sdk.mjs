import crypto from 'crypto';
import CryptoJS from "crypto-js";
import axios from 'axios';
import jwt from 'jsonwebtoken';

const generateTransactionId = () => `${+new Date()}-${Math.floor(100000 + Math.random() * 900000)}`;

export const decrypt = (ciphertext, key) => {
    if (ciphertext == null) return ciphertext;
    if (key == null) throw new Error('Either ciphertext or key is null');
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    return bytes.toString(CryptoJS.enc.Utf8);
}

export const RESOURCE = {
    tokens: 'credits',
    bonusTokens: 'bonusTokens'
}

const transactionSubjects = {
    paymentIntent: 'paymentIntent',
    kbId: 'kbId',
};

export function signPayload(payload, privateKey, expiresIn = 1000 * 60) {
    try {
        const token = jwt.sign(payload, privateKey, {
            algorithm: 'ES256',
            header: { alg: 'ES256', typ: 'JWT',},
            expiresIn
        });

        return token;
    } catch (error) {
        console.error('JWT Signing Error:', error);
    }
}

export const createTransactionJWT = async ({
    toAccountId, message, walletPublicKey, walletPrivateKey, fromAccountId, AESKey, maxAmount, kbId
}) => {
    if (!AESKey) return;
    const walletPrivateKeyDecrypted = await decrypt(walletPrivateKey, AESKey);
    const JWTPayload = {
        operation: "transfer",
        resourceId: RESOURCE.tokens,
        transactionId: generateTransactionId(),
        fromAccountId,
        fromAccountPublicKey: walletPublicKey,
        toAccountId,
        message: message || '',
        subjectId: kbId,
        subject: transactionSubjects.kbId,
        maxAmount: maxAmount || 300000,
        iat: Math.round(+new Date()/1000),
    };

    const transactionJWT = signPayload(JWTPayload, crypto.createPrivateKey({
        key: Buffer.from(walletPrivateKeyDecrypted, 'base64'),
        format: 'der',
        type: 'pkcs8'
    }));

    return transactionJWT;
}


// Note: Prices are listed in credits.
// 1,000 credits are equivalent to 1 cent.
const services = {
    "whisperLargeV3": {
        url: "https://pipe.openkbs.com/openai--whisper-large-v3--default",
        accountId: 'a3d08121d9bd3b0723e3bdd2046d0368',
        pricePerMinute: 600,
        modelType: "voiceToText"
    },
    "stability.sd35Large": {
        url: "https://pipe.openkbs.com/stabilityai--stable-3.5-large--default",
        accountId: '262be27db3355db0b5164bc4f50fee5f',
        pricePerRequest: 2000,
    },
    "stability.sd3Medium": {
        url: "https://pipe.openkbs.com/stabilityai--stable-diffusion-3-medium-diffusers--default",
        accountId: '9dd958f4d240fdf65b2d7adfec7b1c88',
        pricePerRequest: 1000,
    },
    "stability.sdxl": {
        url: "https://pipe.openkbs.com/stabilityai--stable-diffusion-xl-base-1.0--with-refiner",
        accountId: '823a4455353a7338a2ddb4d196407e02',
        pricePerRequest: 200,
    },
    "animagine.xl3": {
        url: "https://pipe.openkbs.com/cagliostrolab--animagine-xl-3.0--default",
        accountId: '9326273541dade3a8ea71c628db2ba35',
        pricePerRequest: 400,
    },
    "readWebpage": {
        url: "https://webtools.openkbs.com/readWebpage",
        accountId: 'c10975c3ac1b34cbbf6fda8ca315c1d3',
        pricePerMinute: 8 * 60,
    },
    "documentToText": {
        url: "https://doctools.openkbs.com",
        accountId: '0b9b011827d4a19b8d8e320f3a3f6337',
        pricePerMinute: 4 * 60,
    },
    "googleSearch": {
        url: "https://webtools.openkbs.com/googleSearch",
        accountId: '3903571e4243f078b7e80d0d34039ead',
        pricePerRequest: 600,
    },
    "gcp.textDetection": {
        url: "https://api.openkbs.com/imageToText",
        accountId: 'b28ee77d5a8dce90abdff4781e8fdadf',
        pricePerRequest: 150
    },
    "translateText": {
        url: "https://api.openkbs.com/translateText",
        accountId: 'cbda4c0737d6a3c2e7c7201dc75ff0b2',
        pricePerCharacter: 3
    },
    "gcp.textToSpeech": {
        url: "https://api.openkbs.com/textToSpeech",
        accountId: '287434e0a2c405f9116ebc4e5b572cc3',
        pricePerCharacter: 3
    },
}

function findServiceByURL(url) {
    for (const key in services) {
        if (services.hasOwnProperty(key)) {
            const service = services[key];
            if (service.url === url) return service;
        }
    }
    return null;
}


export class OpenKBS {

    constructor({transactionProvider}) {
        this.transactionProvider = transactionProvider
        return this;
    }

    async service(serviceURL, accountId, params, config = {}) {
        const transactionJWT = await this.transactionProvider(accountId);
        let url = new URL(serviceURL);

        if (params) {
            Object.keys(params).forEach(key => {
                if (params[key]) url.searchParams.append(key, params[key]); // Properly append query parameters
            });
        }

        const response = await axios.get(url.toString(), { headers: {'transaction-jwt': transactionJWT}, ...config }); // Convert URL object back to string
        return response;
    }

    async textToImage(prompt, params = {}) {
        let service;
        if (params?.serviceId) {
            service = services[params?.serviceId]
        } else {
            service = services["stability.sd3Medium"]
        }

        if (params?.serviceId) delete params.serviceId;

        const response = await this.service(service.url, service.accountId, { prompt, ...params }, { responseType: 'arraybuffer' })

        return {
            ContentType: response.headers['content-type'],
            base64Data: Buffer.from(response.data).toString('base64')
        }
    }

    async speechToText(audioURL, params = {}) {
        const {url, accountId} = findServiceByURL('https://pipe.openkbs.com/openai--whisper-large-v3--default');
        const response = await this.service(url, accountId, { audio: audioURL, ...params})
        return response.data
    }

    async webpageToText(pageURL, params) {
        const {url, accountId} = findServiceByURL('https://webtools.openkbs.com/readWebpage');
        const response = await this.service(url, accountId, { url: pageURL, ...params})
        return response.data
    }

    async googleSearch(q, params) {
        const {url, accountId} = findServiceByURL('https://webtools.openkbs.com/googleSearch');
        const response = await this.service(url, accountId, { q, ...params})
        return response?.data?.items
    }

    async documentToText(documentURL, params) {
        const {url, accountId} = findServiceByURL('https://doctools.openkbs.com');
        const response = await this.service(url, accountId, { url: documentURL, ...params})
        return response?.data
    }

    async imageToText(imageUrl, params) {
        const {url, accountId} = findServiceByURL('https://api.openkbs.com/imageToText');
        const response = await this.service(url, accountId, { url: imageUrl, ...params})

        if (params?.textOnly && response?.data?.detections?.[0]?.txt) {
            return { detections: response?.data?.detections?.[0]?.txt }
        }

        return response?.data
    }

    async translate(text, to) {
        const {url, accountId} = findServiceByURL('https://api.openkbs.com/translateText');
        const response = await this.service(url, accountId, { text, method: 'translate', to })
        return response?.data
    }

    async detectLanguage(text, params) {
        const {url, accountId} = findServiceByURL('https://api.openkbs.com/translateText');
        const response = await this.service(url, accountId, { text, method: 'detect', ...params})
        return response?.data
    }

    async textToSpeech(text, params) {
        const {url, accountId} = findServiceByURL('https://api.openkbs.com/textToSpeech');
        const response = await this.service(url, accountId, { text, ...params })
        return response?.data
    }
}