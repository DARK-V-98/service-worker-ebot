const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
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

console.log("-----------------------------------------");
console.log("🚀 E BOT 2.0 BOOT SEQUENCE STARTING...");
console.log("   📸 Media Handler: ACTIVE");
console.log("   📋 Interactive Buttons: ACTIVE");
console.log("   🔔 Push Notifications: ACTIVE");
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
const DEBOUNCE_WAIT = 3000; 

/**
 * Extract media type info from a Baileys message
 */
function getMediaType(msg) {
  const m = msg.message;
  if (!m) return null;

  if (m.imageMessage)    return { type: 'image',    key: 'imageMessage',    mimetype: m.imageMessage.mimetype,    caption: m.imageMessage.caption };
  if (m.audioMessage)    return { type: 'audio',    key: 'audioMessage',    mimetype: m.audioMessage.mimetype,    duration: m.audioMessage.seconds };
  if (m.videoMessage)    return { type: 'video',    key: 'videoMessage',    mimetype: m.videoMessage.mimetype,    caption: m.videoMessage.caption, duration: m.videoMessage.seconds };
  if (m.documentMessage) return { type: 'document', key: 'documentMessage', mimetype: m.documentMessage.mimetype, filename: m.documentMessage.fileName };
  if (m.stickerMessage)  return { type: 'sticker',  key: 'stickerMessage',  mimetype: m.stickerMessage.mimetype };
  if (m.locationMessage) return { type: 'location', latitude: m.locationMessage.degreesLatitude, longitude: m.locationMessage.degreesLongitude };

  return null;
}

/**
 * Extract text from various message types including button responses
 */
function extractTextFromMessage(msg) {
  const m = msg.message;
  if (!m) return null;

  // Regular text messages
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  
  // Interactive button responses
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.singleSelectReply.selectedRowId;
  if (m.templateButtonReplyMessage?.selectedId) return m.templateButtonReplyMessage.selectedId;
  
  // Interactive message responses (reply buttons from Meta)
  if (m.interactiveResponseMessage) {
    try {
      const body = m.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson;
      if (body) {
        const parsed = JSON.parse(body);
        return parsed.id || parsed.flow_token || null;
      }
    } catch (e) {}
  }

  return null;
}

/**
 * Download and convert media to base64
 */
async function downloadMediaAsBase64(msg, mediaInfo) {
  try {
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    const base64 = buffer.toString('base64');
    const dataUrl = `data:${mediaInfo.mimetype || 'application/octet-stream'};base64,${base64}`;
    console.log(`📥 Media downloaded: ${mediaInfo.type} (${(buffer.length / 1024).toFixed(1)} KB)`);
    return dataUrl;
  } catch (err) {
    console.error(`⚠️  Media download failed:`, err.message);
    return null;
  }
}

async function processQueuedMessages(jid, pushName) {
    const queue = messageQueues[jid];
    if (!queue || queue.messages.length === 0) return;

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
      'http://127.0.0.1:3000',
      process.env.NEXT_PUBLIC_SITE_URL
    ].filter(Boolean);

    let replied = false;
    for (const url of urls) {
      if (replied) break;
      try {
        console.log(`📡 Sending to: ${url}/api/simulator`);
        const response = await axios.post(`${url}/api/simulator`, payload, { headers, timeout: 60000 });
        const { reply, products, replyButtons, interactiveType } = response.data;

        if (reply) {
          console.log(`🤖 AI Reply: ${reply.substring(0, 50)}...`);
          
          if (interactiveType === 'image' && products && products.length > 0 && products[0].image_url) {
            console.log('🖼️  Sending Image Message via Baileys...');
            await sock.sendMessage(jid, {
              image: { url: products[0].image_url },
              caption: reply
            });
            // Send buttons as a quick follow-up if applicable
            if (replyButtons && replyButtons.length > 0) {
              try {
                const buttons = replyButtons.map(b => ({ buttonId: String(b.id), buttonText: { displayText: b.title }, type: 1 }));
                await sock.sendMessage(jid, { text: "What would you like to do next?", buttons: buttons, headerType: 1 });
              } catch(e) { } 
            }
          }
          else if (interactiveType === 'list' || (!interactiveType && products && products.length > 0)) {
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
          }
          else if (interactiveType === 'reply_buttons' && replyButtons && replyButtons.length > 0) {
            try {
              const buttons = replyButtons.map(b => ({ buttonId: String(b.id), buttonText: { displayText: b.title }, type: 1 }));
              await sock.sendMessage(jid, { text: reply, buttons: buttons, headerType: 1 });
            } catch(e) {
              await sock.sendMessage(jid, { text: reply });
            }
          }
          else {
            await sock.sendMessage(jid, { text: reply });
          }
          replied = true;
        }
      } catch (err) { 
        console.error(`⚠️  URL Failed: ${url}`);
      }
    }
    
    delete messageQueues[jid];
}

/**
 * Process media messages (images, audio, video, documents, stickers, locations)
 */
async function processMediaMessage(jid, pushName, msg, mediaInfo) {
    const phone = jid.split('@')[0];
    console.log(`\n📸 Media received from ${phone}: ${mediaInfo.type}`);

    // Download media and convert to base64 (for images/stickers only, to save memory)
    let base64 = null;
    if (['image', 'sticker'].includes(mediaInfo.type)) {
      base64 = await downloadMediaAsBase64(msg, mediaInfo);
    }

    const payload = {
      phone: phone,
      name: pushName || 'Customer',
      media: {
        type: mediaInfo.type,
        mimetype: mediaInfo.mimetype || null,
        caption: mediaInfo.caption || null,
        filename: mediaInfo.filename || null,
        base64: base64,
        latitude: mediaInfo.latitude || null,
        longitude: mediaInfo.longitude || null,
        duration: mediaInfo.duration || null,
      }
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
        console.log(`📡 Sending media to: ${url}/api/simulator/media`);
        const response = await axios.post(`${url}/api/simulator/media`, payload, { headers, timeout: 90000 });
        const { reply } = response.data;

        if (reply) {
          console.log(`🤖 AI Media Reply: ${reply.substring(0, 50)}...`);
          await sock.sendMessage(jid, { text: reply });
          replied = true;
        }
      } catch (err) {
        console.error(`⚠️  Media URL Failed: ${url}`, err.message);
      }
    }

    // Fallback if all URLs fail
    if (!replied) {
      const fallbacks = {
        image: "📷 I received your image! Let me know what you'd like help with.",
        audio: "🎤 I received your voice message! Could you please type your request? I can respond faster to text.",
        video: "🎬 Thanks for the video! How can I help you today?",
        document: "📄 I received your document. What would you like me to do with it?",
        sticker: "😄 Nice sticker! How can I help you today?",
        location: "📍 Thanks for sharing your location! Is this for a delivery?"
      };
      await sock.sendMessage(jid, { text: fallbacks[mediaInfo.type] || "I received your media. How can I help?" });
    }
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
      const code = (lastDisconnect.error instanceof Boom)?.output?.statusCode;
      console.log(`🔌 Connection closed (Code: ${code}). Reconnecting...`);
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
    
    // --- CHECK FOR MEDIA MESSAGES FIRST ---
    const mediaInfo = getMediaType(msg);
    if (mediaInfo) {
      // Process media immediately (no debouncing for media)
      await processMediaMessage(jid, msg.pushName, msg, mediaInfo);
      return;
    }

    // --- TEXT / BUTTON RESPONSE MESSAGES ---
    const text = extractTextFromMessage(msg);
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
