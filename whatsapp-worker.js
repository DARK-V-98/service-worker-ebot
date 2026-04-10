const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const pino = require('pino');
const QRCode = require('qrcode');
const admin = require('firebase-admin');
const fs = require('fs');
require('dotenv').config({ path: '.env.local' });

const WALLET_AUTH_DIR = 'auth_info_baileys';
const SERVICE_ACCOUNT_FILE = './eduhubsl0-firebase-adminsdk-fbsvc-55642e63cb.json';
const TARGET_EMAIL = 'tikfese@gmail.com'; 

if (!admin.apps.length) {
  let serviceAccount;
  const envKey = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (envKey) {
    console.log("☁️  SYSTEM: Attempting to load credentials from Environment Variable...");
    try {
      serviceAccount = JSON.parse(envKey);
    } catch (e) {
      console.error("❌ ERROR: Your FIREBASE_SERVICE_ACCOUNT variable is not valid JSON!");
      process.exit(1);
    }
  } else if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    console.log("📁 SYSTEM: Loading credentials from local JSON file...");
    serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'));
  }

  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("✅ SYSTEM: Firebase Admin initialized successfully.");
  } else {
    console.error("❌ CRITICAL ERROR: No Firebase credentials found. Please set FIREBASE_SERVICE_ACCOUNT in Railway.");
    process.exit(1);
  }
}
const db = admin.firestore();

let sock;
let isReconnecting = false;

// --- MESSAGE DEBOUNCING QUEUE ---
const messageQueues = {}; 
const DEBOUNCE_WAIT = 3000; 

async function processQueuedMessages(jid, pushName) {
    const queue = messageQueues[jid];
    if (!queue || queue.messages.length === 0) return;

    const fullText = queue.messages.join(' ').trim();
    const phone = jid.split('@')[0];
    
    console.log(`\n📬 Processing Combined Messages for ${phone}: "${fullText}"`);

    const payload = {
      message: fullText,
      phone: phone,
      name: pushName || 'Customer'
    };
    const headers = { 'Authorization': 'Bearer dev-token' };

    const urls = [
      process.env.NEXT_PUBLIC_SITE_URL,
      'http://127.0.0.1:3000'
    ].filter(Boolean);

    let replied = false;
    for (const url of urls) {
      if (replied) break;
      try {
        const response = await axios.post(`${url}/api/simulator`, payload, { headers, timeout: 60000 });
        const { reply, products } = response.data;

        if (reply) {
          console.log(`🤖 AI: ${reply}`);
          
          if (products && products.length > 0) {
            const rows = products.slice(0, 10).map(p => ({
              title: p.name.substring(0, 24),
              rowId: `prod_${p.id}`,
              description: `Rs. ${p.price} | ${p.category || 'Hardware'}`.substring(0, 72)
            }));

            await sock.sendMessage(jid, {
              text: reply,
              footer: 'Aarya Bathware Selection',
              title: 'Available Items',
              buttonText: 'View Catalog',
              sections: [{ title: 'Store Collection', rows }]
            });
          } else {
            await sock.sendMessage(jid, { text: reply });
          }
          replied = true;
        }
      } catch (err) { }
    }
    
    delete messageQueues[jid];
}

async function startBot() {
  console.log("🚀 Aarya Bathware Bridge Starting (with Anti-Storm mode)...");
  
  const { state, saveCreds } = await useMultiFileAuthState(WALLET_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'error' }),
    browser: ['Aarya System', 'Chrome', '10.0.0'],
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  const snapshot = await db.collection('businesses').where('email', '==', TARGET_EMAIL).limit(1).get();
  if (snapshot.empty) return console.error("❌ Business not found in database.");
  const bizRef = snapshot.docs[0].ref;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr);
      await bizRef.update({ whatsapp_qr: qrDataUrl, whatsapp_status: 'disconnected' });
    }
    if (connection === 'open') {
      console.log('✅ AI BOT IS LIVE & LISTENING!');
      await bizRef.update({ whatsapp_status: 'connected', whatsapp_qr: null });
    }
    if (connection === 'close') {
      const code = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
      if (code === 401 || code === 400) {
        if (fs.existsSync(WALLET_AUTH_DIR)) fs.rmSync(WALLET_AUTH_DIR, { recursive: true, force: true });
      }
      setTimeout(startBot, 5000);
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
    if (!text) return;

    if (!messageQueues[jid]) {
        messageQueues[jid] = { messages: [], timer: null };
    }

    messageQueues[jid].messages.push(text);

    if (messageQueues[jid].timer) {
        clearTimeout(messageQueues[jid].timer);
    }

    messageQueues[jid].timer = setTimeout(() => {
        processQueuedMessages(jid, msg.pushName);
    }, DEBOUNCE_WAIT);
  });
}

startBot();

