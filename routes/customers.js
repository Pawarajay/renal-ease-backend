const { v4: uuidv4 } = require("uuid");
const express = require("express");
const { body, validationResult, query } = require("express-validator");
const { pool } = require("../config/database");
const { authenticateToken } = require("../middleware/auth");

const router = express.Router();

// =============================================================================
// HELPERS
// =============================================================================

const s = (...params) => params.map((p) => (p === undefined ? null : p));

const validate = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({ error: "Validation failed", details: errors.array() });
    return true;
  }
  return false;
};

const parseTags = (v) => {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v); } catch { return []; }
};

// camelCase → snake_case map for UPDATE builder
const FIELD_MAP = {
  name: "name", email: "email", phone: "phone",
  whatsappNumber: "whatsapp_number", company: "company",
  address: "address", city: "city", state: "state",
  zipCode: "zip_code", country: "country",
  status: "status", source: "source",
  tags: "tags", notes: "notes", totalValue: "total_value",
  // Medical
  service:      "service",
  bloodGroup:   "blood_group",
  dateOfBirth:  "date_of_birth",
  referredBy:   "referred_by",
  // Legacy Vasify pricing (kept for compat)
  serviceType:   "service_type",
  oneTimePrice:  "one_time_price",
  monthlyPrice:  "monthly_price",
  manualPrice:   "manual_price",
  // Invoice defaults
  defaultTaxRate:      "default_tax_rate",
  defaultDueDays:      "default_due_days",
  defaultInvoiceNotes: "default_invoice_notes",
  // Recurring
  recurringEnabled:  "recurring_enabled",
  recurringInterval: "recurring_interval",
  recurringAmount:   "recurring_amount",
  recurringService:  "recurring_service",
  // Renewal
  nextRenewalDate:             "next_renewal_date",
  defaultRenewalStatus:        "default_renewal_status",
  defaultRenewalReminderDays:  "default_renewal_reminder_days",
  defaultRenewalNotes:         "default_renewal_notes",
};

