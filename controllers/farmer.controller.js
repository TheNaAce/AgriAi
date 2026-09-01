const Joi = require('joi');
const Farmer = require('../models/Farmer');
const EscalationAlert = require('../models/EscalationAlert');
const { getWeatherAndSoilData, getMandiPrices } = require('../services/agriDataService');
const { createAdvisory } = require('../services/advisoryService');
const { evaluateFarmer } = require('../services/riskEvaluationService');
const mlService = require('../services/mlService');

const profileSchema = Joi.object({
  name: Joi.string().trim().min(2).max(100).required(),
  language: Joi.string().valid('en', 'hi', 'or', 'te').default('or'),
  location: Joi.object({
    state: Joi.string().trim().max(80).required(), district: Joi.string().trim().max(80).required(), block: Joi.string().trim().max(80).required(),
    coordinates: Joi.object({ type: Joi.string().valid('Point').required(), coordinates: Joi.array().ordered(Joi.number().min(-180).max(180), Joi.number().min(-90).max(90)).length(2).required() }).required(),
  }).required(),
  cropDetails: Joi.object({ cropName: Joi.string().trim().max(80).required(), sowingDate: Joi.date().max('now').required(), acreage: Joi.number().positive().max(100000).required(), stage: Joi.string().valid('Sowing', 'Vegetative', 'Flowering', 'Harvesting').required() }).required(),
  financials: Joi.object({ loanAmount: Joi.number().min(0).default(0), dueDate: Joi.date().allow(null), lenderType: Joi.string().valid('Bank', 'Cooperative', 'Moneylender', 'SHG', 'None').default('None'), insured: Joi.boolean().default(false) }).default(),
});

const reminderSchema = Joi.object({
  bankName: Joi.string().trim().max(120).required(),
  loanAmount: Joi.number().positive().required(),
  dueDate: Joi.date().required(),
});

function cropGuidanceFor(district = 'your district') {
  return {
    district,
    updatedAt: new Date().toISOString(),
    crops: [
      {
        crop: 'Rice',
        season: 'Kharif',
        pricePerQuintal: 2180,
        confidence: 91,
        reason: 'Best when monsoon is normal and irrigation support exists. Demand is steady in local mandis.',
        failureRisk: 'Heavy rainfall can cause lodging, brown spot, sheath blight, and delayed harvest.',
        action: 'Use raised nursery beds, drain standing water within 24 hours, and report leaf symptoms early.',
        schemes: ['PMFBY crop insurance', 'State disaster relief for crop loss', 'Kisan Credit Card restructuring'],
      },
      {
        crop: 'Maize',
        season: 'Rabi',
        pricePerQuintal: 2090,
        confidence: 84,
        reason: 'Good option after paddy when water is limited and market demand is stable.',
        failureRisk: 'High rainfall can increase leaf blight and pest pressure; drought can reduce cob filling.',
        action: 'Choose short-duration seed, monitor whorl damage weekly, and compare mandi price before bulk sale.',
        schemes: ['Seed subsidy support', 'PM-KISAN income support', 'Integrated pest management support'],
      },
      {
        crop: 'Green gram',
        season: 'Summer',
        pricePerQuintal: 8558,
        confidence: 78,
        reason: 'Short-duration crop with higher per-quintal value where residual moisture is available.',
        failureRisk: 'Unexpected rain during flowering can cause flower drop and fungal disease.',
        action: 'Prefer well-drained plots, sow after moisture check, and avoid distress selling below benchmark price.',
        schemes: ['National Food Security Mission pulses', 'Warehouse receipt support', 'PMFBY where notified'],
      },
    ],
  };
}

function villageBroadcastFor(farmer) {
  const crop = farmer.cropDetails?.cropName || 'Crop';
  const district = farmer.location?.district || 'your village';
  return {
    village: `${district} cluster`,
    crop,
    severity: 'Moderate',
    affectedFarmers: 18,
    message: `${district} has rising ${crop.toLowerCase()} leaf disease reports this week.`,
    updatedAt: new Date().toISOString(),
  };
}

