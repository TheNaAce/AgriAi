const Joi = require('joi');
const Farmer = require('../models/Farmer');
const EscalationAlert = require('../models/EscalationAlert');

const listSchema = Joi.object({
  district: Joi.string().trim().max(80), state: Joi.string().trim().max(80), status: Joi.string().valid('Pending', 'Assigned', 'Contacted', 'Resolved'),
  cropName: Joi.string().trim().max(80), riskTier: Joi.string().valid('Stable', 'Vulnerable', 'Critical'),
  page: Joi.number().integer().min(1).default(1), limit: Joi.number().integer().min(1).max(100).default(25),
});

async function distressMap(req, res, next) {
  try {
    const { value, error } = listSchema.validate(req.query);
    if (error) return res.status(400).json({ error: error.message });
    const filter = { 'distressProfile.tier': { $in: ['Vulnerable', 'Critical'] } };
    if (value.district) filter['location.district'] = value.district;
    if (value.state) filter['location.state'] = value.state;
    const farmers = await Farmer.find(filter).select('name phone location cropDetails.cropName distressProfile').limit(1000).lean();
    return res.json({ count: farmers.length, farmers });
  } catch (error) { return next(error); }
}

async function seasonReplay(req, res, next) {
  try {
    return res.json({
      district: req.query.district || 'Cuttack',
      weeks: [
        { week: 'W1', drought: 28, price: 12, distress: 22 },
        { week: 'W2', drought: 34, price: 18, distress: 31 },
        { week: 'W3', drought: 48, price: 21, distress: 43 },
        { week: 'W4', drought: 55, price: 23, distress: 49 },
        { week: 'W5', drought: 61, price: 30, distress: 58 },
        { week: 'W6', drought: 46, price: 27, distress: 51 },
        { week: 'W7', drought: 38, price: 19, distress: 39 },
      ],
      updatedAt: new Date().toISOString(),
    });
  } catch (error) { return next(error); }
}

async function alerts(req, res, next) {
  try {
    const { value, error } = listSchema.validate(req.query);
    if (error) return res.status(400).json({ error: error.message });
    const filter = {};
    if (value.status) filter.status = value.status;
    if (value.district) filter.district = value.district;
    const farmerFilter = {};
    if (value.state) farmerFilter['location.state'] = value.state;
    if (value.cropName) farmerFilter['cropDetails.cropName'] = value.cropName;
    if (value.riskTier) farmerFilter['distressProfile.tier'] = value.riskTier;
    if (Object.keys(farmerFilter).length) {
      const ids = await Farmer.find(farmerFilter).select('_id').lean();
      filter.farmerId = { $in: ids.map((item) => item._id) };
    }
    const [items, total] = await Promise.all([
      EscalationAlert.find(filter).sort({ createdAt: -1 }).skip((value.page - 1) * value.limit).limit(value.limit).populate('farmerId', 'name phone cropDetails location distressProfile').lean(),
      EscalationAlert.countDocuments(filter),
    ]);
    return res.json({ items, pagination: { page: value.page, limit: value.limit, total, pages: Math.ceil(total / value.limit) } });
  } catch (error) { return next(error); }
}

const updateSchema = Joi.object({
  status: Joi.string().valid('Assigned', 'Contacted', 'Resolved').required(),
  notes: Joi.string().trim().max(2000).allow(''),
  assignedOfficer: Joi.object({ name: Joi.string().trim().max(100), phone: Joi.string().pattern(/^[6-9]\d{9}$/), department: Joi.string().trim().max(100) }),
});

async function updateAlertStatus(req, res, next) {
  try {
    const { value, error } = updateSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.message });
    const alert = await EscalationAlert.findByIdAndUpdate(req.params.id, { $set: value }, { new: true, runValidators: true });
    if (!alert) return res.status(404).json({ error: 'Escalation alert not found' });
    return res.json({ alert });
  } catch (error) { return next(error); }
}

module.exports = { distressMap, alerts, seasonReplay, updateAlertStatus };