// =============================================================================
// AUTO-INVOICE: create draft RNL-YYYYMM-XXXX when a patient is added
// =============================================================================
const generateRNLNumber = async () => {
  const now    = new Date();
  const prefix = `RNL-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const [rows] = await pool.execute(
    `SELECT invoice_number FROM invoices
     WHERE invoice_number LIKE ? ORDER BY invoice_number DESC LIMIT 1`,
    [`${prefix}-%`]
  );
  const seq = rows.length > 0
    ? parseInt(rows[0].invoice_number.split("-")[2], 10) + 1
    : 1;
  return `${prefix}-${String(seq).padStart(4, "0")}`;
};

const createAutoInvoice = async (customerId, customer) => {
  try {
    const invoiceNumber = await generateRNLNumber();

    // Race-safety check
    const [[dup]] = await pool.execute(
      "SELECT id FROM invoices WHERE invoice_number = ?",
      s(invoiceNumber)
    );
    if (dup) { console.warn(`Dup invoice ${invoiceNumber} — skipping`); return null; }

    const amount  = Number(customer.one_time_price || customer.total_value || 0);
    const taxRate = Number(customer.default_tax_rate || 5);
    const dueDays = Number(customer.default_due_days || 7);
    const total   = +(amount + amount * taxRate / 100).toFixed(2);
    const svc     = customer.service || "Medical Services";
    const id      = uuidv4();

    await pool.execute(
      `INSERT INTO invoices
         (id, customer_id, invoice_number, status, amount, tax, total,
          issue_date, due_date, notes)
       VALUES (?, ?, ?, 'draft', ?, ?, ?,
          CURDATE(), DATE_ADD(CURDATE(), INTERVAL ? DAY), ?)`,
      s(id, customerId, invoiceNumber, amount, taxRate, total, dueDays,
        `Auto-generated invoice — ${svc}`)
    );

    await pool.execute(
      `INSERT INTO invoice_items (id, invoice_id, description, quantity, rate, amount)
       VALUES (?, ?, ?, 1, ?, ?)`,
      s(uuidv4(), id, svc, amount, amount)
    );

    console.log(`✅ Auto-invoice ${invoiceNumber} → customer ${customerId}`);
    return { id, invoiceNumber, amount, total, status: "draft" };
  } catch (err) {
    console.error("Auto-invoice error:", err);
    return null; // never block patient creation
  }
};

// =============================================================================
// GET /customers
// =============================================================================
router.get(
  "/",
  authenticateToken,
  [
    query("page").optional().isInt({ min: 1 }),
    query("limit").optional().isInt({ min: 1, max: 100 }),
    query("search").optional().isString(),
    query("status").optional().isIn(["active", "inactive", "prospect"]),
    query("service").optional().isString(),
    query("assignedTo").optional().isString(),
  ],
  async (req, res) => {
    try {
      if (validate(req, res)) return;

      const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
      const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));
      const offset = (page - 1) * limit;
      const { search, status, service, assignedTo } = req.query;

      let where = "WHERE 1=1";
      const params = [];

      if (req.user.role !== "admin") {
        // Show patients assigned to this user OR unassigned
        where += " AND (c.assigned_to = ? OR c.assigned_to IS NULL)";
        params.push(req.user.id || req.user.userId);
      } else if (assignedTo) {
        where += " AND c.assigned_to = ?";
        params.push(assignedTo);
      }

      if (search) {
        where += " AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?)";
        const q = `%${search}%`;
        params.push(q, q, q);
      }
      if (status)  { where += " AND c.status = ?";  params.push(status); }
      if (service) { where += " AND c.service = ?"; params.push(service); }

      const [customers] = await pool.execute(
        `SELECT c.*, u.name AS assigned_user_name
         FROM customers c LEFT JOIN users u ON c.assigned_to = u.id
         ${where} ORDER BY c.created_at DESC
         LIMIT ${limit} OFFSET ${offset}`,
        s(...params)
      );

      const [[{ total }]] = await pool.execute(
        `SELECT COUNT(*) AS total FROM customers c ${where}`,
        s(...params)
      );

      res.json({
        customers: customers.map((c) => ({ ...c, tags: parseTags(c.tags) })),
        pagination: {
          page, limit, total,
          totalPages: Math.ceil(total / limit) || 1,
          hasNext: page < Math.ceil(total / limit),
          hasPrev: page > 1,
        },
      });
    } catch (err) {
      console.error("Customers GET error:", err);
      res.status(500).json({ error: "Failed to fetch customers" });
    }
  }
);

// =============================================================================
// GET /customers/:id
// =============================================================================
router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      `SELECT c.*, u.name AS assigned_user_name
       FROM customers c LEFT JOIN users u ON c.assigned_to = u.id
       WHERE c.id = ?`,
      s(id)
    );
    if (!rows.length) return res.status(404).json({ error: "Customer not found" });

    const customer = { ...rows[0], tags: parseTags(rows[0].tags) };

    const [invoices] = await pool.execute(
      `SELECT id, invoice_number, amount, tax, total, status, issue_date, due_date
       FROM invoices WHERE customer_id = ?`,
      s(id)
    );

    res.json({ customer, related: { invoices } });
  } catch (err) {
    console.error("Customer GET/:id error:", err);
    res.status(500).json({ error: "Failed to fetch customer" });
  }
});

// =============================================================================
// POST /customers
// =============================================================================
router.post(
  "/",
  authenticateToken,
  [
    body("name").trim().notEmpty().withMessage("Name required"),
    body("email").optional({ checkFalsy: true }).isEmail().withMessage("Invalid email format"),
    body("phone").optional().isString(),
    body("status").optional().isIn(["active", "inactive", "prospect"]),
    body("service").optional().isIn(["dialysis","kidney-transplant","nephrology-consultation","home-care","other"]),
    body("bloodGroup").optional().isString(),
    body("dateOfBirth").optional().isISO8601(),
    body("referredBy").optional().isString(),
    body("totalValue").optional().isNumeric(),
    body("defaultTaxRate").optional().isNumeric(),
    body("defaultDueDays").optional().isInt(),
    body("recurringEnabled").optional().isBoolean(),
    body("recurringInterval").optional().isIn(["weekly","monthly","quarterly","yearly"]),
    body("recurringAmount").optional().isNumeric(),
  ],
  async (req, res) => {
    try {
      if (validate(req, res)) return;

      const {
        name, email, phone, whatsappNumber, company,
        address, city, state, zipCode, country = "India",
        status = "prospect", source,
        tags = [], notes, totalValue = 0,
        service, bloodGroup, dateOfBirth, referredBy,
        // legacy pricing fields
        serviceType, oneTimePrice, monthlyPrice, manualPrice,
        // invoice defaults
        defaultTaxRate, defaultDueDays, defaultInvoiceNotes,
        // recurring
        recurringEnabled = false, recurringInterval = "monthly",
        recurringAmount, recurringService,
        // renewal
        nextRenewalDate, defaultRenewalStatus,
        defaultRenewalReminderDays, defaultRenewalNotes,
        // lead link
        leadId,
      } = req.body;

      const assignedTo = req.user.id || req.user.userId;
      const id = uuidv4();

      // Normalise email — medical patients often have no email
      const safePhone = (phone || "").replace(/\D/g, "");
      const normalizedEmail = (email && email.trim())
        ? email.trim().toLowerCase()
        : `${safePhone || id.slice(0, 8)}@manual.renalease.local`;

      // Duplicate email check (skip synthetic addresses to avoid false conflicts)
      if (!normalizedEmail.endsWith("@manual.renalease.local")) {
        const [[existing]] = await pool.execute(
          "SELECT id FROM customers WHERE email = ?", s(normalizedEmail)
        );
        if (existing) return res.status(400).json({ error: "A patient with this email already exists" });
      }

      await pool.execute(
        `INSERT INTO customers (
          id, name, email, phone, whatsapp_number, company,
          address, city, state, zip_code, country,
          status, source, assigned_to, tags, notes,
          total_value, last_contact_date,
          service, blood_group, date_of_birth, referred_by,
          service_type, one_time_price, monthly_price, manual_price,
          default_tax_rate, default_due_days, default_invoice_notes,
          recurring_enabled, recurring_interval, recurring_amount, recurring_service,
          next_renewal_date, default_renewal_status,
          default_renewal_reminder_days, default_renewal_notes
        ) VALUES (
          ?,?,?,?,?,?,
          ?,?,?,?,?,
          ?,?,?,?,?,
          ?,NULL,
          ?,?,?,?,
          ?,?,?,?,
          ?,?,?,
          ?,?,?,?,
          ?,?,
          ?,?
        )`,
        s(
          id, name, normalizedEmail, phone, whatsappNumber, company,
          address, city, state, zipCode, country,
          status, source, assignedTo, JSON.stringify(tags), notes,
          Number(totalValue) || 0,
          service || null, bloodGroup || null, dateOfBirth || null, referredBy || null,
          serviceType || null,
          oneTimePrice != null ? Number(oneTimePrice) : null,
          monthlyPrice != null ? Number(monthlyPrice) : null,
          manualPrice  != null ? Number(manualPrice)  : null,
          defaultTaxRate || null, defaultDueDays || null, defaultInvoiceNotes || null,
          recurringEnabled ? 1 : 0, recurringInterval,
          recurringAmount || null, recurringService || null,
          nextRenewalDate || null, defaultRenewalStatus || null,
          defaultRenewalReminderDays || null, defaultRenewalNotes || null
        )
      );

      const [[newRow]] = await pool.execute(
        `SELECT c.*, u.name AS assigned_user_name
         FROM customers c LEFT JOIN users u ON c.assigned_to = u.id
         WHERE c.id = ?`,
        s(id)
      );
      const customer = { ...newRow, tags: parseTags(newRow.tags) };

      // Auto-invoice if there's a value
      const autoInvoice = Number(totalValue) > 0
        ? await createAutoInvoice(id, newRow)
        : null;

      // Mark lead as converted
      if (leadId) {
        await pool.execute(
          `UPDATE leads SET status = 'converted', converted_customer_id = ?,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
          s(id, leadId)
        );
      }

      res.status(201).json({
        message: `Patient created${leadId ? ` from lead #${leadId}` : ""}`,
        customer,
        invoice: autoInvoice,
      });
    } catch (err) {
      console.error("Customer POST error:", err);
      res.status(500).json({ error: "Failed to create customer" });
    }
  }
);

