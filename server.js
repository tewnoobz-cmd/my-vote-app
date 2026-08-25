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

// ฟังก์ชันบันทึกไฟล์ SQLite ลง Disk
function saveDatabase() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbFilePath, buffer);
  }
}

app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/qrImages', express.static(path.join(__dirname, 'public/qrImages')));

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 } 
});

function getScoresOnly() {
  const scores = {};
  for (let i = 1; i <= 36; i++) scores[i] = 0;

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

function getSortedSummary() {
  const scoresObj = getScoresOnly();
  return Object.keys(scoresObj).map(id => ({
    candidateId: parseInt(id, 10),
    totalVotes: scoresObj[id]
  })).sort((a, b) => b.totalVotes - a.totalVotes);
}

function getAdminLogs() {
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
  const scores = getScoresOnly();
  const sortedSummary = getSortedSummary();
  const logs = getAdminLogs();
  
  io.emit('voteUpdate', { scores, isVotingOpen, isSummaryOpen });
  io.emit('summaryUpdate', { isSummaryOpen, sortedSummary });
  io.emit('adminLogsUpdate', logs);
}

app.get('/api/scores', (req, res) => {
  try {
    const scores = getScoresOnly();
    res.json({ success: true, scores, isVotingOpen, isSummaryOpen });
  } catch (err) {
    res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลได้' });
  }
});

app.get('/api/vote-summary', (req, res) => {
  try {
    if (!isSummaryOpen) {
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
  const { open: openVote } = req.body;
  if (typeof openVote === 'boolean') {
    isVotingOpen = openVote;
    broadcastUpdate();
    return res.json({ success: true, isVotingOpen });
  }
  res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
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

app.post('/api/vote', upload.single('slip'), (req, res) => {
  try {
    if (!isVotingOpen) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(403).json({ success: false, message: 'ขณะนี้ระบบปิดรับการโหวตชั่วคราว' });
    }

    const { fullname, studentId, phone, candidateId, amount } = req.body;
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'กรุณาแนบไฟล์สลิปการโอนเงิน' });
    }

    const cId = parseInt(candidateId, 10);
    const inputAmount = parseInt(amount, 10);

    if (isNaN(cId) || isNaN(inputAmount) || cId < 1 || cId > 36) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(400).json({ success: false, message: 'ข้อมูลผู้สมัครหรือจำนวนเงินไม่ถูกต้อง' });
    }

    let finalScore = inputAmount;
    if (inputAmount === 50) finalScore = 65;
    else if (inputAmount === 100) finalScore = 150;

    const timeString = new Date().toLocaleString('th-TH');
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

io.on('connection', (socket) => {
  try {
    socket.emit('voteUpdate', { scores: getScoresOnly(), isVotingOpen, isSummaryOpen });
    socket.emit('statusUpdate', { isVotingOpen, isSummaryOpen });
    socket.emit('summaryUpdate', { isSummaryOpen, sortedSummary: getSortedSummary() });
  } catch (err) {
    console.error('Socket Connection Error:', err);
  }
});

// โหลดฐานข้อมูล sql.js
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
    console.log(`🚀 Server ทำงานอยู่ที่ http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('❌ Failed to initialize SQL.js:', err);
});