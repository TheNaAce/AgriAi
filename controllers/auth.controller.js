const Joi = require('joi');
const jwt = require('jsonwebtoken');
const Farmer = require('../models/Farmer');
const { issueOtp, verifyOtp, revokeOtp, sendSms } = require('../services/otpService');

const phoneSchema = Joi.object({ phone: Joi.string().pattern(/^[6-9]\d{9}$/).required() });
const verifySchema = phoneSchema.keys({ otp: Joi.string().pattern(/^\d{6}$/).required() });

async function sendOtp(req, res, next) {
  try {
    const { value, error } = phoneSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    const otp = await issueOtp(value.phone, req.ip);
    let delivery;
    try { delivery = await sendSms(value.phone, otp); } catch (smsError) { await revokeOtp(value.phone); throw smsError; }
    const payload = { message: 'OTP sent successfully', delivery: delivery.provider };
    if (process.env.NODE_ENV !== 'production' && delivery.provider === 'sandbox') payload.sandboxOtp = otp;
    return res.status(202).json(payload);
  } catch (error) { return next(error); }
}

async function verifyOtpHandler(req, res, next) {
  try {
    const { value, error } = verifySchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.message });
    if (!(await verifyOtp(value.phone, value.otp))) return res.status(401).json({ error: 'Invalid, expired, or already-used OTP' });
    let farmer = await Farmer.findOne({ phone: value.phone });
    const isNewUser = !farmer;
    if (!farmer) farmer = await Farmer.create({ phone: value.phone });
    const token = jwt.sign({ farmerId: String(farmer._id), phone: farmer.phone }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
    return res.json({ token, isNewUser, farmerId: farmer._id, expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
  } catch (error) { return next(error); }
}

module.exports = { sendOtp, verifyOtp: verifyOtpHandler };
