const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) console.error('Database error:', err);
  else console.log('Connected to SQLite Database.');
});

let systemMaxSpeed = 90;

// حساب المسافة الدقيقة بين نقطتين بالكيلومتر عبر Haversine
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

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pin_code TEXT NOT NULL,
    role TEXT NOT NULL,
    plate_number TEXT,
    phone TEXT,
    daily_base_hours REAL DEFAULT 8,
    is_active INTEGER DEFAULT 1
  )`);

  db.run(`ALTER TABLE users ADD COLUMN plate_number TEXT`, () => {});
  db.run(`UPDATE users SET username = 'admin', pin_code = '1234' WHERE id = 1 OR username = 'owner' OR role = 'owner'`, () => {});

  db.run(`CREATE TABLE IF NOT EXISTS shifts (
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
    status TEXT DEFAULT 'active',
    FOREIGN KEY(driver_id) REFERENCES users(id)
  )`);

  db.run(`ALTER TABLE shifts ADD COLUMN distance_km REAL DEFAULT 0`, () => {});

  const seedUsers = [
    { id: 1, username: 'admin', pin: '1234', role: 'owner', plate: 'إدارة', phone: '0500000000', base: 8 },
    { id: 2, username: 'driver1', pin: '1111', role: 'driver', plate: 'أ ب ج 123', phone: '0501111111', base: 8 },
    { id: 3, username: 'driver2', pin: '2222', role: 'driver', plate: 'د هـ و 102', phone: '0502222222', base: 8 },
    { id: 4, username: 'driver3', pin: '3333', role: 'driver', plate: 'س ص ع 103', phone: '0503333333', base: 8 }
  ];

  seedUsers.forEach(u => {
    db.run(`INSERT OR IGNORE INTO users (id, username, pin_code, role, plate_number, phone, daily_base_hours, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      [u.id, u.username, u.pin, u.role, u.plate, u.phone, u.base]);
  });
});

const liveLocations = {};
const lastClosedShiftDetails = {};

// جلب وتعديل السرعة القصوى المحددة من الأدمن
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

// تسجيل الدخول
app.post('/api/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const pin_code = String(req.body.pin_code || '').trim();

  const query = `
    SELECT * FROM users 
    WHERE (username = ? OR (username = 'owner' AND ? = 'admin')) 
      AND pin_code = ? 
      AND is_active = 1
  `;

  db.get(query, [username, username, pin_code], (err, user) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!user) return res.status(401).json({ error: 'كلمة المرور غير صحيحة أو الحساب معطل' });

    if (user.role === 'owner') user.username = 'admin';
    res.json({ user });
  });
});

// قائمة السائقين
app.get('/api/drivers', (req, res) => {
  db.all(`SELECT id, username, plate_number, phone, daily_base_hours, is_active FROM users WHERE role = 'driver'`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// إضافة سائق
app.post('/api/drivers', (req, res) => {
  const { username, plate_number, pin_code, phone, daily_base_hours } = req.body;
  const user = String(username || '').trim();
  if (!user) return res.status(400).json({ error: 'اسم السائق مطلوب' });

  db.run(`INSERT INTO users (username, pin_code, role, plate_number, phone, daily_base_hours, is_active) 
          VALUES (?, ?, 'driver', ?, ?, ?, 1)`,
    [user, pin_code || '1111', plate_number || '', phone || '', daily_base_hours || 8],
    function(err) {
      if (err) {
        db.run(`INSERT INTO users (name, username, pin_code, role, plate_number, phone, daily_base_hours, is_active) 
                VALUES (?, ?, ?, 'driver', ?, ?, ?, 1)`,
          [user, user, pin_code || '1111', plate_number || '', phone || '', daily_base_hours || 8],
          function(err2) {
            if (err2) return res.status(400).json({ error: 'اسم السائق مسجل بالفعل' });
            io.emit('drivers_list_updated');
            res.json({ success: true, id: this.lastID });
          }
        );
        return;
      }
      io.emit('drivers_list_updated');
      res.json({ success: true, id: this.lastID });
    }
  );
});

// تعديل سائق
app.put('/api/drivers/:id', (req, res) => {
  const { id } = req.params;
  const { username, plate_number, pin_code, phone, daily_base_hours } = req.body;
  const user = String(username || '').trim();

  let query = `UPDATE users SET username=?, plate_number=?, phone=?, daily_base_hours=?`;
  let params = [user, plate_number || '', phone || '', daily_base_hours || 8];

  if (pin_code && pin_code.trim()) {
    query += `, pin_code=?`;
    params.push(pin_code.trim());
  }
  query += ` WHERE id = ?`;
  params.push(id);

  db.run(query, params, function(err) {
    if (err) {
      let queryAlt = `UPDATE users SET name=?, username=?, plate_number=?, phone=?, daily_base_hours=?`;
      let paramsAlt = [user, user, plate_number || '', phone || '', daily_base_hours || 8];
      if (pin_code && pin_code.trim()) {
        queryAlt += `, pin_code=?`;
        paramsAlt.push(pin_code.trim());
      }
      queryAlt += ` WHERE id = ?`;
      paramsAlt.push(id);

      db.run(queryAlt, paramsAlt, function(err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        io.emit('drivers_list_updated');
        res.json({ success: true });
      });
      return;
    }
    io.emit('drivers_list_updated');
    res.json({ success: true });
  });
});

// حذف سائق
app.delete('/api/drivers/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM users WHERE id = ? AND role = 'driver'`, [id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    io.emit('drivers_list_updated');
    res.json({ success: true });
  });
});

