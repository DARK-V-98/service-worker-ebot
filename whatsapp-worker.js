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

// Use the email from environment variables, or fallback to your default
const TARGET_EMAIL = process.env.TARGET_BUSINESS_EMAIL || 'tikfese@gmail.com'; 

console.log(`🎯 TARGETING BUSINESS: ${TARGET_EMAIL}`);

console.log("-----------------------------------------");
console.log("🚀 E BOT 2.0 BOOT SEQUENCE STARTING...");
console.log("-----------------------------------------");

if (!admin.apps.length) {
  let serviceAccount;
  const envKey = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (envKey && envKey.length > 10) {
    console.log("☁️  DETECTED: FIREBASE_SERVICE_ACCOUNT variable found!");
    try {
      serviceAccount = JSON.parse(envKey);
      console.log("✅ SUCCESS: Environment Variable parsed as valid JSON.");
    } catch (e) {
      console.error("❌ ERROR: Your FIREBASE_SERVICE_ACCOUNT variable in Railway is NOT valid JSON.");
      console.error("Make sure it starts with { and ends with } and has no extra text.");
      process.exit(1);
    }
  } else if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    console.log("📁 DETECTED: Local JSON file found.");
    serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'));
  }

  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    console.log("✅ SUCCESS: Firebase Admin Initialized.");
  } else {
    console.error("❌ CRITICAL ERROR: NO CREDENTIALS FOUND!");
    console.error("Checked for Environment Variable 'FIREBASE_SERVICE_ACCOUNT' and File '" + SERVICE_ACCOUNT_FILE + "'. Both are missing.");
    process.exit(1);
  }
}
const db = admin.firestore();

let sock;
let isReconnecting = false;

// --- MESSAGE DEBOUNCING QUEUE ---
const messageQueues = {}; 
const DEBOUNCE_WAIT = 1200; // Turbo Speed: Group messages faster

async function processQueuedMessages(jid, pushName) {
    const queue = messageQueues[jid];
    if (!queue || queue.messages.length === 0) return;

    // Show "Aarya is typing..." to the customer immediately
    await sock.sendPresenceUpdate('composing', jid);

    const fullText = queue.messages.join(' ').trim();
    const phone = jid.split('@')[0];
    
    console.log(`\n📬 Incoming for ${phone}: "${fullText}"`);

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
        console.log(`📡 Sending to: ${url}/api/simulator`);
        const response = await axios.post(`${url}/api/simulator`, payload, { 
          headers, 
          timeout: 45000 
        });
        const { reply, products } = response.data;

        if (reply) {
          console.log(`🤖 AI Reply: ${reply.substring(0, 50)}...`);
          
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
      } catch (err) { 
        const status = err.response?.status || 'Network Error';
        const msg = err.response?.data?.error || err.message;
        console.error(`⚠️  URL Failed: ${url} | Status: ${status} | Error: ${msg}`);
      }
    }

    // Stop typing status after sending
    await sock.sendPresenceUpdate('paused', jid);
    
    delete messageQueues[jid];
}

async function startBot() {
  console.log("🚀 Bridge Engine starting...");
  
  const { state, saveCreds } = await useMultiFileAuthState(WALLET_AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'error' }),
    browser: ['E BOT System', 'Chrome', '10.0.0'],
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  const snapshot = await db.collection('businesses').where('email', '==', TARGET_EMAIL).limit(1).get();
  if (snapshot.empty) return console.error("❌ Business record missing in database.");
  const bizRef = snapshot.docs[0].ref;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
       console.log("📌 QR CODE GENERATED - Check your dashboard!");
       const qrDataUrl = await QRCode.toDataURL(qr);
       await bizRef.update({ whatsapp_qr: qrDataUrl, whatsapp_status: 'disconnected' });
    }
    if (connection === 'open') {
      console.log('✅✅✅ BOT IS ONLINE & CONNECTED!');
      await bizRef.update({ whatsapp_status: 'connected', whatsapp_qr: null });
    }
    if (connection === 'close') {
      const code = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
      const reason = lastDisconnect?.error?.message || 'Unknown reason';
      console.log(`🔌 Connection closed (Code: ${code}, Reason: ${reason}). Reconnecting...`);
      
      if (lastDisconnect?.error) {
         console.log("🛠️  DEBUG ERROR:", lastDisconnect.error);
      }

      if (code === 401 || code === 400 || code === 440) {
        console.log("🧹 Session expired or conflict. Clearing auth folder...");
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



