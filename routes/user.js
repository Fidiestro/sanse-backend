const express = require('express');
const router = express.Router();
const referralController = require('../controllers/referralController');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// Perfil
router.get('/profile', referralController.getProfile);
router.put('/profile', referralController.updateProfile);
router.put('/password', referralController.changePassword);

// Referidos
router.get('/referrals', referralController.getMyReferrals);

module.exports = router;
