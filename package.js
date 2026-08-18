{
  "name": "whatsapp-chatbot",
  "version": "1.0.0",
  "private": true,
  "description": "Standalone WhatsApp Web (linked-device) bot for the koko free auto-reply channel. Runs as its own Render Web Service, separate from the Next.js site — bridges an always-on WhatsApp Web session to app/api/whatsapp/auto-reply on the main site.",
  "type": "commonjs",
  "main": "index.js",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.9",
    "express": "^4.19.2",
    "pino": "^9.3.2",
    "qrcode": "^1.5.4"
  }
}
