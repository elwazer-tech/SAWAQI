const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let systemMaxSpeed = 90;

function calculateDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// الاتصال بالسحابة الدائمة Neon إذا وجد الرابط، أو SQLite محلياً
const isPostgres = !!process.env.DATABASE_URL;
let pgPool = null;
let sqliteDb = null;

if (isPostgres) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log('Connected to Permanent Neon PostgreSQL Database.');
} else {
  sqliteDb = new sqlite3.Database('./database.sqlite');
  console.log('Connected to Local SQLite Database.');
}

function dbQuery(text, params = []) {
  if (isPostgres) {
    let pIdx = 1;
    const pgText = text.replace(/\?/g, () => `$${pIdx++}`);
    return pgPool.query(pgText, params);
  } else {
    return new Promise((resolve, reject) => {
      const isSelect = text.trim().toUpperCase().startsWith('SELECT');
      if (isSelect) {
        sqliteDb.all(text, params, (err, rows) => err ? reject(err) : resolve({ rows }));
      } else {
        sqliteDb.run(text, params, function(err) {
          err ? reject(err) : resolve({ rowCount: this.changes, lastID: this.lastID });
        });
      }
    });
  }
}

async function initDatabase() {
  try {
    if (isPostgres) {
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          username VARCHAR(255) UNIQUE NOT NULL,
          pin_code VARCHAR(100) NOT NULL,
          role VARCHAR(50) NOT NULL,
          plate_number VARCHAR(100),
          phone VARCHAR(50),
          daily_base_hours NUMERIC DEFAULT 8,
          is_active INTEGER DEFAULT 1
        );
      `);

      await dbQuery(`
        CREATE TABLE IF NOT EXISTS shifts (
          id SERIAL PRIMARY KEY,
          driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          shift_date VARCHAR(50) NOT NULL,
          start_time TIMESTAMPTZ NOT NULL,
          end_time TIMESTAMPTZ,
          is_first_shift INTEGER DEFAULT 1,
          duration_minutes INTEGER DEFAULT 0,
          base_minutes INTEGER DEFAULT 0,
          overtime_minutes INTEGER DEFAULT 0,
          distance_km NUMERIC DEFAULT 0,
          applied_daily_base_hours NUMERIC NOT NULL,
          status VARCHAR(50) DEFAULT 'active'
        );
      `);

      // تثبيت حساب الأدمن فقط
      await dbQuery(`
        INSERT INTO users (username, pin_code, role, plate_number, phone, daily_base_hours, is_active)
        VALUES ('admin', '1234', 'owner', 'إدارة', '0500000000', 8, 1)
        ON CONFLICT (username) DO NOTHING;
      `);
    } else {
      sqliteDb.serialize(() => {
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          pin_code TEXT NOT NULL,
          role TEXT NOT NULL,
          plate_number TEXT,
          phone TEXT,
          daily_base_hours REAL DEFAULT 8,
          is_active INTEGER DEFAULT 1
        )`);
        sqliteDb.run(`ALTER TABLE users ADD COLUMN plate_number TEXT`, () => {});
        sqliteDb.run(`UPDATE users SET username = 'admin', pin_code = '1234' WHERE id = 1 OR username = 'owner'`, () => {});

        sqliteDb.run(`CREATE TABLE IF NOT EXISTS shifts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          driver_id INTEGER NOT NULL,
          shift_date TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT,
          is_first_shift INTEGER DEFAULT 1,
          duration_minutes INTEGER DEFAULT 0,
          base_minutes INTEGER DEFAULT 0,
          overtime_minutes INTEGER DEFAULT 0,
          distance_km REAL DEFAULT 0,
          applied_daily_base_hours REAL NOT NULL,
          status TEXT DEFAULT 'active'
        )`);
        sqliteDb.run(`ALTER TABLE shifts ADD COLUMN distance_km REAL DEFAULT 0`, () => {});

        sqliteDb.run(`INSERT OR IGNORE INTO users (id, username, pin_code, role, plate_number, phone, daily_base_hours, is_active)
                      VALUES (1, 'admin', '1234', 'owner', 'إدارة', '0500000000', 8, 1)`);
      });
    }
    console.log('Database initialized successfully with permanent storage.');
  } catch (err) {
    console.error('Database Init Error:', err);
  }
}

initDatabase();

const liveLocations = {};
const lastClosedShiftDetails = {};

app.get('/api/settings/speed-limit', (req, res) => {
  res.json({ maxSpeed: systemMaxSpeed });
});

