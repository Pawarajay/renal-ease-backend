const express = require("express");
const { body, validationResult, query } = require("express-validator");
const { pool } = require("../config/database");
const { authenticateToken } = require("../middleware/auth");
const { v4: uuidv4 } = require("uuid");

const router = express.Router();

// ─── MEDICAL CRM CONFIG ────────────────────────────────────────────────────────
// Updated statuses, sources, and services for Renalease medical client

const LEAD_STATUSES = [
  "new",
  "qualified",
  "quotation-sent",
  "converted",
  "closed-lost",
];

const LEAD_SOURCES = [
  "website",
  "booking-engine",
  "whatsapp",
  "manual",
  "referral",
  "other",
];

const MEDICAL_SERVICES = [
  "dialysis",
  "kidney-transplant",
  "nephrology-consultation",
  "home-care",
  "other",
];
// ──────────────────────────────────────────────────────────────────────────────

// Helper: convert undefined to null for MySQL compatibility
const sanitizeParams = (...params) =>
  params.map((param) => (param === undefined ? null : param));

// Validation helper
const handleValidation = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      error: "Validation failed",
      details: errors.array(),
    });
    return true;
  }
  return false;
};

// Map from request body keys to DB column names
const leadFieldMap = {
  name: "name",
  email: "email",
  phone: "phone",
  company: "company",
  source: "source",
  status: "status",
  priority: "priority",
  assignedTo: "assigned_to",
  estimatedValue: "estimated_value",
  notes: "notes",
  expectedCloseDate: "expected_close_date",
  whatsappNumber: "whatsapp_number",
  service: "service",
  followUpDate: "follow_up_date",
  referredBy: "referred_by",
};

// Helper: check that current user is allowed to access this lead
const ensureCanAccessLead = async (req, res, leadId) => {
  if (req.user.role === "admin") return { ok: true };

  const [rows] = await pool.execute(
    "SELECT id, assigned_to FROM leads WHERE id = ?",
    sanitizeParams(leadId)
  );

  if (rows.length === 0) {
    return {
      ok: false,
      response: res.status(404).json({ error: "Lead not found" }),
    };
  }

  const lead = rows[0];

  if (lead.assigned_to === req.user.id || lead.assigned_to == null) {
    return { ok: true };
  }

  return {
    ok: false,
    response: res
      .status(403)
      .json({ error: "You do not have permission to access this lead" }),
  };
};

