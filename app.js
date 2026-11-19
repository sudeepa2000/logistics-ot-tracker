const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(__dirname));

app.use(session({
  secret: process.env.SESSION_SECRET || 'logistics-ot-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 86400000 }
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        full_name VARCHAR(100),
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'staff'
      );

      CREATE TABLE IF NOT EXISTS job_logs (
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        staff_name VARCHAR(100),
        vehicle_no VARCHAR(50),
        job_desc TEXT NOT NULL,
        ot_reason VARCHAR(100),
        start_time TIMESTAMP NOT NULL,
        end_time TIMESTAMP,
        total_minutes INT DEFAULT 0,
        ot_minutes INT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'In Progress',
        approval VARCHAR(20) DEFAULT 'Pending'
      );
    `);

    const adminPass = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(adminPass, 10);
    await pool.query(
      `INSERT INTO users (username, full_name, password, role) 
       VALUES ($1, $2, $3, 'admin') ON CONFLICT (username) DO NOTHING;`,
      ['admin', 'Logistics Manager', hash]
    );
    console.log("Logistics DB Ready.");
  } catch (err) {
    console.error("DB Init Error:", err);
  }
}
initDB();

// Helper: Calculate OT minutes (Normal Shift: 08:00 AM to 05:00 PM SL Time)
function calculateOT(startUTC, endUTC) {
  let totalMins = Math.floor((endUTC - startUTC) / 60000);
  if (totalMins < 0) totalMins = 0;

  let otMins = 0;
  // Check minute by minute in Sri Lanka Time (+05:30)
  const slOffset = 5.5 * 60 * 60 * 1000;
  let cursor = startUTC.getTime();
  const endMs = endUTC.getTime();

  while (cursor < endMs) {
    const slDate = new Date(cursor + slOffset);
    const hour = slDate.getUTCHours();
    const day = slDate.getUTCDay(); // 0 = Sunday

    // Sunday OR before 8 AM OR 5 PM (17:00) onwards = OT
    if (day === 0 || hour < 8 || hour >= 17) {
      otMins++;
    }
    cursor += 60000;
  }

  return { totalMins, otMins };
}

function checkPageAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/login');
}

function checkApiAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: "Session expired" });
}

// Auth Routes
app.get('/login', (req, res) => res.sendFile(path.resolve(__dirname, 'login.html')));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const q = await pool.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    if (q.rows.length > 0) {
      const ok = await bcrypt.compare(password, q.rows[0].password);
      if (ok) {
        req.session.user = {
          id: q.rows[0].id,
          username: q.rows[0].username,
          full_name: q.rows[0].full_name,
          role: q.rows[0].role
        };
        return res.redirect('/');
      }
    }
    res.redirect('/login?error=1');
  } catch (err) {
    res.status(500).send("Login Error");
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

app.get('/', checkPageAuth, (req, res) => res.sendFile(path.resolve(__dirname, 'index.html')));

// Get Current User Info
app.get('/api/me', checkApiAuth, (req, res) => {
  res.json(req.session.user);
});

// Admin: Create Staff Account
app.post('/api/users', checkApiAuth, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Admin only" });
  const { username, full_name, password, role } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (username, full_name, password, role) VALUES ($1, $2, $3, $4)',
      [username.trim(), full_name, hash, role || 'staff']
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Username already exists or invalid data" });
  }
});

// Get Job Logs
app.get('/api/jobs', checkApiAuth, async (req, res) => {
  try {
    let q;
    if (req.session.user.role === 'admin') {
      q = await pool.query('SELECT * FROM job_logs ORDER BY id DESC');
    } else {
      q = await pool.query('SELECT * FROM job_logs WHERE user_id = $1 ORDER BY id DESC', [req.session.user.id]);
    }
    res.json(q.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start New Job (Server records exact timestamp)
app.post('/api/jobs/start', checkApiAuth, async (req, res) => {
  const { vehicle_no, job_desc, ot_reason } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO job_logs (user_id, staff_name, vehicle_no, job_desc, ot_reason, start_time, status)
       VALUES ($1, $2, $3, $4, $5, NOW(), 'In Progress') RETURNING *`,
      [req.session.user.id, req.session.user.full_name || req.session.user.username, vehicle_no, job_desc, ot_reason]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Complete Job (Server records End Time & calculates OT)
app.put('/api/jobs/:id/complete', checkApiAuth, async (req, res) => {
  try {
    const jobRes = await pool.query('SELECT * FROM job_logs WHERE id = $1', [req.params.id]);
    if (jobRes.rows.length === 0) return res.status(404).json({ error: "Job not found" });

    const job = jobRes.rows[0];
    const startTime = new Date(job.start_time);
    const endTime = new Date();
    const { totalMins, otMins } = calculateOT(startTime, endTime);

    await pool.query(
      `UPDATE job_logs 
       SET end_time = $1, total_minutes = $2, ot_minutes = $3, status = 'Completed' 
       WHERE id = $4`,
      [endTime, totalMins, otMins, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Approve / Reject OT
app.put('/api/jobs/:id/approval', checkApiAuth, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: "Admin only" });
  try {
    await pool.query('UPDATE job_logs SET approval = $1 WHERE id = $2', [req.body.approval, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete Job
app.delete('/api/jobs/:id', checkApiAuth, async (req, res) => {
  try {
    if (req.session.user.role === 'admin') {
      await pool.query('DELETE FROM job_logs WHERE id = $1', [req.params.id]);
    } else {
      await pool.query("DELETE FROM job_logs WHERE id = $1 AND user_id = $2 AND approval = 'Pending'", [req.params.id, req.session.user.id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log('Logistics OT Server running on ' + PORT));
