const express = require('express');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = 3000;

// สถานะการเปิด/ปิดโหวต (Default: true)
let isVotingOpen = true;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const uploadDir = path.join(__dirname, 'QR Code');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.use('/QR Code', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}${path.extname(file.originalname)}`)
});

const upload = multer({ storage: storage });

let db;
(async () => {
  try {
    db = await open({
      filename: path.join(__dirname, 'database.sqlite'),
      driver: sqlite3.Database
    });

    await db.exec(`
      CREATE TABLE IF NOT EXISTS votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fullname TEXT,
        studentId TEXT,
        phone TEXT,
        candidateId INTEGER,
        amount INTEGER,
        timestamp TEXT,
        slipUrl TEXT
      )
    `);
    console.log('เชื่อมต่อ Database SQLite เรียบร้อย');
  } catch (err) {
    console.error('เกิดข้อผิดพลาดกับ Database:', err);
  }
})();

async function getStats() {
  const logs = await db.all('SELECT * FROM votes ORDER BY id DESC');
  const scores = {};
  for (let i = 1; i <= 36; i++) scores[i] = 0;

  logs.forEach(log => {
    const cId = Number(log.candidateId);
    if (scores[cId] !== undefined) {
      scores[cId] += Number(log.amount) || 0;
    }
  });
  return { logs, scores, isVotingOpen };
}

app.get('/api/scores', async (req, res) => {
  try {
    const data = await getStats();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลได้' });
  }
});

// API สำหรับ Toggle สถานะการโหวต ( Admin )
app.post('/api/admin/toggle-vote', (req, res) => {
  const { open } = req.body;
  if (typeof open === 'boolean') {
    isVotingOpen = open;
    io.emit('statusUpdate', { isVotingOpen });
    return res.json({ success: true, isVotingOpen });
  }
  res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
});

app.post('/api/vote', upload.single('slip'), async (req, res) => {
  try {
    // ตรวจสอบสถานะก่อนให้ลงคะแนน
    if (!isVotingOpen) {
      return res.status(403).json({ success: false, message: 'ขณะนี้ระบบปิดรับการโหวตชั่วคราว' });
    }

    const { fullname, studentId, phone, candidateId, amount } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'กรุณาแนบไฟล์สลิปการโอนเงิน' });
    }

    const cId = parseInt(candidateId, 10);
    const voteAmount = parseInt(amount, 10);

    if (isNaN(cId) || isNaN(voteAmount)) {
      return res.status(400).json({ success: false, message: 'ข้อมูลผู้สมัครหรือจำนวนเงินไม่ถูกต้อง' });
    }

    const timeString = new Date().toLocaleString('th-TH');
    const slipUrl = `/QR%20Code/${req.file.filename}`;

    await db.run(
      `INSERT INTO votes (fullname, studentId, phone, candidateId, amount, timestamp, slipUrl) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [fullname || '', studentId || '', phone || '', cId, voteAmount, timeString, slipUrl]
    );

    const updatedData = await getStats();
    io.emit('voteUpdate', updatedData);

    res.json({ success: true, message: 'โหวตสำเร็จเรียบร้อยแล้ว!' });
  } catch (error) {
    console.error('VOTE ERROR:', error);
    res.status(500).json({ success: false, message: `เกิดข้อผิดพลาดในการบันทึกข้อมูล: ${error.message}` });
  }
});

app.get('/api/admin/logs', async (req, res) => {
  try {
    const data = await getStats();
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลประวัติได้' });
  }
});

io.on('connection', async (socket) => {
  const data = await getStats();
  socket.emit('voteUpdate', data);
});

server.listen(PORT, () => console.log(`Server ทำงานอยู่ที่ http://localhost:${PORT}`));