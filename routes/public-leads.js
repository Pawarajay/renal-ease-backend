// const express = require("express");
// const { body, validationResult } = require("express-validator");
// const { pool } = require("../config/database");
// const { v4: uuidv4 } = require("uuid");
// const { sendTemplate, sendText } = require("../services/whatsapp"); // ← new helper

// const router = express.Router();

// // Helper: convert undefined → null for MySQL
// const sanitizeParams = (...params) => params.map(p => (p === undefined ? null : p));

// // Validation errors handler
// const handleValidation = (req, res) => {
//   const errors = validationResult(req);
//   if (!errors.isEmpty()) {
//     res.status(400).json({ error: "Validation failed", details: errors.array() });
//     return true;
//   }
//   return false;
// };

// // ─── PUBLIC WEBSITE BOOKING ENDPOINT ───────────────────────────────────────────
// router.post(
//   "/website-booking",
//   [
//     body("name").trim().notEmpty().withMessage("Name is required"),
//     body("phone").notEmpty().withMessage("Phone is required"),
//     body("service").optional().isString(),
//     body("notes").optional().isString(),
//   ],
//   async (req, res) => {
//     if (handleValidation(req, res)) return;

//     try {
//       const { name, phone, service, notes = "" } = req.body;

//       // Clean phone → 919876543210 format
//       const cleanPhone = phone.replace(/\D/g, "");
//       if (cleanPhone.length < 10 || cleanPhone.length > 15) {
//         return res.status(400).json({ error: "Invalid phone number format" });
//       }

//       // Duplicate check (last 24h)
//       const [recent] = await pool.execute(
//         `SELECT id FROM leads 
//          WHERE phone = ? AND source = 'website' 
//          AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
//         [cleanPhone]
//       );

//       if (recent.length > 0) {
//         return res.status(409).json({
//           error: "Duplicate booking",
//           message: "A request from this number was received recently.",
//         });
//       }

//       const syntheticEmail = `${cleanPhone}@website.renalease.local`;

//       const leadId = uuidv4();

//       await pool.execute(
//         `
//         INSERT INTO leads (
//           id, name, email, phone, source, status, priority,
//           service, notes, whatsapp_number,
//           created_at, updated_at
//         ) VALUES (?, ?, ?, ?, 'website', 'new', 'high', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
//         `,
//         sanitizeParams(
//           leadId,
//           name.trim(),
//           syntheticEmail,
//           cleanPhone,
//           service || null,
//           notes.trim() || null,
//           cleanPhone
//         )
//       );

//       // ─── Send WhatsApp Confirmation ────────────────────────────────────────
//       const templateName = process.env.WHATSAPP_WEBSITE_CONFIRMATION_TEMPLATE;

//       let sent = false;

//       if (templateName) {
//         // Prefer template if you have one approved
//         // Adjust parameters if your template has {{1}} = name, {{2}} = service
//         sent = await sendTemplate(
//           cleanPhone,
//           templateName,
//           "en", // change to "hi" if Hindi template
//           [name.trim().split(" ")[0] || "Customer", service || "our service"] // example — match your template variables
//         );
//       }

//       // Fallback to plain text if no template or send failed
//       if (!sent) {
//         const fallbackMsg = 
//           `Dear ${name},\n\n` +
//           `We have received your booking request for ${service || "a service"}.\n` +
//           `Our RenalEase team will contact you shortly. Thank you! 🏥`;

//         await sendText(cleanPhone, fallbackMsg);
//       }

//       res.status(201).json({
//         message: "Booking received successfully. Our team will contact you shortly.",
//         leadId,
//       });
//     } catch (err) {
//       console.error("Website booking error:", err);
//       res.status(500).json({ error: "Failed to process booking" });
//     }
//   }
// );

// module.exports = router;


//testing
const express = require("express");
const { body, validationResult } = require("express-validator");
const { pool } = require("../config/database");
const { v4: uuidv4 } = require("uuid");
const { sendTemplate, sendText } = require("../services/whatsapp");

const router = express.Router();

// Helper: convert undefined → null for MySQL
const sanitizeParams = (...params) => params.map(p => (p === undefined ? null : p));