// الشيفت النشط
app.get('/api/shifts/active/:driverId', (req, res) => {
  const { driverId } = req.params;
  db.get(`SELECT * FROM shifts WHERE driver_id = ? AND status = 'active'`, [driverId], (err, shift) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ activeShift: shift || null });
  });
});

// بدء الشيفت مع بث فوري للأدمن
app.post('/api/shifts/start', (req, res) => {
  const { driverId } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const now = new Date().toISOString();

  db.get(`SELECT id FROM shifts WHERE driver_id = ? AND status = 'active'`, [driverId], (err, existing) => {
    if (existing) return res.status(400).json({ error: 'يوجد شيفت نشط بالفعل لهذا السائق' });

    db.get(`SELECT COUNT(*) as count FROM shifts WHERE driver_id = ? AND shift_date = ?`, [driverId, today], (err, countRow) => {
      const isFirst = (countRow.count === 0) ? 1 : 0;

      db.get(`SELECT daily_base_hours, username, plate_number FROM users WHERE id = ?`, [driverId], (err, driver) => {
        const baseHours = driver.daily_base_hours || 8;

        db.run(`INSERT INTO shifts (driver_id, shift_date, start_time, is_first_shift, applied_daily_base_hours, distance_km, status)
                VALUES (?, ?, ?, ?, ?, 0, 'active')`,
          [driverId, today, now, isFirst, baseHours],
          function(err) {
            if (err) return res.status(500).json({ error: err.message });
            
            if (liveLocations[driverId]) {
              liveLocations[driverId].distanceKm = 0;
              liveLocations[driverId].trail = [];
            }

            io.emit('shift_started', {
              shiftId: this.lastID,
              driverId,
              username: driver.username,
              plateNumber: driver.plate_number || '',
              startTime: now
            });

            res.json({ success: true, shiftId: this.lastID, startTime: now, isFirst: !!isFirst });
          }
        );
      });
    });
  });
});

// إنهاء الشيفت وحفظ بيانات الإغلاق
app.post('/api/shifts/end', (req, res) => {
  const { driverId } = req.body;
  const now = new Date();
  const nowIso = now.toISOString();

  db.get(`SELECT * FROM shifts WHERE driver_id = ? AND status = 'active'`, [driverId], (err, shift) => {
    if (!shift) return res.status(400).json({ error: 'لا يوجد شيفت نشط لإنهائه' });

    const startTime = new Date(shift.start_time);
    const durationMinutes = Math.max(1, Math.round((now - startTime) / (1000 * 60)));
    const totalDistance = liveLocations[driverId] ? (liveLocations[driverId].distanceKm || 0) : (shift.distance_km || 0);

    lastClosedShiftDetails[driverId] = {
      closedAt: nowIso,
      durationMinutes,
      distanceKm: totalDistance,
      battery: liveLocations[driverId] ? liveLocations[driverId].battery : null,
      wasStopped: !liveLocations[driverId] || liveLocations[driverId].speed === 0
    };

    db.get(`SELECT SUM(base_minutes) as totalBaseSoFar FROM shifts 
            WHERE driver_id = ? AND shift_date = ? AND status = 'completed'`, 
      [driverId, shift.shift_date], (err, agg) => {
        
        const previousBaseMinutes = agg.totalBaseSoFar || 0;
        const maxDailyBaseMinutes = shift.applied_daily_base_hours * 60;
        const remainingBaseMinutes = Math.max(0, maxDailyBaseMinutes - previousBaseMinutes);

        const shiftBaseMinutes = Math.min(durationMinutes, remainingBaseMinutes);
        const shiftOvertimeMinutes = durationMinutes - shiftBaseMinutes;

        db.run(`UPDATE shifts SET end_time = ?, duration_minutes = ?, base_minutes = ?, overtime_minutes = ?, distance_km = ?, status = 'completed'
                WHERE id = ?`,
          [nowIso, durationMinutes, shiftBaseMinutes, shiftOvertimeMinutes, totalDistance, shift.id],
          function(err) {
            if (err) return res.status(500).json({ error: err.message });
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
          }
        );
    });
  });
});

