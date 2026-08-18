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
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3000;
const AUTO_REPLY_ENDPOINT_URL = process.env.AUTO_REPLY_ENDPOINT_URL;
const AUTO_REPLY_SHARED_SECRET = process.env.AUTO_REPLY_SHARED_SECRET;
const QR_ACCESS_KEY = process.env.QR_ACCESS_KEY;
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER
  ? process.env.PAIRING_PHONE_NUMBER.replace(/[^\d]/g, "")
  : null;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!AUTO_REPLY_ENDPOINT_URL) {
  console.error("FATAL: AUTO_REPLY_ENDPOINT_URL is not set. Refusing to start.");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("FATAL: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for session storage.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ---- Shared in-memory state ----
let latestQrString = null;
let latestPairingCode = null;
let connectionStatus = "starting";

// ----------------------------------------------------------------------------
// Supabase-backed Auth State for Baileys (Survives Render Restarts/Wipes)
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
      logger.error({ err, type, id }, "Error reading auth data from Supabase");
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
      logger.error({ err, type, id }, "Error writing auth data to Supabase");
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
// Tiny HTTP server
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
    return res.send("<h2>No QR yet — still starting up, refresh in a few seconds.</h2>");
  }
  const dataUrl = await QRCode.toDataURL(latestQrString);
  res.send(
    `<html><body style="text-align:center;font-family:sans-serif">
       <h2>Scan with WhatsApp → Linked Devices → Link a Device</h2>
       <img src="${dataUrl}" width="300" height="300" />
       <p>This page auto-refreshes every 5s until scanned.</p>
       <script>setTimeout(()=>location.reload(), 5000)</script>
     </body></html>`
  );
});

app.get("/pair", (req, res) => {
  if (QR_ACCESS_KEY && req.query.key !== QR_ACCESS_KEY) {
    return res.status(401).send("Unauthorized");
  }
  if (!PAIRING_PHONE_NUMBER) {
    return res
      .status(400)
      .send("PAIRING_PHONE_NUMBER is not set — this service is using the QR flow instead. See /qr.");
  }
  if (connectionStatus === "connected") {
    return res.send("<h2>Already linked and connected. Nothing to pair.</h2>");
  }
  if (!latestPairingCode) {
    return res.send("<h2>No pairing code yet — still starting up, refresh in a few seconds.</h2>");
  }
  res.send(
    `<html><body style="text-align:center;font-family:sans-serif">
       <h2>On your phone: WhatsApp → Linked Devices → Link a Device →<br/>"Link with phone number instead"</h2>
       <p>Enter this code:</p>
       <div style="font-size:2.5em;letter-spacing:0.15em;font-weight:bold">${latestPairingCode}</div>
       <p>This page auto-refreshes every 5s until linked.</p>
       <script>setTimeout(()=>location.reload(), 5000)</script>
     </body></html>`
  );
});

app.listen(PORT, () => {
  logger.info(
    `HTTP server listening on ${PORT} (${PAIRING_PHONE_NUMBER ? "pairing code at /pair" : "QR at /qr"}, health at /health)`
  );
});

// ----------------------------------------------------------------------------
// API Reply Handler
// ----------------------------------------------------------------------------
async function getReply(phone, message) {
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
    logger.error({ status: response.status }, "auto-reply endpoint returned non-OK");
    return "Sorry, something went wrong. Please try again in a moment.";
  }

  return await response.text();
}

// ----------------------------------------------------------------------------
// WhatsApp Bot Connection
// ----------------------------------------------------------------------------
async function startBot() {
  const { state, saveCreds, clearAuth } = await useSupabaseAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
  });

  if (PAIRING_PHONE_NUMBER && !sock.authState.creds.registered) {
    try {
      const code = await sock.requestPairingCode(PAIRING_PHONE_NUMBER);
      latestPairingCode = code;
      connectionStatus = "pairing_pending";
      logger.info(`Pairing code issued: ${code}`);
    } catch (err) {
      logger.error(err, "Failed to request pairing code — check PAIRING_PHONE_NUMBER");
    }
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !PAIRING_PHONE_NUMBER) {
      latestQrString = qr;
      connectionStatus = "qr_pending";
      logger.info("New QR issued — open /qr to scan.");
    }

    if (connection === "open") {
      connectionStatus = "connected";
      latestQrString = null;
      latestPairingCode = null;
      logger.info("WhatsApp linked device connected successfully.");
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        logger.error("Session logged out from WhatsApp. Clearing auth session from database...");
        await clearAuth();
        return;
      }

      logger.warn({ statusCode }, "Connection closed. Reconnecting in 5 seconds...");
      setTimeout(() => {
        startBot().catch((err) => logger.error(err, "Reconnect attempt failed"));
      }, 5000);
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      try {
        await handleIncomingMessage(sock, msg);
      } catch (err) {
        logger.error(err, "Error handling incoming message");
      }
    }
  });
}

async function handleIncomingMessage(sock, msg) {
  if (msg.key.fromMe) return;
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return;

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    "";

  if (!text.trim()) return;

  const phone = remoteJid.replace(/@s\.whatsapp\.net$/, "");
  logger.info({ phone, text }, "Incoming message");

  const replyText = await getReply(phone, text);

  try {
    await sock.sendMessage(remoteJid, { text: replyText });
  } catch (err) {
    logger.error({ err, remoteJid }, "Failed to send WhatsApp message");
  }
}

startBot().catch((err) => {
  logger.error(err, "Fatal error starting bot");
  process.exit(1);
});