// ─── PUBLIC BOOKING ENGINE ENDPOINT ───────────────────────────────────────────
// Called by the Renalease website booking engine — no auth required.
// Auto-creates a lead with source = "booking-engine".
router.post(
  "/public/booking",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("phone").notEmpty().withMessage("Phone is required"),
    body("email").optional().isEmail().withMessage("Valid email is required"),
    body("service")
      .optional()
      .isIn(MEDICAL_SERVICES)
      .withMessage("Invalid service"),
    body("appointmentDate")
      .optional()
      .isISO8601()
      .withMessage("Appointment date must be a valid date"),
    body("notes").optional().isString(),
    body("estimatedValue").optional().isNumeric(),
    body("patientAge").optional().isNumeric(),
    body("patientGender")
      .optional()
      .isIn(["male", "female", "other"])
      .withMessage("Invalid gender"),
    body("referredBy").optional().isString(),
  ],
  async (req, res) => {
    try {
      if (handleValidation(req, res)) return;

      const {
        name,
        phone,
        email,
        service,
        appointmentDate,
        notes,
        estimatedValue,
        patientAge,
        patientGender,
        referredBy,
      } = req.body;

      // Use a synthetic email if none provided (booking engine may not collect it)
      const safeEmail = email
        ? email.trim().toLowerCase()
        : `${phone.replace(/\D/g, "")}@booking.renalease.local`;

      // Check for duplicate phone booking within last 24 hours to prevent double-submissions
      const [recentBooking] = await pool.execute(
        `SELECT id FROM leads 
         WHERE phone = ? AND source = 'booking-engine' 
         AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
        sanitizeParams(phone)
      );

      if (recentBooking.length > 0) {
        return res.status(409).json({
          error: "Duplicate booking",
          message:
            "A booking from this phone number was already received in the last 24 hours.",
          existingLeadId: recentBooking[0].id,
        });
      }

      let safeExpectedCloseDate = null;
      if (appointmentDate) {
        const d = new Date(appointmentDate);
        if (!Number.isNaN(d.getTime())) {
          safeExpectedCloseDate = d.toISOString().slice(0, 10);
        }
      }

      const leadId = uuidv4();

      await pool.execute(
        `
        INSERT INTO leads (
          id,
          name, email, phone, company, source, status, priority,
          assigned_to, converted_customer_id, estimated_value, notes,
          expected_close_date, whatsapp_number, service,
          follow_up_date, referred_by,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
        sanitizeParams(
          leadId,
          name.trim(),
          safeEmail,
          phone,
          null,            // company
          "booking-engine",
          "new",
          "high",
          null,            // assigned_to
          null,            // converted_customer_id
          estimatedValue ? Number(estimatedValue) : 0,
          notes ?? null,
          safeExpectedCloseDate,
          phone,           // whatsapp_number defaults to phone
          service ?? null,
          null,            // follow_up_date
          referredBy ?? null,
          null             // created_by = null for public endpoint
        )
      );

      // Send WhatsApp confirmation to patient (integration hook)
      // In production, trigger your WhatsApp API here using `phone`
      console.log(
        `[Booking Engine] New lead created: ${name} (${phone}) for service: ${service}`
      );

      res.status(201).json({
        message: "Booking received successfully. Our team will contact you shortly.",
        leadId,
        appointmentDate: safeExpectedCloseDate,
      });
    } catch (error) {
      console.error("Booking engine lead creation error:", error);
      res.status(500).json({ error: "Failed to process booking" });
    }
  }
);

