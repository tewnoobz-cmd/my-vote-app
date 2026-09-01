require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "0000";
const dbFilePath = path.join(__dirname, 'database.sqlite');

let isVotingOpen = true;
let isSummaryOpen = false;
let db;

// ----------------------------------------------------
// 1. ฟังก์ชันจัดการฐานข้อมูล & ข้อมูลคะแนน (1-8 คณะ)
// ----------------------------------------------------
function saveDatabase() {
  if (db) {
    try {
      const data = db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(dbFilePath, buffer);
    } catch (err) {
      console.error('❌ Failed to save database:', err);
    }
  }
}

// คำนวณคะแนนจริงในฐานข้อมูลสำหรับ 8 คณะ
function getScoresOnly() {
  const scores = {};
  for (let i = 1; i <= 8; i++) scores[i] = 0;

  if (!db) return scores;

  const res = db.exec(`
    SELECT candidateId, SUM(amount) AS total 
    FROM votes 
    WHERE status = 'approved' 
    GROUP BY candidateId
  `);

  if (res.length > 0) {
    const values = res[0].values;
    values.forEach(row => {
      const candidateId = row[0];
      const total = row[1];
      if (scores[candidateId] !== undefined) {
        scores[candidateId] = total;
      }
    });
  }

  return scores;
}

// สร้างคะแนนว่าง (0 ทั้งหมด)
function getHiddenScores() {
  const scores = {};
  for (let i = 1; i <= 8; i++) scores[i] = 0;
  return scores;
}

function getSortedSummary() {
  const scoresObj = getScoresOnly();
  return Object.keys(scoresObj).map(id => ({
    candidateId: parseInt(id, 10),
    totalVotes: scoresObj[id]
  })).sort((a, b) => b.totalVotes - a.totalVotes);
}

function getAdminLogs() {
  if (!db) return [];
  const res = db.exec('SELECT id, fullname, studentId, phone, candidateId, amount, timestamp, slipUrl, status FROM votes ORDER BY id DESC');
  if (res.length === 0) return [];
  
  const columns = res[0].columns;
  return res[0].values.map(row => {
    const obj = {};
    columns.forEach((col, idx) => { obj[col] = row[idx]; });
    return obj;
  });
}

function getAdminData() {
  return { logs: getAdminLogs(), scores: getScoresOnly(), isVotingOpen, isSummaryOpen };
}

function broadcastUpdate() {
  const realScores = getScoresOnly();
  const hiddenScores = getHiddenScores();
  const sortedSummary = getSortedSummary();
  const logs = getAdminLogs();

  io.to('admin-room').emit('voteUpdate', { scores: realScores, isVotingOpen, isSummaryOpen });
  io.to('admin-room').emit('summaryUpdate', { isSummaryOpen: true, sortedSummary });
  io.to('admin-room').emit('adminLogsUpdate', logs);

  const publicScores = isSummaryOpen ? realScores : hiddenScores;
  const publicSummary = isSummaryOpen ? sortedSummary : [];
  
  io.emit('statusUpdate', { isVotingOpen, isSummaryOpen });
  io.emit('voteUpdate', { scores: publicScores, isVotingOpen, isSummaryOpen });
  io.emit('summaryUpdate', { isSummaryOpen, sortedSummary: publicSummary });
}

// ----------------------------------------------------
// 2. Middleware & Static Paths
// ----------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/qrImages', express.static(path.join(__dirname, 'public/qrImages')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

// ----------------------------------------------------
// 3. ตั้งค่า Multer
// ----------------------------------------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'slip-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('รองรับเฉพาะไฟล์รูปภาพ (JPG, PNG, WEBP) เท่านั้น'));
  }
});

// ----------------------------------------------------
// 4. REST APIs
// ----------------------------------------------------

app.get('/api/scores', (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const isAdmin = authHeader === `Bearer ${ADMIN_PASSWORD}` || authHeader === ADMIN_PASSWORD;

    if (isAdmin || isSummaryOpen) {
      return res.json({ success: true, scores: getScoresOnly(), isVotingOpen, isSummaryOpen });
    }

    res.json({ success: true, scores: getHiddenScores(), isVotingOpen, isSummaryOpen });
  } catch (err) {
    res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลได้' });
  }
});

app.get('/api/vote-summary', (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const isAdmin = authHeader === `Bearer ${ADMIN_PASSWORD}` || authHeader === ADMIN_PASSWORD;

    if (!isSummaryOpen && !isAdmin) {
      return res.json({ success: false, isSummaryOpen: false, message: 'ขณะนี้ระบบยังไม่ได้เปิดแสดงผลสรุปการโหวต' });
    }
    res.json({ success: true, isSummaryOpen: true, data: getSortedSummary() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลสรุปผล' });
  }
});

app.post('/api/admin/login', (req, res) => {
  try {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
      return res.json({ success: true, message: 'เข้าสู่ระบบ Admin สำเร็จ', ...getAdminData() });
    }
    return res.status(401).json({ success: false, message: 'รหัสผ่าน Admin ไม่ถูกต้อง!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ' });
  }
});

