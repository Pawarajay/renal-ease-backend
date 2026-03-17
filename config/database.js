const mysql = require("mysql2/promise")
require("dotenv").config()


// const dbConfig = {
//   host: process.env.DB_HOST || "13.203.39.243",
//   user: process.env.DB_USER || "ajay",
//   password: process.env.DB_PASSWORD || "vt_dev_db@ajay",
//   database: process.env.DB_NAME || "vasifytech_dev",
//   port: process.env.DB_PORT || 3306,
//   waitForConnections: true,
//   connectionLimit: 10,
//   queueLimit: 0,
// }
const dbConfig = {
  host: process.env.DB_HOST || "metro.proxy.rlwy.net",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "vLOoYtJuOWtqInOcEbXZpXGMbyPrXKZm",
  database: process.env.DB_NAME || "renalease_crm_test",
  port: process.env.DB_PORT || 56069,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
}

// root:vLOoYtJuOWtqInOcEbXZpXGMbyPrXKZm@metro.proxy.rlwy.net:56069/railway
const pool = mysql.createPool(dbConfig)

async function testConnection() {
  try {
    const connection = await pool.getConnection()
    console.log(" Database connected successfully")
    connection.release()
  } catch (error) {
    console.error(" Database connection failed:", error.message)
    process.exit(1)
  }
}

module.exports = { pool, testConnection }