app.post('/api/settings/speed-limit', (req, res) => {
  const { maxSpeed } = req.body;
  if (maxSpeed && Number(maxSpeed) > 0) {
    systemMaxSpeed = Number(maxSpeed);
    io.emit('speed_limit_changed', { maxSpeed: systemMaxSpeed });
    return res.json({ success: true, maxSpeed: systemMaxSpeed });
  }
  res.status(400).json({ error: 'قيمة سرعة غير صالحة' });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const pin_code = String(req.body.pin_code || '').trim();

  try {
    const query = `
      SELECT * FROM users 
      WHERE (username = ? OR (username = 'owner' AND ? = 'admin')) 
        AND pin_code = ? 
        AND is_active = 1
    `;
    const result = await dbQuery(query, [username, username, pin_code]);
    const user = result.rows[0];

    if (!user) return res.status(401).json({ error: 'كلمة المرور غير صحيحة أو الحساب معطل' });
    if (user.role === 'owner') user.username = 'admin';

    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/drivers', async (req, res) => {
  try {
    const result = await dbQuery(`SELECT id, username, plate_number, phone, daily_base_hours, is_active FROM users WHERE role = 'driver' ORDER BY id ASC`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/drivers', async (req, res) => {
  const { username, plate_number, pin_code, phone, daily_base_hours } = req.body;
  const user = String(username || '').trim();
  if (!user) return res.status(400).json({ error: 'اسم السائق مطلوب' });

  try {
    await dbQuery(`
      INSERT INTO users (username, pin_code, role, plate_number, phone, daily_base_hours, is_active) 
      VALUES (?, ?, 'driver', ?, ?, ?, 1)
    `, [user, pin_code || '1111', plate_number || '', phone || '', daily_base_hours || 8]);

    io.emit('drivers_list_updated');
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'اسم السائق مسجل بالفعل' });
  }
});

app.put('/api/drivers/:id', async (req, res) => {
  const { id } = req.params;
  const { username, plate_number, pin_code, phone, daily_base_hours } = req.body;
  const user = String(username || '').trim();

  try {
    let query = `UPDATE users SET username=?, plate_number=?, phone=?, daily_base_hours=?`;
    let params = [user, plate_number || '', phone || '', daily_base_hours || 8];

    if (pin_code && pin_code.trim()) {
      query += `, pin_code=?`;
      params.push(pin_code.trim());
    }
    query += ` WHERE id = ?`;
    params.push(id);

    await dbQuery(query, params);
    io.emit('drivers_list_updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/drivers/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await dbQuery(`DELETE FROM users WHERE id = ? AND role = 'driver'`, [id]);
    io.emit('drivers_list_updated');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shifts/active/:driverId', async (req, res) => {
  const { driverId } = req.params;
  try {
    const result = await dbQuery(`SELECT * FROM shifts WHERE driver_id = ? AND status = 'active'`, [driverId]);
    res.json({ activeShift: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shifts/start', async (req, res) => {
  const { driverId } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  try {
    const existing = await dbQuery(`SELECT id FROM shifts WHERE driver_id = ? AND status = 'active'`, [driverId]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'يوجد شيفت نشط بالفعل لهذا السائق' });

    const countRow = await dbQuery(`SELECT COUNT(*) as count FROM shifts WHERE driver_id = ? AND shift_date = ?`, [driverId, today]);
    const isFirst = (Number(countRow.rows[0].count) === 0) ? 1 : 0;

    const driverRes = await dbQuery(`SELECT daily_base_hours, username, plate_number FROM users WHERE id = ?`, [driverId]);
    const driver = driverRes.rows[0] || { daily_base_hours: 8, username: 'driver' };
    const baseHours = driver.daily_base_hours || 8;

    await dbQuery(`
      INSERT INTO shifts (driver_id, shift_date, start_time, is_first_shift, applied_daily_base_hours, distance_km, status)
      VALUES (?, ?, ?, ?, ?, 0, 'active')
    `, [driverId, today, now, isFirst, baseHours]);

    if (liveLocations[driverId]) {
      liveLocations[driverId].distanceKm = 0;
      liveLocations[driverId].trail = [];
    }

    io.emit('shift_started', {
      driverId,
      username: driver.username,
      plateNumber: driver.plate_number || '',
      startTime: now
    });

    res.json({ success: true, startTime: now, isFirst: !!isFirst });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/shifts/end', async (req, res) => {
  const { driverId } = req.body;
  const now = new Date();
  const nowIso = now.toISOString();

  try {
    const shiftRes = await dbQuery(`SELECT * FROM shifts WHERE driver_id = ? AND status = 'active'`, [driverId]);
    const shift = shiftRes.rows[0];
    if (!shift) return res.status(400).json({ error: 'لا يوجد شيفت نشط لإنهائه' });

    const startTime = new Date(shift.start_time);
    const durationMinutes = Math.max(1, Math.round((now - startTime) / (1000 * 60)));
    const totalDistance = liveLocations[driverId] ? (liveLocations[driverId].distanceKm || 0) : (Number(shift.distance_km) || 0);

    lastClosedShiftDetails[driverId] = {
      closedAt: nowIso,
      durationMinutes,
      distanceKm: totalDistance,
      battery: liveLocations[driverId] ? liveLocations[driverId].battery : null,
      wasStopped: !liveLocations[driverId] || liveLocations[driverId].speed === 0
    };

    const aggRes = await dbQuery(`
      SELECT SUM(base_minutes) as totalBaseSoFar FROM shifts 
      WHERE driver_id = ? AND shift_date = ? AND status = 'completed'
    `, [driverId, shift.shift_date]);

    const previousBaseMinutes = Number(aggRes.rows[0]?.totalbasesofar || aggRes.rows[0]?.totalBaseSoFar || 0);
    const maxDailyBaseMinutes = Number(shift.applied_daily_base_hours) * 60;
    const remainingBaseMinutes = Math.max(0, maxDailyBaseMinutes - previousBaseMinutes);

    const shiftBaseMinutes = Math.min(durationMinutes, remainingBaseMinutes);
    const shiftOvertimeMinutes = durationMinutes - shiftBaseMinutes;

    await dbQuery(`
      UPDATE shifts SET end_time = ?, duration_minutes = ?, base_minutes = ?, overtime_minutes = ?, distance_km = ?, status = 'completed'
      WHERE id = ?
    `, [nowIso, durationMinutes, shiftBaseMinutes, shiftOvertimeMinutes, totalDistance, shift.id]);

    delete liveLocations[driverId];

    io.emit('driver_stopped', { driverId });
    io.emit('shift_ended', {
      driverId,
      durationMinutes,
      baseMinutes: shiftBaseMinutes,
      overtimeMinutes: shiftOvertimeMinutes,
      distanceKm: totalDistance,
      closedAt: nowIso
    });

    res.json({
      success: true,
      durationMinutes,
      baseMinutes: shiftBaseMinutes,
      overtimeMinutes: shiftOvertimeMinutes,
      distanceKm: totalDistance
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shifts/history/:driverId', async (req, res) => {
  const { driverId } = req.params;
  try {
    const result = await dbQuery(`SELECT * FROM shifts WHERE driver_id = ? ORDER BY start_time DESC LIMIT 100`, [driverId]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports', async (req, res) => {
  const { driverId, month } = req.query;
  if (!driverId || !month) return res.status(400).json({ error: 'driverId and month are required' });

  try {
    const shiftsRes = await dbQuery(`
      SELECT * FROM shifts 
      WHERE driver_id = ? AND shift_date LIKE ? 
      ORDER BY start_time ASC
    `, [driverId, `${month}%`]);

    const driverRes = await dbQuery(`SELECT * FROM users WHERE id = ?`, [driverId]);
    const driver = driverRes.rows[0];
    if (!driver) return res.status(404).json({ error: 'السائق غير موجود' });

    const now = new Date();
    const baseLimitDailyMinutes = Number(driver.daily_base_hours || 8) * 60;

    let totalBaseMinutes = 0;
    let totalOvertimeMinutes = 0;
    let totalMonthDistanceKm = 0;
    const daysMap = {};

    shiftsRes.rows.forEach(s => {
      let duration = Number(s.duration_minutes || 0);
      let baseMins = Number(s.base_minutes || 0);
      let overtimeMins = Number(s.overtime_minutes || 0);
      let shiftDist = Number(s.distance_km || 0);

      if (s.status === 'active') {
        const start = new Date(s.start_time);
        duration = Math.max(1, Math.round((now - start) / 60000));
        const completedBaseToday = daysMap[s.shift_date] ? daysMap[s.shift_date].baseMinutes : 0;
        const remainingBaseToday = Math.max(0, baseLimitDailyMinutes - completedBaseToday);
        baseMins = Math.min(duration, remainingBaseToday);
        overtimeMins = duration - baseMins;

        if (liveLocations[driverId]) {
          shiftDist = Number(liveLocations[driverId].distanceKm || 0);
        }
      }

      totalBaseMinutes += baseMins;
      totalOvertimeMinutes += overtimeMins;
      totalMonthDistanceKm += shiftDist;

      if (!daysMap[s.shift_date]) {
        daysMap[s.shift_date] = {
          date: s.shift_date,
          shiftsCount: 0,
          baseMinutes: 0,
          overtimeMinutes: 0,
          totalMinutes: 0,
          totalDistanceKm: 0,
          shifts: []
        };
      }

      daysMap[s.shift_date].shiftsCount += 1;
      daysMap[s.shift_date].baseMinutes += baseMins;
      daysMap[s.shift_date].overtimeMinutes += overtimeMins;
      daysMap[s.shift_date].totalMinutes += duration;
      daysMap[s.shift_date].totalDistanceKm += shiftDist;
      daysMap[s.shift_date].shifts.push({
        start_time: s.start_time,
        end_time: s.end_time || null,
        duration_minutes: duration,
        base_minutes: baseMins,
        overtime_minutes: overtimeMins,
        distance_km: shiftDist,
        status: s.status
      });
    });

    res.json({
      driver,
      workingDaysCount: Object.keys(daysMap).length,
      totalBaseMinutes,
      totalOvertimeMinutes,
      totalMinutes: totalBaseMinutes + totalOvertimeMinutes,
      totalDistanceKm: Number(totalMonthDistanceKm.toFixed(1)),
      dailyBreakdown: Object.values(daysMap)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/active-drivers', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const query = `
      SELECT 
        u.id as driver_id, 
        u.username, 
        u.plate_number, 
        u.phone, 
        u.daily_base_hours,
        s.id as shift_id, 
        s.start_time, 
        s.end_time,
        s.shift_date,
        s.status as shift_status,
        s.duration_minutes,
        s.distance_km,
        COALESCE((
          SELECT SUM(base_minutes) 
          FROM shifts 
          WHERE driver_id = u.id AND shift_date = ? AND status = 'completed'
        ), 0) as completed_base_minutes_today
      FROM users u
      LEFT JOIN shifts s ON s.id = (
        SELECT id FROM shifts WHERE driver_id = u.id ORDER BY id DESC LIMIT 1
      )
      WHERE u.role = 'driver'
    `;

    const result = await dbQuery(query, [today]);
    const drivers = result.rows.map(r => ({
      ...r,
      location: liveLocations[r.driver_id] || null,
      lastClosed: lastClosedShiftDetails[r.driver_id] || null
    }));
    res.json(drivers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

io.on('connection', (socket) => {
  socket.emit('initial_locations', liveLocations);
  socket.emit('speed_limit_changed', { maxSpeed: systemMaxSpeed });

  socket.on('update_location', async (data) => {
    const { driverId, username, plateNumber, lat, lng, speed, battery } = data;
    if (driverId && lat && lng) {
      const rawSpeed = Math.round(speed || 0);
      const currentSpeed = rawSpeed >= 4 ? rawSpeed : 0;
      const isOverSpeed = currentSpeed > systemMaxSpeed;

      if (!liveLocations[driverId]) {
        liveLocations[driverId] = {
          driverId,
          username: username || '',
          plateNumber: plateNumber || '',
          lat,
          lng,
          speed: currentSpeed,
          battery: battery !== undefined ? battery : null,
          distanceKm: 0,
          trail: [[lat, lng]],
          isOverSpeed,
          updatedAt: new Date().toISOString()
        };
      } else {
        const prev = liveLocations[driverId];
        const dist = calculateDistanceKm(prev.lat, prev.lng, lat, lng);

        if (dist >= 0.025 && dist <= 3.0 && currentSpeed >= 4) {
          prev.distanceKm = Number(((prev.distanceKm || 0) + dist).toFixed(2));
          try {
            await dbQuery(`UPDATE shifts SET distance_km = ? WHERE driver_id = ? AND status = 'active'`, [prev.distanceKm, driverId]);
          } catch(e) {}
        }

        prev.lat = lat;
        prev.lng = lng;
        prev.speed = currentSpeed;
        prev.isOverSpeed = isOverSpeed;
        if (battery !== undefined) prev.battery = battery;
        prev.updatedAt = new Date().toISOString();

        if (currentSpeed >= 4) {
          if (!prev.trail) prev.trail = [];
          prev.trail.push([lat, lng]);
          if (prev.trail.length > 120) prev.trail.shift();
        }
      }

      io.emit('driver_location_changed', liveLocations[driverId]);

      if (isOverSpeed) {
        io.emit('speed_violation_alert', {
          driverId,
          username: username || liveLocations[driverId].username,
          plateNumber: plateNumber || liveLocations[driverId].plateNumber,
          speed: currentSpeed,
          maxSpeed: systemMaxSpeed
        });
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port: ${PORT}`);
});
