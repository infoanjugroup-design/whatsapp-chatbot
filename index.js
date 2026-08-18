const express = require("express");
const pino = require("pino");
const { createClient } = require("@supabase/supabase-js");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON,
  delay,
} = require("@whiskeysockets/baileys");

// ----------------------------------------------------------------------------
// Environment Variables
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const AUTO_REPLY_ENDPOINT_URL = process.env.AUTO_REPLY_ENDPOINT_URL;
const AUTO_REPLY_SHARED_SECRET = process.env.AUTO_REPLY_SHARED_SECRET;
const ACCESS_KEY = process.env.QR_ACCESS_KEY || process.env.PAIR_ACCESS_KEY;

// Phone number with country code (e.g., 919876543210 - no '+', no spaces)
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER
  ? process.env.PAIRING_PHONE_NUMBER.replace(/[^\d]/g, "")
  : null;

// Supabase Credentials
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!AUTO_REPLY_ENDPOINT_URL) {
  console.error("FATAL: AUTO_REPLY_ENDPOINT_URL is not set. Refusing to start.");
  process.exit(1);
}

if (!PAIRING_PHONE_NUMBER) {
  console.error("FATAL: PAIRING_PHONE_NUMBER is required for phone number linking. Example: 91XXXXXXXXXX");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for session persistence.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ---- Shared in-memory state ----
let latestPairingCode = null;
let connectionStatus = "starting";

// ----------------------------------------------------------------------------
// Custom Supabase Auth State Adapter for Baileys
// ----------------------------------------------------------------------------
async function useSupabaseAuthState() {
  const readData = async (type, id) => {
    try {
      const { data, error } = await supabase
        .from("whatsapp_auth")
        .select("data")
        .eq("id", `${type}:${id}`)
        .maybeSingle();

      if (error || !data) return null;
      return JSON.parse(JSON.stringify(data.data), BufferJSON.reviver);
    } catch (err) {
      logger.error({ err, type, id }, "Error reading auth state from Supabase");
      return null;
    }
  };

  const writeData = async (type, id, value) => {
    try {
      const parsed = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
      await supabase.from("whatsapp_auth").upsert({
        id: `${type}:${id}`,
        data: parsed,
      });
    } catch (err) {
      logger.error({ err, type, id }, "Error writing auth state to Supabase");
    }
  };

  const removeData = async (type, id) => {
    try {
      await supabase.from("whatsapp_auth").delete().eq("id", `${type}:${id}`);
    } catch (err) {
      logger.error({ err, type, id }, "Error deleting auth data from Supabase");
    }
  };

  const creds = (await readData("creds", "main")) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result = {};
          for (const id of ids) {
            const data = await readData(type, id);
            if (data) {
              result[id] = data;
            }
          }
          return result;
        },
        set: async (data) => {
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) {
                await writeData(type, id, value);
              } else {
                await removeData(type, id);
              }
            }
          }
        },
      },
    },
    saveCreds: () => writeData("creds", "main", creds),
    clearAuth: async () => {
      await supabase.from("whatsapp_auth").delete().neq("id", "");
    },
  };
}

// ----------------------------------------------------------------------------
// Express HTTP Server
// ----------------------------------------------------------------------------
const app = express();

app.get("/health", (_req, res) => {
  res.status(connectionStatus === "connected" ? 200 : 503).json({ 
    status: connectionStatus,
    pairedNumber: PAIRING_PHONE_NUMBER 
  });
});

