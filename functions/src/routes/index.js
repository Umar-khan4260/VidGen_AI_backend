const express = require('express');
const multer = require('multer');
const { verifyFirebaseAuth } = require('../middleware/auth');
const userController = require('../controllers/user.controller');
const generationController = require('../controllers/generation.controller');
const chatController = require('../controllers/chat.controller');

const router = express.Router();

// Uploaded files are kept in memory and streamed straight to KIE (never written to disk).
// Reference videos can be large (10-50MB+), so allow a generous, env-tunable limit.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 200;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

router.post('/identifyUser', verifyFirebaseAuth, userController.identifyUser);
router.post('/generateContent', verifyFirebaseAuth, generationController.generateContent);
router.post('/getTaskStatus', verifyFirebaseAuth, generationController.getTaskStatus);
router.post('/getDownloadUrl', verifyFirebaseAuth, generationController.getDownloadUrl);

// Chat (server-side KIE proxy — keeps the API key off the client)
router.post('/chatCompletion', verifyFirebaseAuth, chatController.chatCompletion);
router.post('/chatStream', verifyFirebaseAuth, chatController.chatStream);
router.post('/upload', verifyFirebaseAuth, upload.single('file'), chatController.uploadFile);

module.exports = router;