app.get('/api/shifts/history/:driverId', (req, res) => {
  const { driverId } = req.params;
  db.all(`SELECT * FROM shifts WHERE driver_id = ? ORDER BY start_time DESC LIMIT 100`, [driverId], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// تقرير ساعات العمل المباشر والتراكمي
app.get('/api/reports', (req, res) => {
  const { driverId, month } = req.query;
  if (!driverId || !month) return res.status(400).json({ error: 'driverId and month are required' });

  db.all(`SELECT * FROM shifts WHERE driver_id = ? AND shift_date LIKE ? ORDER BY start_time ASC`,
    [driverId, `${month}%`],
    (err, shifts) => {
      if (err) return res.status(500).json({ error: err.message });

      db.get(`SELECT * FROM users WHERE id = ?`, [driverId], (err, driver) => {
        const now = new Date();
        const baseLimitDailyMinutes = (driver.daily_base_hours || 8) * 60;

        let totalBaseMinutes = 0;
        let totalOvertimeMinutes = 0;
        let totalMonthDistanceKm = 0;
        const daysMap = {};

        shifts.forEach(s => {
          let duration = s.duration_minutes || 0;
          let baseMins = s.base_minutes || 0;
          let overtimeMins = s.overtime_minutes || 0;
          let shiftDist = s.distance_km || 0;

          if (s.status === 'active') {
            const start = new Date(s.start_time);
            duration = Math.max(1, Math.round((now - start) / 60000));
            const completedBaseToday = daysMap[s.shift_date] ? daysMap[s.shift_date].baseMinutes : 0;
            const remainingBaseToday = Math.max(0, baseLimitDailyMinutes - completedBaseToday);
            baseMins = Math.min(duration, remainingBaseToday);
            overtimeMins = duration - baseMins;

            if (liveLocations[driverId]) {
              shiftDist = liveLocations[driverId].distanceKm || 0;
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
      });
  });
});

// حالة الأسطول الشاملة للأدمن
app.get('/api/admin/active-drivers', (req, res) => {
  const today = new Date().toISOString().split('T')[0];

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

  db.all(query, [today], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const result = rows.map(r => ({
      ...r,
      location: liveLocations[r.driver_id] || null,
      lastClosed: lastClosedShiftDetails[r.driver_id] || null
    }));
    res.json(result);
  });
});

// معالجة الـ GPS مع فلتر السرعة الذكي وتصفية الاهتزازات
io.on('connection', (socket) => {
  socket.emit('initial_locations', liveLocations);
  socket.emit('speed_limit_changed', { maxSpeed: systemMaxSpeed });

  socket.on('update_location', (data) => {
    const { driverId, username, plateNumber, lat, lng, speed, battery } = data;
    if (driverId && lat && lng) {
      // فلتر السرعة الذكي: أي سرعة أقل من 4 كم/س تُعتبر 0 (متوقف) لتفادي اهتزاز الـ GPS
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

        // لا تحتسب الكيلومترات إلا إذا تحرك أكثر من 25 متراً وبسرعة قيادة حقيقية (>= 4 كم/س)
        if (dist >= 0.025 && dist <= 3.0 && currentSpeed >= 4) {
          prev.distanceKm = Number(((prev.distanceKm || 0) + dist).toFixed(2));
          db.run(`UPDATE shifts SET distance_km = ? WHERE driver_id = ? AND status = 'active'`, [prev.distanceKm, driverId]);
        }

        prev.lat = lat;
        prev.lng = lng;
        prev.speed = currentSpeed;
        prev.isOverSpeed = isOverSpeed;
        if (battery !== undefined) prev.battery = battery;
        prev.updatedAt = new Date().toISOString();

        // رسم مسار السير فقط عند القيادة الحقيقية
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

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running smoothly on: http://localhost:${PORT}`);
});
