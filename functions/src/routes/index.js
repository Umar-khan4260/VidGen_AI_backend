const express = require('express');
const multer = require('multer');
const { verifyFirebaseAuth } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const userController = require('../controllers/user.controller');
const generationController = require('../controllers/generation.controller');
const chatController = require('../controllers/chat.controller');
const purchaseController = require('../controllers/purchase.controller');

const router = express.Router();

// Uploaded files are kept in memory and streamed straight to KIE (never written to disk).
// Reference videos can be large (10-50MB+), so allow a generous, env-tunable limit.
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 200;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// identifyUser links a Firebase uid to an account document — rate-limit it so
// the link step cannot be brute-forced.
router.post('/identifyUser', verifyFirebaseAuth, rateLimit({ max: 10, windowMs: 60 * 1000 }), userController.identifyUser);
router.post('/generateContent', verifyFirebaseAuth, generationController.generateContent);
router.post('/getTaskStatus', verifyFirebaseAuth, generationController.getTaskStatus);
router.post('/getDownloadUrl', verifyFirebaseAuth, generationController.getDownloadUrl);

// Chat (server-side KIE proxy — keeps the API key off the client)
router.post('/chatCompletion', verifyFirebaseAuth, chatController.chatCompletion);
router.post('/chatStream', verifyFirebaseAuth, chatController.chatStream);
router.post('/upload', verifyFirebaseAuth, upload.single('file'), chatController.uploadFile);

// Purchases — credits App Store transactions to the Firestore balance.
router.post('/activatePurchase', verifyFirebaseAuth, purchaseController.activatePurchase);

module.exports = router;
