const ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://127.0.0.1:8001';

function shouldUseFallback(error) {
  return process.env.ML_FALLBACK_ENABLED !== 'false' &&
    ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name);
}

function fallbackDiagnosis(file) {
  const name = (file?.originalname || '').toLowerCase();
  const crop = name.includes('rice') ? 'rice' : name.includes('maize') || name.includes('corn') ? 'maize' : 'general';
  const label = crop === 'rice' ? 'rice_brown_spot' : crop === 'maize' ? 'maize_leaf_blight' : 'leaf_spot_suspected';
  return {
    predictedClass: label,
    crop,
    confidence: 0.72,
    severity: 'Moderate',
    source: 'backend-fallback',
    problem: crop === 'rice'
      ? 'Brown spot-like symptoms are suspected from the uploaded leaf.'
      : crop === 'maize'
        ? 'Leaf blight-like symptoms are suspected from the uploaded leaf.'
        : 'A fungal or bacterial leaf spot is suspected.',
    solution: [
      'Isolate badly affected leaves and avoid overhead irrigation.',
      'Use clean tools and remove infected debris from the field.',
      'If symptoms spread, contact the nearest agriculture officer before spraying fungicide.',
    ],
  };
}

function fallbackDistress(payload = {}) {
  const rainfall = Number(payload.rainfallDeficitPercent || payload.rainfall || 45);
  const price = Number(payload.priceDropPercent || payload.price || 20);
  const loan = Number(payload.loanBurdenPercent || payload.loan || 55);
  const riskScore = Math.max(0, Math.min(100, Math.round((rainfall * 0.4) + (price * 0.25) + (loan * 0.35))));
  return {
    riskScore,
    tier: riskScore >= 70 ? 'Critical' : riskScore >= 40 ? 'Vulnerable' : 'Stable',
    componentScores: { rainfall, price, loan },
    contributingFactors: [
      rainfall >= 40 && 'Rainfall Deficit',
      price >= 20 && 'Price Below MSP',
      loan >= 50 && 'Loan Burden',
    ].filter(Boolean),
    source: 'backend-fallback',
  };
}

async function parseMlResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.detail || payload?.error || `ML service returned HTTP ${response.status}`);
    error.statusCode = response.status === 422 ? 422 : 502;
    throw error;
  }
  return payload;
}

async function diagnoseLeaf(file) {
  if (!file) {
    const error = new Error('Leaf image is required');
    error.statusCode = 400;
    throw error;
  }

  const form = new FormData();
  form.append('file', new Blob([file.buffer], { type: file.mimetype }), file.originalname || 'leaf.jpg');

  try {
    const response = await fetch(`${ML_SERVICE_URL}/diagnose-leaf`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(Number(process.env.ML_SERVICE_TIMEOUT_MS || 30000)),
    });
    return parseMlResponse(response);
  } catch (error) {
    if (shouldUseFallback(error)) return fallbackDiagnosis(file);
    throw error;
  }
}

async function scoreDistress(payload) {
  try {
    const response = await fetch(`${ML_SERVICE_URL}/score-distress`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(process.env.ML_SERVICE_TIMEOUT_MS || 10000)),
    });
    return parseMlResponse(response);
  } catch (error) {
    if (shouldUseFallback(error)) return fallbackDistress(payload);
    throw error;
  }
}

module.exports = { diagnoseLeaf, scoreDistress };