// ─── GET ALL LEADS ─────────────────────────────────────────────────────────────
router.get(
  "/",
  authenticateToken,
  [
    query("page")
      .optional()
      .isInt({ min: 1 })
      .withMessage("Page must be a positive integer"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
    query("search").optional().isString(),
    query("status")
      .optional()
      .isIn(LEAD_STATUSES)
      .withMessage("Invalid status"),
    query("priority")
      .optional()
      .isIn(["low", "medium", "high"])
      .withMessage("Invalid priority"),
    query("source")
      .optional()
      .isIn(LEAD_SOURCES)
      .withMessage("Invalid source"),
    query("service")
      .optional()
      .isIn(MEDICAL_SERVICES)
      .withMessage("Invalid service"),
    query("assignedTo").optional().isString(),
    query("createdBy").optional().isString(),
    query("followUpDue")
      .optional()
      .isIn(["today", "overdue", "upcoming"])
      .withMessage("Invalid followUpDue filter"),
  ],
  async (req, res) => {
    try {
      if (handleValidation(req, res)) return;

      const pageRaw = Number.parseInt(req.query.page, 10);
      const limitRaw = Number.parseInt(req.query.limit, 10);

      const page = !Number.isNaN(pageRaw) && pageRaw > 0 ? pageRaw : 1;
      const limit =
        !Number.isNaN(limitRaw) && limitRaw > 0 && limitRaw <= 100
          ? limitRaw
          : 10;
      const offset = (page - 1) * limit;

      const {
        search,
        status,
        priority,
        source,
        assignedTo,
        service,
        createdBy,
        followUpDue,
      } = req.query;

      let whereClause = "WHERE 1=1";
      const queryParams = [];

      if (req.user.role !== "admin") {
        whereClause += " AND l.assigned_to = ?";
        queryParams.push(req.user.id);
      }

      if (search) {
        whereClause +=
          " AND (l.name LIKE ? OR l.email LIKE ? OR l.phone LIKE ? OR l.referred_by LIKE ?)";
        const s = `%${search}%`;
        queryParams.push(s, s, s, s);
      }

      if (status) {
        whereClause += " AND l.status = ?";
        queryParams.push(status);
      }

      if (priority) {
        whereClause += " AND l.priority = ?";
        queryParams.push(priority);
      }

      if (source) {
        whereClause += " AND l.source = ?";
        queryParams.push(source);
      }

      if (service) {
        whereClause += " AND l.service = ?";
        queryParams.push(service);
      }

      if (assignedTo && req.user.role === "admin") {
        whereClause += " AND l.assigned_to = ?";
        queryParams.push(assignedTo);
      }

      if (createdBy && req.user.role === "admin") {
        whereClause += " AND l.created_by = ?";
        queryParams.push(createdBy);
      }

      // Follow-up due filter
      if (followUpDue === "today") {
        whereClause += " AND DATE(l.follow_up_date) = CURDATE()";
      } else if (followUpDue === "overdue") {
        whereClause += " AND l.follow_up_date < CURDATE() AND l.status NOT IN ('converted', 'closed-lost')";
      } else if (followUpDue === "upcoming") {
        whereClause +=
          " AND l.follow_up_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)";
      }

      const leadsSql = `
        SELECT 
          l.*,
          u.name  AS assigned_user_name,
          cu.name AS created_user_name
        FROM leads l
        LEFT JOIN users u  ON l.assigned_to = u.id
        LEFT JOIN users cu ON l.created_by = cu.id
        ${whereClause}
        ORDER BY 
          CASE WHEN l.follow_up_date IS NOT NULL AND DATE(l.follow_up_date) <= CURDATE() 
               THEN 0 ELSE 1 END,
          l.created_at DESC
        LIMIT ${Number(limit)} OFFSET ${Number(offset)}
      `;

      const [leads] = await pool.execute(
        leadsSql,
        sanitizeParams(...queryParams)
      );

      const countSql = `SELECT COUNT(*) AS total FROM leads l ${whereClause}`;
      const [countResult] = await pool.execute(
        countSql,
        sanitizeParams(...queryParams)
      );

      const total = countResult[0]?.total || 0;
      const totalPages = total > 0 ? Math.ceil(total / limit) : 1;

      res.json({
        leads,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      });
    } catch (error) {
      console.error("Leads fetch error:", error);
      res.status(500).json({ error: "Failed to fetch leads" });
    }
  }
);

// ─── LEAD STATS (Dashboard cards) ─────────────────────────────────────────────
router.get("/stats", authenticateToken, async (req, res) => {
  try {
    const params = [];
    let whereClause = "WHERE 1=1";

    if (req.user.role !== "admin") {
      whereClause += " AND assigned_to = ?";
      params.push(req.user.id);
    }

    const [rows] = await pool.execute(
      `
      SELECT
        COUNT(*) AS totalLeads,
        SUM(CASE WHEN status = 'new'            THEN 1 ELSE 0 END) AS newLeads,
        SUM(CASE WHEN status = 'qualified'       THEN 1 ELSE 0 END) AS qualifiedLeads,
        SUM(CASE WHEN status = 'quotation-sent'  THEN 1 ELSE 0 END) AS quotationSentLeads,
        SUM(CASE WHEN status = 'converted'       THEN 1 ELSE 0 END) AS convertedLeads,
        SUM(CASE WHEN status = 'closed-lost'     THEN 1 ELSE 0 END) AS closedLostLeads,
        SUM(CASE WHEN source  = 'booking-engine' THEN 1 ELSE 0 END) AS bookingEngineLeads,
        SUM(CASE WHEN source  = 'whatsapp'       THEN 1 ELSE 0 END) AS whatsappLeads,
        SUM(CASE WHEN source  = 'website'        THEN 1 ELSE 0 END) AS websiteLeads,
        SUM(CASE WHEN source  = 'manual'         THEN 1 ELSE 0 END) AS manualLeads,
        SUM(CASE WHEN follow_up_date IS NOT NULL 
                  AND DATE(follow_up_date) <= CURDATE() 
                  AND status NOT IN ('converted','closed-lost')
             THEN 1 ELSE 0 END) AS pendingFollowUps,
        SUM(
          CASE WHEN status = 'converted'
               THEN COALESCE(estimated_value, 0)
               ELSE 0
          END
        ) AS convertedValue
      FROM leads
      ${whereClause}
      `,
      sanitizeParams(...params)
    );

    // Source-wise breakdown for charts
    const [sourceBreakdown] = await pool.execute(
      `SELECT source, COUNT(*) AS count FROM leads ${whereClause} GROUP BY source`,
      sanitizeParams(...params)
    );

    // Service-wise breakdown
    const [serviceBreakdown] = await pool.execute(
      `SELECT service, COUNT(*) AS count FROM leads ${whereClause} AND service IS NOT NULL GROUP BY service`,
      sanitizeParams(...params)
    );

    // Daily leads (last 7 days)
    const [dailyLeads] = await pool.execute(
      `SELECT DATE(created_at) AS date, COUNT(*) AS count 
       FROM leads 
       ${whereClause} AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
       GROUP BY DATE(created_at) ORDER BY date`,
      sanitizeParams(...params)
    );

    const stats = rows[0] || {};

    res.json({
      stats,
      sourceBreakdown,
      serviceBreakdown,
      dailyLeads,
    });
  } catch (error) {
    console.error("Lead stats error:", error);
    res.status(500).json({ error: "Failed to fetch lead stats" });
  }
});

// ─── GET LEAD BY ID ────────────────────────────────────────────────────────────
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const access = await ensureCanAccessLead(req, res, id);
    if (!access.ok) return;

    const [leads] = await pool.execute(
      `
      SELECT 
        l.*,
        u.name  AS assigned_user_name,
        cu.name AS created_user_name
      FROM leads l
      LEFT JOIN users u  ON l.assigned_to = u.id
      LEFT JOIN users cu ON l.created_by = cu.id
      WHERE l.id = ?
      `,
      sanitizeParams(id)
    );

    if (leads.length === 0) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const lead = leads[0];

    // tasks table not in Renalease schema — graceful fallback
    const tasks = await pool.execute(
      'SELECT id, title, type, status, due_date FROM tasks WHERE related_type = "lead" AND related_id = ?',
      sanitizeParams(id)
    ).then(([rows]) => rows).catch(() => []);

    // Follow-up history for this lead
    const [followUpHistory] = await pool.execute(
      `SELECT * FROM lead_follow_ups WHERE lead_id = ? ORDER BY created_at DESC LIMIT 10`,
      sanitizeParams(id)
    ).catch(() => [[]]);  // Graceful fallback if table doesn't exist yet

    res.json({
      lead,
      related: {
        tasks,
        followUpHistory,
      },
    });
  } catch (error) {
    console.error("Lead fetch error:", error);
    res.status(500).json({ error: "Failed to fetch lead" });
  }
});