app.post('/api/admin/toggle-vote', (req, res) => {
  try {
    const { open: openVote } = req.body;
    if (typeof openVote === 'boolean') {
      isVotingOpen = openVote;
      broadcastUpdate();
      return res.json({ success: true, isVotingOpen });
    }
    res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเปลี่ยนสถานะการโหวต' });
  }
});

app.post('/api/admin/toggle-summary', (req, res) => {
  try {
    const { open: openSummary } = req.body;
    isSummaryOpen = typeof openSummary === 'boolean' ? openSummary : !isSummaryOpen;
    broadcastUpdate();
    res.json({ 
      success: true, 
      isSummaryOpen, 
      message: isSummaryOpen ? 'แสดงผลสรุปการโหวตเรียบร้อยแล้ว' : 'ปิดการแสดงผลสรุปการโหวตเรียบร้อยแล้ว' 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสลับสถานะสรุปผล' });
  }
});

app.post('/api/vote', (req, res) => {
  if (!isVotingOpen) {
    return res.status(403).json({ success: false, message: 'ขณะนี้ระบบปิดรับการโหวตชั่วคราว' });
  }

  upload.single('slip')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    try {
      const { fullname, studentId, phone, candidateId, amount } = req.body;
      if (!req.file) {
        return res.status(400).json({ success: false, message: 'กรุณาแนบไฟล์สลิปการโอนเงิน' });
      }

      const cId = parseInt(candidateId, 10);
      const inputAmount = parseInt(amount, 10);

      // ตรวจสอบ ID ให้อยู่ในช่วง 1 ถึง 8
      if (isNaN(cId) || isNaN(inputAmount) || cId < 1 || cId > 8) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(400).json({ success: false, message: 'ข้อมูลคณะ/สาขา หรือจำนวนเงินไม่ถูกต้อง' });
      }

      let finalScore = inputAmount;
      if (inputAmount === 50) finalScore = 65;
      else if (inputAmount === 100) finalScore = 150;

      const timeString = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
      const slipUrl = `/uploads/${req.file.filename}`;

      db.run(
        `INSERT INTO votes (fullname, studentId, phone, candidateId, amount, timestamp, slipUrl, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [fullname || '', studentId || '', phone || '', cId, finalScore, timeString, slipUrl]
      );

      saveDatabase();
      broadcastUpdate();

      res.json({ success: true, message: 'ส่งสลิปเรียบร้อยแล้ว! ข้อมูลส่งไปยัง Admin เพื่อตรวจสอบคะแนน' });
    } catch (error) {
      if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({ success: false, message: `เกิดข้อผิดพลาด: ${error.message}` });
    }
  });
});

app.post('/api/admin/verify-vote', (req, res) => {
  try {
    const { voteId, status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'สถานะไม่ถูกต้อง' });
    }

    db.run('UPDATE votes SET status = ? WHERE id = ?', [status, voteId]);
    saveDatabase();
    broadcastUpdate();

    res.json({ success: true, message: `อัปเดตสถานะเป็น ${status} เรียบร้อย` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการอัปเดตสถานะ' });
  }
});

// ----------------------------------------------------
// 5. Socket.io
// ----------------------------------------------------
io.on('connection', (socket) => {
  try {
    socket.on('joinAdmin', (password) => {
      if (password === ADMIN_PASSWORD) {
        socket.join('admin-room');
        socket.emit('voteUpdate', { scores: getScoresOnly(), isVotingOpen, isSummaryOpen });
        socket.emit('adminLogsUpdate', getAdminLogs());
      }
    });

    const publicScores = isSummaryOpen ? getScoresOnly() : getHiddenScores();
    const publicSummary = isSummaryOpen ? getSortedSummary() : [];

    socket.emit('statusUpdate', { isVotingOpen, isSummaryOpen });
    socket.emit('voteUpdate', { scores: publicScores, isVotingOpen, isSummaryOpen });
    socket.emit('summaryUpdate', { isSummaryOpen, sortedSummary: publicSummary });
  } catch (err) {
    console.error('Socket Connection Error:', err);
  }
});

// ----------------------------------------------------
// 6. Start Server
// ----------------------------------------------------
initSqlJs().then(SQL => {
  if (fs.existsSync(dbFilePath)) {
    const filebuffer = fs.readFileSync(dbFilePath);
    db = new SQL.Database(filebuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fullname TEXT,
      studentId TEXT,
      phone TEXT,
      candidateId INTEGER,
      amount INTEGER,
      timestamp TEXT,
      slipUrl TEXT,
      status TEXT DEFAULT 'pending'
    )
  `);
  saveDatabase();

  server.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`🚀 Server running on port: ${PORT}`);
    console.log(`🌐 URL: http://localhost:${PORT}`);
    console.log(`=================================`);
  });
}).catch(err => {
  console.error('❌ Failed to initialize SQL.js:', err);
});