require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "0000";

// 1. เชื่อมต่อ MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://<USER>:<PASSWORD>@cluster0.xxxx.mongodb.net/kpruVoteDB?retryWrites=true&w=majority";

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Atlas Connected Successfully!'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 2. สร้าง Database Schemas บน MongoDB
const voteSchema = new mongoose.Schema({
  voteId: { type: Number },
  fullname: { type: String, default: '' },
  studentId: { type: String, default: '' },
  phone: { type: String, default: '' },
  candidateId: { type: Number, required: true },
  amount: { type: Number, required: true },
  timestamp: { type: String, default: () => new Date().toLocaleString('th-TH') },
  slipUrl: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
});

// Auto-increment Simulating for voteId
voteSchema.pre('save', async function (next) {
  if (this.isNew && !this.voteId) {
    const lastVote = await this.constructor.findOne().sort({ voteId: -1 });
    this.voteId = lastVote && lastVote.voteId ? lastVote.voteId + 1 : 1;
  }
  next();
});

const Vote = mongoose.model('Vote', voteSchema);

// Schema สำหรับควบคุมสถานะระบบ (เปิด/ปิด โหวต และสรุปผล)
const systemStatusSchema = new mongoose.Schema({
  isVotingOpen: { type: Boolean, default: true },
  isSummaryOpen: { type: Boolean, default: false }
});
const SystemStatus = mongoose.model('SystemStatus', systemStatusSchema);

// ฟังก์ชันดึงสถานะระบบ
async function getSystemStatus() {
  let status = await SystemStatus.findOne();
  if (!status) {
    status = await SystemStatus.create({ isVotingOpen: true, isSummaryOpen: false });
  }
  return status;
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

// Helper Functions
async function getScoresOnly() {
  const scores = {};
  for (let i = 1; i <= 36; i++) scores[i] = 0;

  const res = await Vote.aggregate([
    { $match: { status: 'approved' } },
    { $group: { _id: "$candidateId", total: { $sum: "$amount" } } }
  ]);

  res.forEach(row => {
    if (scores[row._id] !== undefined) {
      scores[row._id] = row.total;
    }
  });

  return scores;
}

async function getSortedSummary() {
  const scoresObj = await getScoresOnly();
  return Object.keys(scoresObj).map(id => ({
    candidateId: parseInt(id, 10),
    totalVotes: scoresObj[id]
  })).sort((a, b) => b.totalVotes - a.totalVotes);
}

async function getAdminLogs() {
  const votes = await Vote.find().sort({ voteId: -1 });
  return votes.map(v => ({
    id: v.voteId,
    fullname: v.fullname,
    studentId: v.studentId,
    phone: v.phone,
    candidateId: v.candidateId,
    amount: v.amount,
    timestamp: v.timestamp,
    slipUrl: v.slipUrl,
    status: v.status
  }));
}

async function getAdminData() {
  const status = await getSystemStatus();
  return { 
    logs: await getAdminLogs(), 
    scores: await getScoresOnly(), 
    isVotingOpen: status.isVotingOpen, 
    isSummaryOpen: status.isSummaryOpen 
  };
}

async function broadcastUpdate() {
  const status = await getSystemStatus();
  const scores = await getScoresOnly();
  const sortedSummary = await getSortedSummary();
  const logs = await getAdminLogs();
  
  io.emit('voteUpdate', { scores, isVotingOpen: status.isVotingOpen, isSummaryOpen: status.isSummaryOpen });
  io.emit('summaryUpdate', { isSummaryOpen: status.isSummaryOpen, sortedSummary });
  io.emit('adminLogsUpdate', logs);
}

// ----------------- Public APIs -----------------

// API ดึงคะแนน (ล็อกไม่ให้คนทั่วไปเห็นสรุปหากไม่ได้เปิด Admin mode)
app.get('/api/scores', async (req, res) => {
  try {
    const status = await getSystemStatus();
    const scores = await getScoresOnly();
    res.json({ success: true, scores, isVotingOpen: status.isVotingOpen, isSummaryOpen: status.isSummaryOpen });
  } catch (err) {
    res.status(500).json({ success: false, message: 'ไม่สามารถดึงข้อมูลได้' });
  }
});

app.get('/api/vote-summary', async (req, res) => {
  try {
    const status = await getSystemStatus();
    if (!status.isSummaryOpen) {
      return res.json({ success: false, isSummaryOpen: false, message: 'ขณะนี้ระบบยังไม่ได้เปิดแสดงผลสรุปการโหวต' });
    }
    res.json({ success: true, isSummaryOpen: true, data: await getSortedSummary() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการดึงข้อมูลสรุปผล' });
  }
});

app.post('/api/vote', upload.single('slip'), async (req, res) => {
  try {
    const status = await getSystemStatus();
    if (!status.isVotingOpen) {
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

    const slipUrl = `/uploads/${req.file.filename}`;

    await Vote.create({
      fullname: fullname || '',
      studentId: studentId || '',
      phone: phone || '',
      candidateId: cId,
      amount: finalScore,
      slipUrl: slipUrl,
      status: 'pending'
    });

    await broadcastUpdate();

    res.json({ success: true, message: 'ส่งสลิปเรียบร้อยแล้ว! ข้อมูลส่งไปยัง Admin เพื่อตรวจสอบคะแนน' });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, message: `เกิดข้อผิดพลาด: ${error.message}` });
  }
});

// ----------------- Admin APIs -----------------

app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
      return res.json({ success: true, message: 'เข้าสู่ระบบ Admin สำเร็จ', ...(await getAdminData()) });
    }
    return res.status(401).json({ success: false, message: 'รหัสผ่าน Admin ไม่ถูกต้อง!' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการเข้าสู่ระบบ' });
  }
});

