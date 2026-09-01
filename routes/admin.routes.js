const express = require('express');
const { authenticateAdmin } = require('../middleware/adminAuth');
const controller = require('../controllers/admin.controller');

const router = express.Router();
router.use(authenticateAdmin);
router.get('/distress-map', controller.distressMap);
router.get('/alerts', controller.alerts);
router.get('/season-replay', controller.seasonReplay);
router.patch('/alerts/:id/status', controller.updateAlertStatus);

module.exports = router;