// Main UI page showing the pairing code
const renderPairingPage = (req, res) => {
  if (ACCESS_KEY && req.query.key !== ACCESS_KEY) {
    return res.status(401).send("Unauthorized");
  }
  if (connectionStatus === "connected") {
    return res.send(`
      <html><body style="text-align:center;font-family:sans-serif;padding-top:50px;">
        <h2 style="color:#128c7e;">✅ WhatsApp is Connected & Active!</h2>
        <p>Your bot is listening and auto-replying.</p>
      </body></html>
    `);
  }
  if (!latestPairingCode) {
    return res.send(`
      <html><body style="text-align:center;font-family:sans-serif;padding-top:50px;">
        <h2>Generating pairing code for ${PAIRING_PHONE_NUMBER}...</h2>
        <p>Please refresh in a few seconds.</p>
        <script>setTimeout(() => location.reload(), 3000);</script>
      </body></html>
    `);
  }
  return res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Linking</title>
      </head>
      <body style="text-align:center;font-family:sans-serif;padding-top:40px;background:#f0f2f5;">
        <div style="max-width:450px;margin:auto;background:white;padding:30px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
          <h2 style="color:#075e54;margin-top:0;">Link WhatsApp Number</h2>
          <p style="color:#555;font-size:15px;line-height:1.5;">
            1. Open WhatsApp on <b>+${PAIRING_PHONE_NUMBER}</b><br/>
            2. Tap <b>Settings</b> &rarr; <b>Linked Devices</b> &rarr; <b>Link a Device</b><br/>
            3. Tap <b>"Link with phone number instead"</b>
          </p>
          <hr style="border:0;border-top:1px solid #eee;margin:20px 0;"/>
          <p style="font-size:14px;color:#777;margin-bottom:5px;">Enter this code on your phone:</p>
          <div style="font-size:2.6em;letter-spacing:0.2em;font-weight:bold;color:#128c7e;background:#e7f7e9;padding:15px;border-radius:8px;display:inline-block;">
            ${latestPairingCode}
          </div>
          <p style="font-size:12px;color:#999;margin-top:20px;">Page auto-refreshes every 6 seconds until connected.</p>
        </div>
        <script>setTimeout(() => location.reload(), 6000);</script>
      </body>
    </html>
  `);
};

app.get("/", renderPairingPage);
app.get("/pair", renderPairingPage);

app.listen(PORT, () => {
  logger.info(`HTTP server running on port ${PORT}. Open / or /pair to view pairing code.`);
});

// ----------------------------------------------------------------------------
// API Communication with Next.js Backend
// ----------------------------------------------------------------------------
async function getReply(phone, message) {
  try {
    const url = new URL(AUTO_REPLY_ENDPOINT_URL);
    const headers = { "Content-Type": "application/json" };
    if (AUTO_REPLY_SHARED_SECRET) {
      headers["x-auto-reply-key"] = AUTO_REPLY_SHARED_SECRET;
    }

    const response = await fetch(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({ phone, message }),
    });

    if (!response.ok) {
      logger.error({ status: response.status }, "Auto-reply endpoint returned non-OK status");
      return "Sorry, something went wrong. Please try again in a moment.";
    }

    return await response.text();
  } catch (error) {
    logger.error(error, "Failed to call auto-reply endpoint");
    return "Sorry, something went wrong. Please try again in a moment.";
  }
}

// ----------------------------------------------------------------------------
// WhatsApp Bot Main Logic
// ----------------------------------------------------------------------------
async function startBot() {
  const { state, saveCreds, clearAuth } = await useSupabaseAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false, // QR completely disabled
    browser: ["Ubuntu", "Chrome", "20.0.04"], // Custom client descriptor
  });

  // Pairing code request (runs only when device is not yet linked)
  if (!sock.authState.creds.registered) {
    await delay(3500); // Wait for connection handshake initiation
    try {
      const code = await sock.requestPairingCode(PAIRING_PHONE_NUMBER);
      latestPairingCode = code;
      connectionStatus = "pairing_pending";

      console.log("\n==========================================");
      console.log(` WHATSAPP PAIRING CODE: ${code}`);
      console.log(` Phone: +${PAIRING_PHONE_NUMBER}`);
      console.log("==========================================\n");
    } catch (err) {
      logger.error(err, "Failed to generate pairing code. Please check PAIRING_PHONE_NUMBER.");
    }
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      connectionStatus = "connected";
      latestPairingCode = null;
      console.log("\n==========================================");
      console.log(" WhatsApp Linked Device Connected Successfully!");
      console.log("==========================================\n");
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        logger.error("WhatsApp session unlinked/logged out. Clearing database auth...");
        await clearAuth();
        return;
      }

      logger.warn({ statusCode }, "Connection closed. Reconnecting in 5 seconds...");
      setTimeout(() => {
        startBot().catch((err) => logger.error(err, "Reconnect failed"));
      }, 5000);
    }
  });

  // Handle incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await handleIncomingMessage(sock, msg);
      } catch (err) {
        logger.error(err, "Error processing incoming message");
      }
    }
  });
}

async function handleIncomingMessage(sock, msg) {
  if (msg.key.fromMe) return; // Ignore bot's own messages

  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return;

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    "";

  if (!text.trim()) return;

  const phone = remoteJid.replace(/@s\.whatsapp\.net$/, "");
  logger.info({ phone, text }, "Incoming WhatsApp message");

  const replyText = await getReply(phone, text);

  try {
    await sock.sendMessage(remoteJid, { text: replyText });
  } catch (err) {
    logger.error({ err, remoteJid }, "Failed to send message reply");
  }
}

// Start bot
startBot().catch((err) => {
  logger.error(err, "Fatal bot initialization error");
  process.exit(1);
});