async function onboard(req, res, next) {
  try {
    const { value, error } = profileSchema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ error: error.message });
    const farmer = await Farmer.findByIdAndUpdate(req.user.farmerId, { $set: value }, { new: true, runValidators: true });
    if (!farmer) return res.status(404).json({ error: 'Farmer session no longer exists' });
    return res.status(200).json({ farmer });
  } catch (error) { return next(error); }
}

async function profile(req, res, next) {
  try {
    const farmer = await Farmer.findById(req.user.farmerId).lean();
    if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
    return res.json({ farmer });
  } catch (error) { return next(error); }
}

async function dashboard(req, res, next) {
  try {
    const farmer = await Farmer.findById(req.user.farmerId).lean();
    if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
    const [lng, lat] = farmer.location?.coordinates?.coordinates || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !farmer.cropDetails?.cropName) return res.status(422).json({ error: 'Complete onboarding with location and crop details first' });
    const [weatherResult, marketResult] = await Promise.allSettled([
      getWeatherAndSoilData(lat, lng), getMandiPrices(farmer.cropDetails.cropName, farmer.location.district),
    ]);
    const weather = weatherResult.status === 'fulfilled' ? weatherResult.value : null;
    const market = marketResult.status === 'fulfilled' ? marketResult.value : null;
    if (!weather && !market) return res.status(503).json({ error: 'Agricultural data services are temporarily unavailable' });
    const advisory = weather ? createAdvisory({ weather, market, cropStage: farmer.cropDetails.stage, language: farmer.language }) : null;
    return res.json({ farmer: { name: farmer.name, language: farmer.language, crop: farmer.cropDetails, risk: farmer.distressProfile }, weather, market, advisory, unavailable: [!weather && 'weather', !market && 'market'].filter(Boolean) });
  } catch (error) { return next(error); }
}

async function triggerRiskEval(req, res, next) {
  try { return res.json({ evaluation: await evaluateFarmer(req.user.farmerId) }); } catch (error) { return next(error); }
}

async function cropGuidance(req, res, next) {
  try {
    const farmer = await Farmer.findById(req.user.farmerId).lean();
    return res.json(cropGuidanceFor(farmer?.location?.district));
  } catch (error) { return next(error); }
}

async function villageBroadcast(req, res, next) {
  try {
    const farmer = await Farmer.findById(req.user.farmerId).lean();
    if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
    return res.json(villageBroadcastFor(farmer));
  } catch (error) { return next(error); }
}

async function createLoanReminder(req, res, next) {
  try {
    const { value, error } = reminderSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.message });
    const monthlyAmount = Math.ceil(value.loanAmount / 12);
    return res.status(201).json({
      reminder: {
        ...value,
        monthlyAmount,
        nextReminder: value.dueDate.toISOString().slice(0, 10),
        message: `Monthly repayment reminder set for ${value.bankName}. Expected payment: Rs ${monthlyAmount}.`,
        notificationMode: 'pwa-local',
      },
    });
  } catch (error) { return next(error); }
}

async function diagnoseLeaf(req, res, next) {
  try {
    const diagnosis = await mlService.diagnoseLeaf(req.file);
    return res.json({ diagnosis });
  } catch (error) { return next(error); }
}

async function scoreDistress(req, res, next) {
  try {
    const scoring = await mlService.scoreDistress(req.body);
    const farmer = await Farmer.findByIdAndUpdate(req.user.farmerId, { $set: {
      'distressProfile.riskScore': scoring.riskScore,
      'distressProfile.tier': scoring.tier,
      'distressProfile.contributingFactors': scoring.contributingFactors || [],
      'distressProfile.lastEvaluated': new Date(),
    } }, { new: true, runValidators: true }).lean();
    if (farmer && scoring.tier === 'Critical') {
      await EscalationAlert.findOneAndUpdate(
        { farmerId: farmer._id, status: { $in: ['Pending', 'Assigned', 'Contacted'] } },
        { $set: { district: farmer.location?.district || 'Unspecified', riskScore: scoring.riskScore, triggerReasons: scoring.contributingFactors || [] }, $setOnInsert: { farmerId: farmer._id, status: 'Pending' } },
        { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
      );
    }
    return res.json({ scoring });
  } catch (error) { return next(error); }
}

module.exports = { onboard, profile, dashboard, cropGuidance, villageBroadcast, createLoanReminder, triggerRiskEval, diagnoseLeaf, scoreDistress };
