// koko WhatsApp Web bot — standalone, always-on bridge between a
// WhatsApp "linked device" session and the main site's free auto-reply
// channel (app/api/whatsapp/auto-reply on the Next.js/Supabase app).
//
// WHAT THIS IS: a long-running Node process using Baileys
// (@whiskeysockets/baileys) to speak WhatsApp's multi-device protocol
// directly over a WebSocket — no phone notification-reading involved,
// no Puppeteer/Chromium. Link it once — either by scanning a QR code
// (GET /qr) or, if PAIRING_PHONE_NUMBER is set, by entering an 8-character
// pairing code on the phone instead (GET /pair) — and it then stays
// connected on its own, same as WhatsApp Web/Desktop would.
//
// WHAT THIS IS NOT: this does not replace app/api/whatsapp/auto-reply or
// lib/chatbot/engine.ts on the main site — this process has ZERO business
// logic of its own. Every incoming WhatsApp message is forwarded as-is to
// that endpoint, and whatever plain text comes back is sent as the reply.
// If you ever change reply wording, coin-claim rules, etc., you edit the
// Next.js app, not this file.
//
// DEPLOY AS ITS OWN RENDER WEB SERVICE (not part of the koko-website
// repo/build) — see README.md in this folder for the full walkthrough,
// including why this needs to be a Web Service (not a Background Worker,
// which has no free tier on Render) and the session-persistence caveat
// (free Render web services have no persistent disk, so a redeploy wipes
// ./auth_session and you'll need to re-scan the QR).
//
// Env vars:
//   AUTO_REPLY_ENDPOINT_URL   required. e.g. https://kokofoods.in/api/whatsapp/auto-reply
//   AUTO_REPLY_SHARED_SECRET  must match the value set on the main site
//   QR_ACCESS_KEY             (optional) protects GET /qr and /pair with ?key=...
//   PAIRING_PHONE_NUMBER      (optional) the WhatsApp number to link, digits only
//                             with country code, e.g. 917067546744 — no +, no
//                             spaces. Set this to link by pairing code instead
//                             of QR: open GET /pair to get the code, then on
//                             the phone go to WhatsApp → Linked Devices →
//                             Link a Device → "Link with phone number instead"
//                             and type the code shown. Leave unset to use the
//                             QR flow (GET /qr) as before.
//   PORT                      Render sets this automatically

const express = require("express");
const QRCode = require("qrcode");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const PORT = process.env.PORT || 3000;
const AUTO_REPLY_ENDPOINT_URL = process.env.AUTO_REPLY_ENDPOINT_URL;
const AUTO_REPLY_SHARED_SECRET = process.env.AUTO_REPLY_SHARED_SECRET;
const QR_ACCESS_KEY = process.env.QR_ACCESS_KEY;
const AUTH_DIR = process.env.AUTH_DIR || "./auth_session";
const PAIRING_PHONE_NUMBER = process.env.PAIRING_PHONE_NUMBER
  ? process.env.PAIRING_PHONE_NUMBER.replace(/[^\d]/g, "")
  : null;

if (!AUTO_REPLY_ENDPOINT_URL) {
  console.error("FATAL: AUTO_REPLY_ENDPOINT_URL is not set. Refusing to start.");
  process.exit(1);
}

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// ---- In-memory state shared between the WhatsApp socket and the HTTP server ----
let latestQrString = null; // set whenever WhatsApp issues a fresh QR to scan
let latestPairingCode = null; // set once requestPairingCode() resolves, if using that flow
let connectionStatus = "starting"; // "starting" | "qr_pending" | "pairing_pending" | "connected" | "disconnected"

// ----------------------------------------------------------------------------
// Tiny HTTP server — Render Web Services need something listening on PORT.
// Also doubles as a much nicer way to grab the QR than scraping logs:
// open https://<your-render-url>/qr in a browser.
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
// Calls the main site's stateful chatbot endpoint and returns its reply text.
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
// WhatsApp connection
// ----------------------------------------------------------------------------
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }), // Baileys' own internal logging — separate from ours above
    printQRInTerminal: false, // we serve /qr (or /pair) instead
  });

  // Pairing-code flow: request it once, right after the socket is created,
  // instead of waiting for the automatic QR. Only meaningful the first time
  // (before this device is registered) — on reconnects with a saved session
  // creds.registered is already true, so this is skipped.
  if (PAIRING_PHONE_NUMBER && !sock.authState.creds.registered) {
    try {
      const code = await sock.requestPairingCode(PAIRING_PHONE_NUMBER);
      latestPairingCode = code;
      connectionStatus = "pairing_pending";
      logger.info(`Pairing code issued: ${code} — open /pair on this service's URL, or use it directly.`);
    } catch (err) {
      logger.error(err, "Failed to request pairing code — check PAIRING_PHONE_NUMBER is correct.");
    }
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !PAIRING_PHONE_NUMBER) {
      // Only track/serve the QR when we're actually using the QR flow —
      // if pairing code is configured, WhatsApp still emits a qr event in
      // parallel, but we ignore it so /qr and /pair don't show conflicting
      // states.
      latestQrString = qr;
      connectionStatus = "qr_pending";
      logger.info("New QR issued — open /qr on this service's URL to scan it.");
    }

    if (connection === "open") {
      connectionStatus = "connected";
      latestQrString = null;
      latestPairingCode = null;
      logger.info("WhatsApp linked device connected.");
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        logger.error(
          "Session logged out (unlinked from the phone's WhatsApp app, or too many days offline). " +
            "Delete the auth_session folder and restart this service to re-scan a fresh QR."
        );
        return; // don't auto-reconnect — credentials are no longer valid
      }

      logger.warn({ statusCode }, "Connection closed — reconnecting...");
      startBot().catch((err) => logger.error(err, "Reconnect attempt failed"));
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return; // ignore history-sync batches, only handle live messages

    for (const msg of messages) {
      try {
        await handleIncomingMessage(sock, msg);
      } catch (err) {
        logger.error(err, "Error handling an incoming message");
      }
    }
  });
}

async function handleIncomingMessage(sock, msg) {
  if (msg.key.fromMe) return; // ignore our own sent messages
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid.endsWith("@g.us") || remoteJid === "status@broadcast") return; // skip groups/status

  const text =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    "";

  if (!text.trim()) return; // non-text message (image/sticker/etc. with no caption) — nothing to reply to

  const phone = remoteJid.replace(/@s\.whatsapp\.net$/, "");

  logger.info({ phone, text }, "Incoming message");

  const replyText = await getReply(phone, text);

  await sock.sendMessage(remoteJid, { text: replyText });
}

startBot().catch((err) => {
  logger.error(err, "Fatal error starting bot");
  process.exit(1);
});