// ─── CREATE LEAD (Manual / Internal) ──────────────────────────────────────────
router.post(
  "/",
  authenticateToken,
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("phone").notEmpty().withMessage("Phone is required"),
    body("email").optional().isEmail().withMessage("Valid email is required"),
    body("company").optional().isString(),
    body("source")
      .optional()
      .isIn(LEAD_SOURCES)
      .withMessage("Invalid source"),
    body("status")
      .optional()
      .isIn(LEAD_STATUSES)
      .withMessage("Invalid status"),
    body("priority")
      .optional()
      .isIn(["low", "medium", "high"])
      .withMessage("Invalid priority"),
    body("assignedTo").optional().isString(),
    body("estimatedValue").optional().isNumeric(),
    body("notes").optional().isString(),
    body("expectedCloseDate").optional().isISO8601(),
    body("whatsappNumber").optional().isString(),
    body("service")
      .optional()
      .isIn(MEDICAL_SERVICES)
      .withMessage("Invalid service"),
    body("followUpDate").optional().isISO8601().withMessage("Invalid follow-up date"),
    body("followUpNotes").optional().isString(),
    body("patientAge").optional().isNumeric(),
    body("patientGender").optional().isIn(["male", "female", "other"]),
    body("referredBy").optional().isString(),
  ],
  async (req, res) => {
    try {
      if (handleValidation(req, res)) return;

      if (!req.user || !req.user.id) {
        return res.status(401).json({ error: "Unauthenticated: user not found in token" });
      }

      const {
        name,
        email,
        phone,
        company,
        source,
        status,
        priority,
        assignedTo: rawAssignedTo,
        estimatedValue,
        notes,
        expectedCloseDate,
        whatsappNumber,
        service,
        followUpDate,
        followUpNotes,
        patientAge,
        patientGender,
        referredBy,
      } = req.body;

      // Use phone-based synthetic email if not provided (medical patients often skip email)
      const normalizedEmail = email
        ? email.trim().toLowerCase()
        : `${phone.replace(/\D/g, "")}@manual.renalease.local`;

      // Duplicate phone check (more relevant for medical than email)
      const [existingByPhone] = await pool.execute(
        "SELECT id, name, status FROM leads WHERE phone = ?",
        sanitizeParams(phone)
      );

      if (existingByPhone.length > 0) {
        const duplicate = existingByPhone[0];
        return res.status(409).json({
          error: "Lead already exists",
          message: `A lead with phone ${phone} already exists in the system.`,
          existingLead: {
            id: duplicate.id,
            name: duplicate.name,
            status: duplicate.status,
          },
        });
      }

      const safeSource    = source    ?? "manual";
      const safeStatus    = status    ?? "new";
      const safePriority  = priority  ?? "medium";
      const safeEstimatedValue = estimatedValue == null ? 0 : Number(estimatedValue);

      let safeExpectedCloseDate = null;
      if (expectedCloseDate) {
        const d = new Date(expectedCloseDate);
        if (!Number.isNaN(d.getTime())) safeExpectedCloseDate = d.toISOString().slice(0, 10);
      }

      let safeFollowUpDate = null;
      if (followUpDate) {
        const d = new Date(followUpDate);
        if (!Number.isNaN(d.getTime())) safeFollowUpDate = d.toISOString().slice(0, 10);
      }

      let assignedTo = rawAssignedTo ?? null;
      if (req.user.role !== "admin") {
        assignedTo = req.user.id;
      } else if (!assignedTo || assignedTo === "" || assignedTo === "0") {
        assignedTo = null;
      }

      if (assignedTo != null) {
        const [userRows] = await pool.execute(
          "SELECT id FROM users WHERE id = ?",
          sanitizeParams(assignedTo)
        );
        if (userRows.length === 0) {
          return res.status(400).json({ error: "Invalid assigned user" });
        }
      }

      const leadId    = uuidv4();
      const createdBy = req.user.id;

      await pool.execute(
        `
        INSERT INTO leads (
          id,
          name, email, phone, company, source, status, priority,
          assigned_to, converted_customer_id, estimated_value, notes,
          expected_close_date, whatsapp_number, service,
          follow_up_date, referred_by,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
        sanitizeParams(
          leadId,
          name.trim(),
          normalizedEmail,
          phone,
          company ?? null,
          safeSource,
          safeStatus,
          safePriority,
          assignedTo,
          null,
          safeEstimatedValue,
          notes ?? null,
          safeExpectedCloseDate,
          whatsappNumber ?? phone,
          service ?? null,
          safeFollowUpDate,
          referredBy ?? null,
          createdBy
        )
      );

      const [leads] = await pool.execute(
        `
        SELECT l.*, u.name AS assigned_user_name, cu.name AS created_user_name
        FROM leads l
        LEFT JOIN users u  ON l.assigned_to = u.id
        LEFT JOIN users cu ON l.created_by  = cu.id
        WHERE l.id = ?
        `,
        sanitizeParams(leadId)
      );

      res.status(201).json({
        message: "Lead created successfully",
        lead: leads[0],
      });
    } catch (error) {
      console.error("Lead creation error:", error);
      res.status(500).json({ error: "Failed to create lead" });
    }
  }
);

// ─── UPDATE LEAD ───────────────────────────────────────────────────────────────
router.put(
  "/:id",
  authenticateToken,
  [
    body("name").optional().trim().notEmpty(),
    body("email").optional().isEmail(),
    body("phone").optional().isString(),
    body("company").optional().isString(),
    body("source").optional().isIn(LEAD_SOURCES),
    body("status").optional().isIn(LEAD_STATUSES),
    body("priority").optional().isIn(["low", "medium", "high"]),
    body("assignedTo").optional().isString(),
    body("estimatedValue").optional().isNumeric(),
    body("notes").optional().isString(),
    body("expectedCloseDate").optional().isISO8601(),
    body("whatsappNumber").optional().isString(),
    body("service").optional().isIn(MEDICAL_SERVICES),
    body("followUpDate").optional().isISO8601(),
    body("followUpNotes").optional().isString(),
    body("patientAge").optional().isNumeric(),
    body("patientGender").optional().isIn(["male", "female", "other"]),
    body("referredBy").optional().isString(),
  ],
  async (req, res) => {
    try {
      if (handleValidation(req, res)) return;

      const { id } = req.params;
      const updateData = { ...req.body };

      const access = await ensureCanAccessLead(req, res, id);
      if (!access.ok) return;

      // Phone duplicate check on update
      if (updateData.phone !== undefined) {
        const [phoneConflict] = await pool.execute(
          "SELECT id FROM leads WHERE phone = ? AND id != ?",
          sanitizeParams(updateData.phone, id)
        );
        if (phoneConflict.length > 0) {
          return res.status(409).json({
            error: "Lead already exists",
            message: `A lead with phone ${updateData.phone} already exists.`,
            existingLeadId: phoneConflict[0].id,
          });
        }
      }

      if (updateData.email !== undefined) {
        updateData.email = updateData.email.trim().toLowerCase();
      }

      if (Object.prototype.hasOwnProperty.call(updateData, "assignedTo")) {
        if (req.user.role !== "admin") {
          delete updateData.assignedTo;
        } else {
          let assignedTo = updateData.assignedTo ?? null;
          if (!assignedTo || assignedTo === "" || assignedTo === "0") {
            assignedTo = null;
          }
          if (assignedTo != null) {
            const [userRows] = await pool.execute(
              "SELECT id FROM users WHERE id = ?",
              sanitizeParams(assignedTo)
            );
            if (userRows.length === 0) {
              return res.status(400).json({ error: "Invalid assigned user" });
            }
          }
          updateData.assignedTo = assignedTo;
        }
      }

      const [existingLeads] = await pool.execute(
        "SELECT id FROM leads WHERE id = ?",
        sanitizeParams(id)
      );

      if (existingLeads.length === 0) {
        return res.status(404).json({ error: "Lead not found" });
      }

      const updateFields = [];
      const updateValues = [];

      Object.entries(updateData).forEach(([key, value]) => {
        if (value === undefined) return;
        const dbField = leadFieldMap[key];
        if (!dbField) return;
        updateFields.push(`${dbField} = ?`);
        updateValues.push(value);
      });

      if (updateFields.length === 0) {
        return res.status(400).json({ error: "No fields to update" });
      }

      updateValues.push(id);

      await pool.execute(
        `UPDATE leads SET ${updateFields.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        sanitizeParams(...updateValues)
      );

      const [leads] = await pool.execute(
        `
        SELECT l.*, u.name AS assigned_user_name, cu.name AS created_user_name
        FROM leads l
        LEFT JOIN users u  ON l.assigned_to = u.id
        LEFT JOIN users cu ON l.created_by  = cu.id
        WHERE l.id = ?
        `,
        sanitizeParams(id)
      );

      res.json({
        message: "Lead updated successfully",
        lead: leads[0],
      });
    } catch (error) {
      console.error("Lead update error:", error);
      res.status(500).json({ error: "Failed to update lead" });
    }
  }
);