// Validation errors handler
const handleValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: "Validation failed", details: errors.array() });
    return true;
  }
  return false;
};

// ─── PUBLIC WEBSITE BOOKING ENDPOINT ───────────────────────────────────────────
router.post(
  "/website-booking",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("phone").notEmpty().withMessage("Phone is required"),
    body("service").optional().isString(),
    body("notes").optional().isString(),
  ],
  async (req, res) => {
    if (handleValidation(req, res)) return;

    try {
      const { name, phone, service, notes = "" } = req.body;

      // ── Clean & normalize phone number (very important for Aoc / WhatsApp) ──
      let cleanPhone = phone.replace(/\D/g, ""); // remove all non-digits

      // Force Indian country code if missing (most common case)
      if (cleanPhone.length === 10) {
        cleanPhone = "91" + cleanPhone;
      } else if (cleanPhone.startsWith("0") && cleanPhone.length === 11) {
        cleanPhone = "91" + cleanPhone.substring(1);
      }

      // Final validation
      if (cleanPhone.length < 12 || cleanPhone.length > 13 || !cleanPhone.startsWith("91")) {
        return res.status(400).json({
          error: "Invalid phone number format",
          message: "Please provide a valid Indian mobile number (10 digits or with +91)",
        });
      }

      console.log(`Normalized phone for WhatsApp: ${cleanPhone}`);

      // Prevent duplicates in last 24h
      const [recent] = await pool.execute(
        `SELECT id FROM leads 
         WHERE phone = ? AND source = 'website' 
         AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
        [cleanPhone]
      );

      if (recent.length > 0) {
        return res.status(409).json({
          error: "Duplicate booking",
          message: "A request from this number was received recently.",
        });
      }

      const syntheticEmail = `${cleanPhone}@website.renalease.local`;

      const leadId = uuidv4();

      await pool.execute(
        `
        INSERT INTO leads (
          id, name, email, phone, source, status, priority,
          service, notes, whatsapp_number,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'website', 'new', 'high', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
        sanitizeParams(
          leadId,
          name.trim(),
          syntheticEmail,
          cleanPhone,
          service || null,
          notes.trim() || null,
          cleanPhone
        )
      );

      console.log(`Lead created successfully: ${leadId} for ${name} (${cleanPhone})`);

      // ─── Send WhatsApp Confirmation ────────────────────────────────────────
      console.log(`Attempting WhatsApp send to: ${cleanPhone}`);

      const templateName = process.env.WHATSAPP_WEBSITE_CONFIRMATION_TEMPLATE?.trim();

      let sent = false;

      if (templateName && templateName.length > 0) {
        try {
          sent = await sendTemplate(
            cleanPhone,
            templateName,
            process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en",
            // Adjust parameters according to your template variables
            // Example: if template has {{1}} = name, {{2}} = service
            [name.trim().split(" ")[0] || "Customer", service || "our services"]
          );
        } catch (templateErr) {
          console.error("Template sending failed:", templateErr);
        }
      }

      // Fallback to plain text if template not sent or not configured
      if (!sent) {
        const fallbackMsg = 
          `Dear ${name.trim()},\n\n` +
          `We have received your booking request${service ? ` for ${service}` : ""}.\n` +
          `Our RenalEase team will contact you shortly. Thank you!\n\n` +
          `RenalEase - Kidney Care Solutions 🏥`;

        try {
          sent = await sendText(cleanPhone, fallbackMsg);
        } catch (textErr) {
          console.error("Plain text fallback failed:", textErr);
        }
      }

      if (sent) {
        console.log(`WhatsApp message sent successfully to ${cleanPhone}`);
      } else {
        console.warn(`WhatsApp delivery failed for ${cleanPhone} — check Aoc logs / opt-in status`);
      }

      // ── Success response to frontend ───────────────────────────────────────
      res.status(201).json({
        message: "Booking received successfully. Our team will contact you shortly.",
        leadId,
      });
    } catch (err) {
      console.error("Website booking error:", err);
      res.status(500).json({ error: "Failed to process booking" });
    }
  }
);

module.exports = router;