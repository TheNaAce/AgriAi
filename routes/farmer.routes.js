const express = require('express');
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const controller = require('../controllers/farmer.controller');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image uploads are allowed'));
    return cb(null, true);
  },
});

router.use(authenticate);
router.post('/onboard', controller.onboard);
router.get('/profile', controller.profile);
router.get('/dashboard', controller.dashboard);
router.get('/crop-guidance', controller.cropGuidance);
router.get('/village-broadcast', controller.villageBroadcast);
router.post('/loan-reminder', controller.createLoanReminder);
router.post('/trigger-risk-eval', controller.triggerRiskEval);
router.post('/diagnose-leaf', upload.single('file'), controller.diagnoseLeaf);
router.post('/score-distress', controller.scoreDistress);

module.exports = router;