app.post('/api/admin/toggle-vote', async (req, res) => {
  const { open: openVote } = req.body;
  if (typeof openVote === 'boolean') {
    const status = await getSystemStatus();
    status.isVotingOpen = openVote;
    await status.save();
    await broadcastUpdate();
    return res.json({ success: true, isVotingOpen: status.isVotingOpen });
  }
  res.status(400).json({ success: false, message: 'ข้อมูลไม่ถูกต้อง' });
});

app.post('/api/admin/toggle-summary', async (req, res) => {
  try {
    const { open: openSummary } = req.body;
    const status = await getSystemStatus();
    status.isSummaryOpen = typeof openSummary === 'boolean' ? openSummary : !status.isSummaryOpen;
    await status.save();
    await broadcastUpdate();
    res.json({ 
      success: true, 
      isSummaryOpen: status.isSummaryOpen, 
      message: status.isSummaryOpen ? 'แสดงผลสรุปการโหวตเรียบร้อยแล้ว' : 'ปิดการแสดงผลสรุปการโหวตเรียบร้อยแล้ว' 
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการสลับสถานะสรุปผล' });
  }
});

app.post('/api/admin/verify-vote', async (req, res) => {
  try {
    const { voteId, status } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'สถานะไม่ถูกต้อง' });
    }

    await Vote.findOneAndUpdate({ voteId: voteId }, { status: status });
    await broadcastUpdate();

    res.json({ success: true, message: `อัปเดตสถานะเป็น ${status} เรียบร้อย` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาดในการอัปเดตสถานะ' });
  }
});

// Endpoint สำหรับใส่คะแนนตั้งต้นของเมื่อวานคืนระบบ (เรียกใช้ครั้งเดียวผ่าน URL)
app.get('/api/admin/restore-initial-votes', async (req, res) => {
  try {
    const password = req.query.password;
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).send('รหัสผ่านไม่ถูกต้อง');
    }

    // ตัวอย่างการกรอกคะแนนตั้งต้นที่นับได้จากสเตตเมนต์ (แก้ไขตามจริงได้เลย)
    const initialVotes = [
      { candidateId: 1, amount: 20 },
      { candidateId: 2, amount: 15 },
      // เพิ่มเบอร์อื่นเพิ่มเติมที่นี่
    ];

    for (const item of initialVotes) {
      await Vote.create({
        fullname: 'คะแนนตั้งต้น (สรุปสเตตเมนต์)',
        candidateId: item.candidateId,
        amount: item.amount,
        status: 'approved'
      });
    }

    await broadcastUpdate();
    res.send('✅ บันทึกคะแนนตั้งต้นย้อนหลังเข้า MongoDB Atlas เรียบร้อยแล้ว!');
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Socket.io Connection
io.on('connection', async (socket) => {
  try {
    const status = await getSystemStatus();
    const scores = await getScoresOnly();
    const sortedSummary = await getSortedSummary();

    socket.emit('voteUpdate', { scores, isVotingOpen: status.isVotingOpen, isSummaryOpen: status.isSummaryOpen });
    socket.emit('statusUpdate', { isVotingOpen: status.isVotingOpen, isSummaryOpen: status.isSummaryOpen });
    socket.emit('summaryUpdate', { isSummaryOpen: status.isSummaryOpen, sortedSummary });
  } catch (err) {
    console.error('Socket Connection Error:', err);
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server ทำงานอยู่ที่ http://localhost:${PORT}`);
});