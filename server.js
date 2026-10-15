const express = require("express");
const mysql = require("mysql2/promise");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "hotel-reservation-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60
    }
  })
);

app.use(express.static(path.join(__dirname, "public")));

let db;

async function initializeDatabase() {
  db = await mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "hotel_db",
    waitForConnections: true,
    connectionLimit: 10
  });

  console.log("Database connected successfully to hotel_db.");

  // Automatic Default Admin Creation
  const [adminRows] = await db.query("SELECT id FROM admins");
  if (adminRows.length === 0) {
    const defaultHash = await bcrypt.hash("password123", 12);
    await db.query("INSERT INTO admins (username, password_hash) VALUES (?, ?)", ["admin", defaultHash]);
    console.log("Default Admin Account Created: admin / password123");
  }
}

function requireLogin(req, res, next) {
  if (!req.session.adminId) {
    return res.status(401).json({ error: "Please login first." });
  }
  next();
}

function validDateRange(checkIn, checkOut) {
  if (!checkIn || !checkOut) return false;
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  return (
    !Number.isNaN(start.getTime()) &&
    !Number.isNaN(end.getTime()) &&
    end > start
  );
}

// Initial admin account creation
app.post("/api/setup-admin", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || username.trim().length < 3 || !password || password.length < 8) {
      return res.status(400).json({ error: "Username must be at least 3 characters and password at least 8." });
    }
    const [existing] = await db.query("SELECT id FROM admins WHERE username = ?", [username.trim()]);
    if (existing.length) {
      return res.status(409).json({ error: "Admin already exists. Please login." });
    }
    const hash = await bcrypt.hash(password, 12);
    await db.query("INSERT INTO admins (username, password_hash) VALUES (?, ?)", [username.trim(), hash]);
    res.status(201).json({ message: "Admin account created. Please login." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not create admin account." });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Enter username and password." });
    }
    const [rows] = await db.query("SELECT id, username, password_hash FROM admins WHERE username = ?", [username.trim()]);
    if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) {
      return res.status(401).json({ error: "Invalid username or password." });
    }
    req.session.adminId = rows[0].id;
    req.session.username = rows[0].username;
    res.json({ message: "Login successful.", username: rows[0].username });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed." });
  }
});

// Check login status
app.get("/api/session", (req, res) => {
  res.json({
    loggedIn: Boolean(req.session.adminId),
    username: req.session.username || ""
  });
});

// Logout
app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.json({ message: "Logged out successfully." });
  });
});

// Dashboard statistics
app.get("/api/dashboard", requireLogin, async (req, res) => {
  try {
    const [[roomStats]] = await db.query(`
      SELECT COUNT(*) AS totalRooms,
        SUM(status = 'Available') AS availableRooms
      FROM rooms
    `);
    const [[customerStats]] = await db.query("SELECT COUNT(*) AS totalCustomers FROM customers");
    const [[reservationStats]] = await db.query(`
      SELECT COUNT(*) AS totalReservations,
        COALESCE(SUM(total_amount), 0) AS totalRevenue
      FROM reservations
    `);
    res.json({ ...roomStats, ...customerStats, ...reservationStats });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load dashboard." });
  }
});

// Rooms: list and create
app.get("/api/rooms", requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM rooms ORDER BY id DESC");
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Could not load rooms." });
  }
});

app.post("/api/rooms", requireLogin, async (req, res) => {
  try {
    const { room_number, room_type, price, capacity, description } = req.body;
    const [result] = await db.query(
      `INSERT INTO rooms (room_number, room_type, price, capacity, description) VALUES (?, ?, ?, ?, ?)`,
      [room_number.trim(), room_type.trim(), Number(price), Number(capacity || 2), description || ""]
    );
    res.status(201).json({ id: result.insertId, message: "Room added." });
  } catch (error) {
    res.status(500).json({ error: "Could not add room." });
  }
});

// Customers: list and create
app.get("/api/customers", requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM customers ORDER BY id DESC");
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Could not load customers." });
  }
});

app.post("/api/customers", requireLogin, async (req, res) => {
  try {
    const { full_name, email, phone } = req.body;
    const [result] = await db.query(
      "INSERT INTO customers (full_name, email, phone) VALUES (?, ?, ?)",
      [full_name.trim(), email.trim().toLowerCase(), phone || ""]
    );
    res.status(201).json({ id: result.insertId, message: "Customer added." });
  } catch (error) {
    res.status(500).json({ error: "Could not add customer." });
  }
});

// Reservations: list and create
app.get("/api/reservations", requireLogin, async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT r.*, c.full_name, c.email, rm.room_number, rm.room_type
      FROM reservations r
      JOIN customers c ON r.customer_id = c.id
      JOIN rooms rm ON r.room_id = rm.id
      ORDER BY r.id DESC
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: "Could not load reservations." });
  }
});

app.post("/api/reservations", requireLogin, async (req, res) => {
  try {
    const { customer_id, room_id, check_in, check_out, guests } = req.body;
    const [rooms] = await db.query("SELECT * FROM rooms WHERE id = ?", [room_id]);
    if (!rooms.length) return res.status(400).json({ error: "Room not found." });

    const nights = Math.ceil((new Date(check_out) - new Date(check_in)) / 86400000);
    const total = nights > 0 ? nights * Number(rooms[0].price) : Number(rooms[0].price);

    const [result] = await db.query(
      `INSERT INTO reservations (customer_id, room_id, check_in, check_out, guests, total_amount) VALUES (?, ?, ?, ?, ?, ?)`,
      [customer_id, room_id, check_in, check_out, Number(guests || 1), total]
    );
    res.status(201).json({ id: result.insertId, message: "Reservation created." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not create reservation." });
  }
});

// Start server
initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Hotel Reservation System running at: http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Database connection failed:", error.message);
    process.exit(1);
  });