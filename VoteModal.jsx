import React, { useState } from 'react';

export default function VoteModal({ candidateName = "B02 โต", onClose }) {
  // State เก็บราคาที่เลือก (Default เป็น 1000 หรือ 20)
  const [selectedAmount, setSelectedAmount] = useState(1000);

  // Path รูปภาพชี้ไปที่ /qrImages/ ตามโครงสร้างโฟลเดอร์ของคุณ
  const qrMap = {
    10: '/qrImages/10.jpg',
    50: '/qrImages/50.jpg',
    100: '/qrImages/100.jpg',
  };

  return (
    <div className="bg-[#120B22] p-6 rounded-2xl border border-amber-500/40 w-[360px] text-white flex flex-col items-center shadow-2xl">
      {/* ส่วนรูปโปรไฟล์และชื่อ */}
      <div className="w-20 h-20 rounded-full border-2 border-amber-400 overflow-hidden mb-3">
        <img src="/images/b02.jpg" alt="Candidate" className="w-full h-full object-cover" />
      </div>
      
      <h2 className="text-xl font-bold text-amber-400 mb-1">โหวตให้: {candidateName}</h2>
      <p className="text-xs text-amber-200/80 mb-4">เลือกจำนวนเงินโหวต (บาท)</p>

      {/* ปุ่มเลือกราคา */}
      <div className="grid grid-cols-3 gap-2 w-full mb-4">
        {[20, 50, 100, 200, 500, 1000].map((amount) => (
          <button
            key={amount}
            type="button"
            onClick={() => setSelectedAmount(amount)}
            className={`py-2 rounded-lg font-bold text-sm transition-all border ${
              selectedAmount === amount
                ? 'bg-gradient-to-r from-amber-500 to-yellow-400 text-black border-yellow-300 shadow-md scale-105'
                : 'bg-[#1C1335] text-amber-400 border-amber-500/30 hover:border-amber-400'
            }`}
          >
            {amount}
          </button>
        ))}
      </div>

      {/* QR Code Dynamic แสดงตามราคาที่กดเลือก */}
      <div className="bg-white p-3 rounded-2xl shadow-lg border-2 border-yellow-400 mb-4">
        <img
          src={qrMap[selectedAmount]}
          alt={`QR Code ${selectedAmount} Baht`}
          className="w-48 h-48 object-contain"
        />
      </div>

      {/* นับถอยหลัง */}
      <div className="bg-[#1C1335] px-4 py-1.5 rounded-full border border-amber-500/30 text-xs text-amber-300 mb-4">
        ⏱ เวลาที่เหลือ: 04:59 นาที
      </div>

      {/* แนบสลิป */}
      <div className="w-full mb-4 text-left">
        <label className="text-xs text-amber-200/80 mb-1 block">แนบสลิปโอนเงิน (เฉพาะ .jpg, .png):</label>
        <input
          type="file"
          accept=".jpg,.png"
          className="w-full text-xs text-gray-400 bg-[#1C1335] border border-amber-500/40 rounded-lg p-2 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:bg-gray-200 file:text-black"
        />
      </div>

      {/* ปุ่มกดยืนยัน */}
      <button className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl transition-all mb-3 shadow-lg">
        ยืนยันส่งสลิปโหวต
      </button>

      <button onClick={onClose} className="text-xs text-amber-400/80 hover:text-amber-300">
        ยกเลิก
      </button>
    </div>
  );
}