// ─── UPDATE FOLLOW-UP ──────────────────────────────────────────────────────────
// Dedicated endpoint for setting/updating follow-up date and notes
router.put(
  "/:id/follow-up",
  authenticateToken,
  [
    body("followUpDate")
      .notEmpty()
      .isISO8601()
      .withMessage("Valid follow-up date is required"),
    body("followUpNotes").optional().isString(),
  ],
  async (req, res) => {
    try {
      if (handleValidation(req, res)) return;

      const { id } = req.params;
      const { followUpDate, followUpNotes } = req.body;

      const access = await ensureCanAccessLead(req, res, id);
      if (!access.ok) return;

      const d = new Date(followUpDate);
      if (Number.isNaN(d.getTime())) {
        return res.status(400).json({ error: "Invalid follow-up date" });
      }
      const safeDate = d.toISOString().slice(0, 10);

      await pool.execute(
        `UPDATE leads 
         SET follow_up_date = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        sanitizeParams(safeDate, id)
      );

      // Log to follow-up history table (if it exists)
      try {
        await pool.execute(
          `INSERT INTO lead_follow_ups (lead_id, follow_up_date, notes, created_by, created_at)
           VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          sanitizeParams(id, safeDate, followUpNotes ?? null, req.user.id)
        );
      } catch (_) {
        // Table may not exist yet — non-fatal
      }

      res.json({
        message: "Follow-up scheduled successfully",
        followUpDate: safeDate,
        followUpNotes: followUpNotes ?? null,
      });
    } catch (error) {
      console.error("Follow-up update error:", error);
      res.status(500).json({ error: "Failed to update follow-up" });
    }
  }
);