// =============================================================================
// PUT /customers/:id
// =============================================================================
router.put(
  "/:id",
  authenticateToken,
  [
    body("name").optional().trim().notEmpty(),
    body("email").optional().isEmail(),
    body("status").optional().isIn(["active", "inactive", "prospect"]),
    body("service").optional().isIn(["dialysis","kidney-transplant","nephrology-consultation","home-care","other"]),
    body("recurringEnabled").optional().isBoolean(),
    body("recurringInterval").optional().isIn(["weekly","monthly","quarterly","yearly"]),
  ],
  async (req, res) => {
    try {
      if (validate(req, res)) return;

      const { id } = req.params;
      const data = { ...req.body };

      const [[existing]] = await pool.execute("SELECT id FROM customers WHERE id = ?", s(id));
      if (!existing) return res.status(404).json({ error: "Customer not found" });

      if (data.email) {
        const [[dup]] = await pool.execute(
          "SELECT id FROM customers WHERE email = ? AND id != ?", s(data.email, id)
        );
        if (dup) return res.status(400).json({ error: "Email already used by another patient" });
      }

      // Type coercions
      if ("totalValue"       in data) data.totalValue       = Number(data.totalValue      || 0);
      if ("recurringEnabled" in data) data.recurringEnabled = data.recurringEnabled ? 1 : 0;
      for (const f of ["oneTimePrice","monthlyPrice","manualPrice"]) {
        if (f in data) data[f] = data[f] != null && data[f] !== "" ? Number(data[f]) : null;
      }

      const setCols = [];
      const vals    = [];
      for (const [k, v] of Object.entries(data)) {
        if (v === undefined) continue;
        const col = FIELD_MAP[k];
        if (!col) continue;
        setCols.push(`${col} = ?`);
        vals.push(k === "tags" ? JSON.stringify(v) : v);
      }

      if (!setCols.length) return res.status(400).json({ error: "No valid fields to update" });

      vals.push(id);
      await pool.execute(
        `UPDATE customers SET ${setCols.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        s(...vals)
      );

      const [[updated]] = await pool.execute(
        `SELECT c.*, u.name AS assigned_user_name
         FROM customers c LEFT JOIN users u ON c.assigned_to = u.id WHERE c.id = ?`,
        s(id)
      );

      res.json({
        message: "Patient updated",
        customer: { ...updated, tags: parseTags(updated.tags) },
      });
    } catch (err) {
      console.error("Customer PUT error:", err);
      res.status(500).json({ error: "Failed to update customer" });
    }
  }
);

// =============================================================================
// DELETE /customers/:id
// =============================================================================
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [[existing]] = await pool.execute("SELECT id FROM customers WHERE id = ?", s(id));
    if (!existing) return res.status(404).json({ error: "Customer not found" });

    const [[{ invoiceCount }]] = await pool.execute(
      "SELECT COUNT(*) AS invoiceCount FROM invoices WHERE customer_id = ?", s(id)
    );
    if (invoiceCount > 0) {
      return res.status(400).json({
        error: "Cannot delete patient with existing invoices",
        details: { invoices: invoiceCount },
      });
    }

    await pool.execute("DELETE FROM customers WHERE id = ?", s(id));
    res.json({ message: "Patient deleted", id });
  } catch (err) {
    console.error("Customer DELETE error:", err);
    res.status(500).json({ error: "Failed to delete customer" });
  }
});

// =============================================================================
// POST /customers/:id/move-to-lead
// =============================================================================
router.post("/:id/move-to-lead", authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [[customer]] = await pool.execute("SELECT * FROM customers WHERE id = ?", s(id));
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const leadId = uuidv4();
    await pool.execute(
      `INSERT INTO leads
         (id, name, email, phone, whatsapp_number, company, source,
          status, priority, service, referred_by,
          assigned_to, estimated_value, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'new', 'medium', ?, ?, ?, ?, ?)`,
      s(
        leadId,
        customer.name, customer.email, customer.phone,
        customer.whatsapp_number, customer.company,
        customer.source || "manual",
        customer.service || null,
        customer.referred_by || null,
        customer.assigned_to,
        customer.total_value || 0,
        (customer.notes || "") + "\n\n[Auto] Restored from patient record."
      )
    );

    await pool.execute(
      "UPDATE customers SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      s(id)
    );

    res.json({ message: "Patient moved back to lead", leadId });
  } catch (err) {
    console.error("Move to lead error:", err);
    res.status(500).json({ error: "Failed to move patient to lead" });
  }
});

module.exports = router;