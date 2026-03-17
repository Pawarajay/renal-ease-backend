// routes/whatsapp-webhook.js
// Updated for Renalease Medical CRM
// Incoming WhatsApp messages auto-create leads with source = "whatsapp"

const express = require("express");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../config/database");

const router = express.Router();

const WHATSAPP_API_URL        = "https://api.aoc-portal.com/v1/whatsapp";
const WHATSAPP_API_TOKEN      = process.env.WHATSAPP_API_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ADMIN_PHONE_NUMBER      = process.env.ADMIN_PHONE_NUMBER || "";

const AXIOS_CONFIG = { headers: { apikey: WHATSAPP_API_TOKEN } };

async function sendWhatsappMessage(to, text) {
  if (!WHATSAPP_API_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.warn("WhatsApp API credentials missing, cannot send message");
    return;
  }
  const data = {
    recipient_type: "individual",
    from: WHATSAPP_PHONE_NUMBER_ID,
    to,
    type: "text",
    text: { body: text },
  };
  try {
    await axios.post(WHATSAPP_API_URL, data, AXIOS_CONFIG);
    console.log(`✅ Message sent to ${to}`);
  } catch (error) {
    console.error(`❌ Failed to send to ${to}:`, error.response?.data || error.message);
  }
}

const sanitizeParams = (...params) =>
  params.map((p) => (p === undefined ? null : p));

router.post("/webhook", async (req, res) => {
  console.log("📩 Incoming WhatsApp webhook:", JSON.stringify(req.body, null, 2));

  // Always reply 200 immediately — WhatsApp requires it
  res.sendStatus(200);

  try {
    const body = req.body;

    if (!body || body.channel !== "whatsapp" || !body.messages || !body.contacts) {
      console.log("Ignoring non-whatsapp or invalid webhook payload");
      return;
    }

    const message     = body.messages;
    const from        = body.contacts.recipient;   // patient's phone number
    const profileName = body.contacts?.profileName || "WhatsApp Patient";

    const userMessage =
      message.type === "text" && message.text?.body
        ? message.text.body.trim()
        : null;

    if (!userMessage) {
      console.log(`Ignoring non-text message from ${from}`);
      return;
    }

    console.log(`--- WhatsApp from ${profileName} (${from}) ---`);
    console.log(`Message: "${userMessage}"`);

    // ── Deduplicate: if a WhatsApp lead from this number exists in last 1 hour, skip ──
    const [recentLead] = await pool.execute(
      `SELECT id FROM leads 
       WHERE phone = ? AND source = 'whatsapp' 
       AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
      sanitizeParams(from)
    );

    if (recentLead.length > 0) {
      console.log(`Duplicate WhatsApp message from ${from} within 1 hour — skipping lead creation`);

      // Still send confirmation to patient
      await sendWhatsappMessage(
        from,
        "Thank you for your message! Our medical team will get back to you shortly. 🏥"
      );
      return;
    }

    // ── Create lead in CRM ────────────────────────────────────────────────────
    const leadId = uuidv4();

    // Use phone@whatsapp.renalease.local as synthetic email
    const syntheticEmail = `${from.replace(/\D/g, "")}@whatsapp.renalease.local`;

    // Attempt to detect service from message keywords
    let detectedService = null;
    const lowerMsg = userMessage.toLowerCase();
    if (lowerMsg.includes("dialysis"))             detectedService = "dialysis";
    else if (lowerMsg.includes("transplant"))      detectedService = "kidney-transplant";
    else if (lowerMsg.includes("consult") || lowerMsg.includes("doctor")) detectedService = "nephrology-consultation";
    else if (lowerMsg.includes("home"))            detectedService = "home-care";

    await pool.execute(
      `
      INSERT INTO leads (
        id,
        name, email, phone, company, source, status, priority,
        assigned_to, converted_customer_id, estimated_value, notes,
        expected_close_date, whatsapp_number, service,
        follow_up_date, follow_up_notes,
        patient_age, patient_gender, referred_by,
        created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
      sanitizeParams(
        leadId,
        profileName,
        syntheticEmail,
        from,
        null,
        "whatsapp",       // source = whatsapp
        "new",
        "high",           // WhatsApp inquiries are high priority for medical
        null,
        null,
        0,
        userMessage,      // patient's message stored as notes
        null,
        from,             // whatsapp_number = same as phone
        detectedService,
        null,             // follow_up_date — to be set by agent
        null,
        null,
        null,
        null,
        null              // created_by = null (auto-created by webhook)
      )
    );

    console.log(`✅ WhatsApp lead created: ${leadId} (${profileName}, service: ${detectedService ?? "unknown"})`);

    // ── Notify admins ─────────────────────────────────────────────────────────
    if (ADMIN_PHONE_NUMBER) {
      const serviceLabel = detectedService
        ? detectedService.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
        : "Not identified";

      const adminNotification =
        `🔔 *New WhatsApp Lead — Renalease*\n\n` +
        `👤 *Patient:* ${profileName}\n` +
        `📞 *Number:* ${from}\n` +
        `🏥 *Service Detected:* ${serviceLabel}\n` +
        `💬 *Message:* ${userMessage}\n\n` +
        `Please follow up promptly.`;

      for (const number of ADMIN_PHONE_NUMBER.split(",")) {
        const trimmed = number.trim();
        if (trimmed) await sendWhatsappMessage(trimmed, adminNotification);
      }
    }

    // ── Confirmation to patient ───────────────────────────────────────────────
    const confirmationMessage =
      `Thank you for contacting *Renalease*! 🏥\n\n` +
      `We have received your message and our medical team will get back to you shortly.\n\n` +
      `For urgent queries, please call us directly. 📞`;

    await sendWhatsappMessage(from, confirmationMessage);

  } catch (error) {
    console.error("❌ Error in WhatsApp webhook handler:", error);
  }
});

module.exports = router;