// services/whatsapp.js
const axios = require("axios");

const WHATSAPP_API_URL = "https://api.aoc-portal.com/v1/whatsapp";
const TOKEN = process.env.WHATSAPP_API_TOKEN;
const FROM_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

const config = {
  headers: { apikey: TOKEN },
};

/**
 * Send plain text message via Aoc
 * @param {string} to - recipient phone (e.g. 919876543210)
 * @param {string} text
 */
async function sendText(to, text) {
  if (!TOKEN || !FROM_NUMBER_ID) {
    console.warn("WhatsApp credentials missing — cannot send");
    return false;
  }

  const payload = {
    recipient_type: "individual",
    from: FROM_NUMBER_ID,
    to,
    type: "text",
    text: { body: text },
  };

  try {
    await axios.post(WHATSAPP_API_URL, payload, config);
    console.log(`[WhatsApp] Text sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`[WhatsApp] Text send failed to ${to}:`, err.response?.data || err.message);
    return false;
  }
}

/**
 * Send approved template message via Aoc
 * Adjust parameters based on your template structure
 * @param {string} to
 * @param {string} templateName - exact name from Aoc dashboard
 * @param {string} languageCode - e.g. "en"
 * @param {Array} parameters - array of strings if template has variables
 */
async function sendTemplate(to, templateName, languageCode = "en", parameters = []) {
  if (!TOKEN || !FROM_NUMBER_ID) return false;

  // Most BSPs use similar structure to Meta — but confirm in Aoc docs
  const payload = {
    recipient_type: "individual",
    from: FROM_NUMBER_ID,
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
    },
  };

  // If your template has variables ({{1}}, {{2}} etc.)
  if (parameters.length > 0) {
    payload.template.components = [
      {
        type: "body",
        parameters: parameters.map(text => ({ type: "text", text })),
      },
    ];
  }

  try {
    await axios.post(WHATSAPP_API_URL, payload, config);
    console.log(`[WhatsApp] Template "${templateName}" sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`[WhatsApp] Template send failed:`, err.response?.data || err.message);
    return false;
  }
}

module.exports = {
  sendText,
  sendTemplate,
};