// ─── CONVERT LEAD TO CUSTOMER ──────────────────────────────────────────────────
router.post(
  "/:id/convert",
  authenticateToken,
  [body("customerData").optional().isObject()],
  async (req, res) => {
    try {
      if (handleValidation(req, res)) return;

      const { id } = req.params;
      const { customerData = {} } = req.body;

      const access = await ensureCanAccessLead(req, res, id);
      if (!access.ok) return;

      const [leads] = await pool.execute(
        "SELECT * FROM leads WHERE id = ?",
        sanitizeParams(id)
      );

      if (leads.length === 0) {
        return res.status(404).json({ error: "Lead not found" });
      }

      const lead = leads[0];

      // Medical CRM: allow conversion from "quotation-sent" or "qualified" statuses too
      const convertibleStatuses = ["quotation-sent", "qualified", "converted"];
      if (!convertibleStatuses.includes(lead.status)) {
        return res.status(400).json({
          error: `Lead must be in 'Qualified', 'Quotation Sent' status to convert. Current status: ${lead.status}`,
        });
      }

      // Check if already converted
      const [existingCustomerByPhone] = await pool.execute(
        "SELECT * FROM customers WHERE phone = ?",
        sanitizeParams(lead.phone)
      );

      if (existingCustomerByPhone.length > 0) {
        const existingCustomer = existingCustomerByPhone[0];

        await pool.execute(
          "UPDATE leads SET status = 'converted', converted_customer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          sanitizeParams(existingCustomer.id, id)
        );

        try {
          if (typeof existingCustomer.tags === "string") {
            existingCustomer.tags = JSON.parse(existingCustomer.tags);
          } else if (!existingCustomer.tags) {
            existingCustomer.tags = [];
          }
        } catch {
          existingCustomer.tags = [];
        }

        return res.json({
          message: "Lead linked to existing customer successfully",
          customer: existingCustomer,
        });
      }

      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        let assignedTo = customerData.assignedTo ?? lead.assigned_to ?? null;
        if (!assignedTo || assignedTo === "" || assignedTo === "0") assignedTo = null;

        if (assignedTo != null) {
          const [userRows] = await connection.execute(
            "SELECT id FROM users WHERE id = ?",
            sanitizeParams(assignedTo)
          );
          if (userRows.length === 0) assignedTo = null;
        }

        const customerId = uuidv4();

        let tagsArray = [];
        if (Array.isArray(customerData.tags)) {
          tagsArray = customerData.tags;
        } else if (typeof customerData.tags === "string" && customerData.tags.trim() !== "") {
          tagsArray = [customerData.tags.trim()];
        }

        // Add medical service as a tag for easy filtering
        if (lead.service && !tagsArray.includes(lead.service)) {
          tagsArray.push(lead.service);
        }

        await connection.execute(
          `
          INSERT INTO customers (
            id, name, email, phone, company, address, status, source,
            assigned_to, tags, notes, total_value, whatsapp_number, service,
            blood_group, date_of_birth, referred_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          sanitizeParams(
            customerId,
            customerData.name        || lead.name,
            lead.email,
            customerData.phone       || lead.phone,
            customerData.company     || lead.company,
            customerData.address     || null,
            "active",
            lead.source,
            assignedTo,
            JSON.stringify(tagsArray),
            customerData.notes       || lead.notes,
            customerData.totalValue  || lead.estimated_value,
            customerData.whatsappNumber || lead.whatsapp_number,
            customerData.service     || lead.service,
            customerData.bloodGroup  || null,
            customerData.dateOfBirth || null,
            customerData.referredBy  || lead.referred_by || null
          )
        );

        await connection.execute(
          "UPDATE leads SET status = 'converted', converted_customer_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          sanitizeParams(customerId, id)
        );

        // tasks table does not exist in Renalease schema — skip silently
        try {
          await connection.execute(
            'UPDATE tasks SET related_type = "customer", related_id = ? WHERE related_type = "lead" AND related_id = ?',
            sanitizeParams(customerId, id)
          );
        } catch (_) { /* non-fatal — tasks table not in Renalease */ }

        await connection.commit();

        const [customers] = await pool.execute(
          `
          SELECT c.*, u.name AS assigned_user_name
          FROM customers c
          LEFT JOIN users u ON c.assigned_to = u.id
          WHERE c.id = ?
          `,
          sanitizeParams(customerId)
        );

        const customer = customers[0];

        try {
          if (customer.tags && typeof customer.tags === "string") {
            customer.tags = JSON.parse(customer.tags);
          } else if (!customer.tags) {
            customer.tags = [];
          }
        } catch {
          customer.tags = [];
        }

        res.json({
          message: "Lead converted to customer successfully",
          customer,
        });
      } catch (err) {
        await connection.rollback();
        throw err;
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error("Lead conversion error:", error);
      res.status(500).json({ error: "Failed to convert lead to customer" });
    }
  }
);

// ─── DELETE LEAD ───────────────────────────────────────────────────────────────
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const access = await ensureCanAccessLead(req, res, id);
    if (!access.ok) return;

    const [existingLeads] = await pool.execute(
      "SELECT id FROM leads WHERE id = ?",
      sanitizeParams(id)
    );

    if (existingLeads.length === 0) {
      return res.status(404).json({ error: "Lead not found" });
    }

    await pool.execute("DELETE FROM leads WHERE id = ?", sanitizeParams(id));

    res.json({ message: "Lead deleted successfully" });
  } catch (error) {
    console.error("Lead deletion error:", error);
    res.status(500).json({ error: "Failed to delete lead" });
  }
});

module.exports = router;