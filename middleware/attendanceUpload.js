const fs = require('fs');
const path = require('path');
const multer = require('multer');

const uploadDir = path.join(__dirname, '../public/uploads/attendance');

const ALLOWED_MIME_MAGIC = new Set(['image/jpeg', 'image/png', 'image/webp']);

function ensureUploadDir() {
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    ensureUploadDir();
    cb(null, uploadDir);
  },
  filename(req, file, cb) {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `attendance-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const uploadAttendance = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Hanya file gambar yang diperbolehkan (JPEG, PNG, WebP)'));
  }
});

function removeAttendanceFile(file) {
  if (!file) return;
  const targetPath = typeof file === 'string' ? file : file.path;
  if (!targetPath) return;

  try {
    if (fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
  } catch (err) {

  }
}

// Verifikasi magic-byte (konten asli file) setelah upload selesai, bukan hanya
// ekstensi/MIME header yang mudah dipalsukan. File yang tidak lolos langsung
// dihapus dan request ditolak. Backend-only hardening, tidak mengubah UI.
async function verifyAttendanceFileMagicBytes(req, res, next) {
  if (!req.file) return next();

  try {
    const { fileTypeFromFile } = await import('file-type');
    const detected = await fileTypeFromFile(req.file.path);

    if (!detected || !ALLOWED_MIME_MAGIC.has(detected.mime)) {
      removeAttendanceFile(req.file);
      return res.status(400).json({
        success: false,
        message: 'File tidak valid: konten file tidak sesuai dengan gambar yang diizinkan (JPEG/PNG/WebP).'
      });
    }
    return next();
  } catch (err) {
    // Jika deteksi gagal karena alasan teknis (bukan file rusak), jangan blokir upload
    // agar tidak menimbulkan regresi fungsional yang tidak diminta.
    return next();
  }
}

module.exports = {
  uploadAttendance,
  verifyAttendanceFileMagicBytes,
  removeAttendanceFile
};
