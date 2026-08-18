const express = require("express");
const QRCode = require("qrcode");
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
const QR_ACCESS_KEY = process.env.QR_ACCESS_KEY;
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER
  ? process.env.PAIRING_PHONE_NUMBER.replace(/[^\d]/g, "")
  : null;

// Supabase Credentials (Render ke environment variables me dalein)
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!AUTO_REPLY_ENDPOINT_URL) {
  console.error("FATAL: AUTO_REPLY_ENDPOINT_URL is not set. Refusing to start.");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for session persistence.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ---- Shared in-memory state ----
let latestQrString = null;
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
      logger.error({ err, type, id }, "Error deleting auth state from Supabase");
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
// Express HTTP Server (Required for Render & Web UI Access)
// ----------------------------------------------------------------------------
const app = express();

app.get("/", (_req, res) => {
  res.json({ status: connectionStatus });
});

app.get("/health", (_req, res) => {
  res.status(connectionStatus === "connected" ? 200 : 503).json({ status: connectionStatus });
});

app.get("/qr", async (req, res) => {
  if (QR_ACCESS_KEY && req.query.key !== QR_ACCESS_KEY) {
    return res.status(401).send("Unauthorized");
  }
  if (connectionStatus === "connected") {
    return res.send("<h2>Already linked and connected. Nothing to scan.</h2>");
  }
  if (!latestQrString) {
    return res.send("<h2>No QR yet — starting up, refresh in a few seconds.</h2>");
  }
  const dataUrl = await QRCode.toDataURL(latestQrString);
  res.send(
    `<html><body style="text-align:center;font-family:sans-serif;padding-top:40px;">
       <h2>Scan with WhatsApp → Linked Devices → Link a Device</h2>
       <img src="${dataUrl}" width="300" height="300" />
       <p>Page auto-refreshes every 5 seconds.</p>
       <script>setTimeout(() => location.reload(), 5000);</script>
     </body></html>`
  );
});

app.get("/pair", (req, res) => {
  if (QR_ACCESS_KEY && req.query.key !== QR_ACCESS_KEY) {
    return res.status(401).send("Unauthorized");
  }
  if (!PAIRING_PHONE_NUMBER) {
    return res.status(400).send("PAIRING_PHONE_NUMBER is not set. Use /qr instead.");
  }
  if (connectionStatus === "connected") {
    return res.send("<h2>Already linked and connected. Nothing to pair.</h2>");
  }
  if (!latestPairingCode) {
    return res.send("<h2>No pairing code yet — generating, refresh in a few seconds.</h2>");
  }
  res.send(
    `<html><body style="text-align:center;font-family:sans-serif;padding-top:40px;">
       <h2>On your phone: WhatsApp → Linked Devices → Link a Device →<br/>"Link with phone number instead"</h2>
       <p>Enter this code:</p>
       <div style="font-size:2.8em;letter-spacing:0.15em;font-weight:bold;color:#128c7e;">${latestPairingCode}</div>
       <p>Page auto-refreshes every 5 seconds.</p>
       <script>setTimeout(() => location.reload(), 5000);</script>
     </body></html>`
  );
});

app.listen(PORT, () => {
  logger.info(
    `HTTP server running on port ${PORT} (${PAIRING_PHONE_NUMBER ? "Pairing at /pair" : "QR at /qr"}, Health at /health)`
  );
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
    printQRInTerminal: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  // Pairing code request (if phone number is set and device is not yet registered)
  if (PAIRING_PHONE_NUMBER && !sock.authState.creds.registered) {
    await delay(3000); // Allow socket connection initialization
    try {
      const code = await sock.requestPairingCode(PAIRING_PHONE_NUMBER);
      latestPairingCode = code;
      connectionStatus = "pairing_pending";
      logger.info(`Pairing code issued: ${code}`);
      console.log("\n==========================================");
      console.log(` WhatsApp Pairing Code: ${code}`);
      console.log("==========================================\n");
    } catch (err) {
      logger.error(err, "Failed to request pairing code. Check PAIRING_PHONE_NUMBER format.");
    }
  }

  // Save session state updates to Supabase
  sock.ev.on("creds.update", saveCreds);

  // Connection status events
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !PAIRING_PHONE_NUMBER) {
      latestQrString = qr;
      connectionStatus = "qr_pending";
      logger.info("New QR generated. Visit /qr to scan.");
    }

    if (connection === "open") {
      connectionStatus = "connected";
      latestQrString = null;
      latestPairingCode = null;
      logger.info("WhatsApp connected successfully!");
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        logger.error("WhatsApp session logged out. Clearing database auth session...");
        await clearAuth();
        return;
      }

      logger.warn({ statusCode }, "Connection closed. Reconnecting in 5 seconds...");
      setTimeout(() => {
        startBot().catch((err) => logger.error(err, "Reconnect failed"));
      }, 5000);
    }
  });

  // Incoming messages handler
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
  if (msg.key.fromMe) return; // Skip own messages

  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return; // Skip groups and status

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    "";

  if (!text.trim()) return;

  const phone = remoteJid.replace(/@s\.whatsapp\.net$/, "");
  logger.info({ phone, text }, "Processing incoming message");

  const replyText = await getReply(phone, text);

  try {
    await sock.sendMessage(remoteJid, { text: replyText });
  } catch (err) {
    logger.error({ err, remoteJid }, "Failed to send message reply");
  }
}

// Start bot process
startBot().catch((err) => {
  logger.error(err, "Fatal bot initialization error");
  process.exit(1);
});
