const express = require('express');
const { verifyFirebaseAuth } = require('../middleware/auth');
const userController = require('../controllers/user.controller');
const generationController = require('../controllers/generation.controller');

const router = express.Router();

router.post('/identifyUser', verifyFirebaseAuth, userController.identifyUser);
router.post('/generateContent', verifyFirebaseAuth, generationController.generateContent);
router.post('/getTaskStatus', verifyFirebaseAuth, generationController.getTaskStatus);

module.exports = router;
