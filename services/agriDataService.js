const cache = require('./cacheService');

const WEATHER_TTL_SECONDS = 60 * 60;
const BASELINE_TTL_SECONDS = 30 * 24 * 60 * 60;
const lastKnownWeather = new Map();

const MSP = {
  paddy: 2300, rice: 2300, cotton: 7121, groundnut: 6783, sugarcane: 340,
  wheat: 2425, maize: 2400, soybean: 4892, tur: 7550, gram: 5650,
};

function cacheKey(...parts) {
  return `agri:${parts.map((part) => String(part).toLowerCase().replace(/[^a-z0-9.-]/g, '_')).join(':')}`;
}

function dateOnly(value) { return value.toISOString().slice(0, 10); }

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function validateCoordinates(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    const error = new Error('Valid latitude and longitude are required');
    error.statusCode = 400;
    throw error;
  }
}

async function fetchJson(url, { timeoutMs = Number(process.env.OPEN_METEO_TIMEOUT_MS || 8_000), retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (!response.ok) {
        const error = new Error(`Open-Meteo returned HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (!error.retryable && error.name !== 'TimeoutError' && error.name !== 'AbortError') break;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  throw lastError;
}

function normalizeHourly(hourly) {
  const times = hourly.time;
  const required = ['temperature_2m', 'relative_humidity_2m', 'precipitation', 'soil_moisture_0_to_1cm', 'soil_temperature_0_to_7cm'];
  if (!Array.isArray(times) || !times.length || required.some((key) => !Array.isArray(hourly[key]) || hourly[key].length !== times.length)) {
    throw new Error('Open-Meteo response is missing required hourly weather or soil fields');
  }
  return times.map((time, i) => ({
    time,
    temperature: Number(hourly.temperature_2m[i]),
    humidity: Number(hourly.relative_humidity_2m[i]),
    precipitation: Number(hourly.precipitation[i]),
    soilMoisture: Number(hourly.soil_moisture_0_to_1cm[i]),
    soilTemperature: Number(hourly.soil_temperature_0_to_7cm[i]),
  }));
}

function average(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }

function firstForecastDate(hours) {
  const raw = hours[0]?.time;
  const parsed = typeof raw === 'string' && !/[zZ]|[+-]\d{2}:\d{2}$/.test(raw)
    ? new Date(`${raw}Z`)
    : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

async function getHistoricalRainfallBaseline(lat, lng, currentDate = new Date()) {
  const startYear = currentDate.getUTCFullYear() - 10;
  const endYear = currentDate.getUTCFullYear() - 1;
  const start = new Date(Date.UTC(startYear, currentDate.getUTCMonth(), currentDate.getUTCDate()));
  const end = addDays(new Date(Date.UTC(endYear, currentDate.getUTCMonth(), currentDate.getUTCDate())), 6);
  const key = cacheKey('rainfall-baseline-v2', lat.toFixed(2), lng.toFixed(2), currentDate.getUTCMonth() + 1, currentDate.getUTCDate());
  const cached = await cache.get(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    latitude: String(lat), longitude: String(lng), start_date: dateOnly(start), end_date: dateOnly(end),
    // Best-match selects the complete reanalysis source for the requested grid cell.
    // Explicit ERA5-Land can return null precipitation for some Indian locations.
    daily: 'precipitation_sum', timezone: 'UTC',
  });
  const archiveUrl = process.env.OPEN_METEO_ARCHIVE_URL || 'https://archive-api.open-meteo.com/v1/archive';
  const raw = await fetchJson(`${archiveUrl}?${params}`, { retries: 1 });
  const daily = raw.daily;
  if (!Array.isArray(daily?.time) || !Array.isArray(daily.precipitation_sum) || daily.time.length !== daily.precipitation_sum.length) {
    throw new Error('Open-Meteo historical response is missing daily precipitation');
  }
  const precipitationByDate = new Map(daily.time.map((date, index) => [date, daily.precipitation_sum[index]]));
  const sevenDayTotals = [];
  for (let year = startYear; year <= endYear; year += 1) {
    const periodStart = new Date(Date.UTC(year, currentDate.getUTCMonth(), currentDate.getUTCDate()));
    const values = Array.from({ length: 7 }, (_, day) => precipitationByDate.get(dateOnly(addDays(periodStart, day))));
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
    const total = values.reduce((sum, value) => sum + value, 0);
    if (Number.isFinite(total)) sevenDayTotals.push(total);
  }
  if (sevenDayTotals.length < 5) throw new Error('Insufficient historical rainfall coverage for baseline');
  const result = { precipitation7dBaselineMm: Number(average(sevenDayTotals).toFixed(1)), years: sevenDayTotals.length, source: 'open-meteo-archive' };
  await cache.set(key, result, BASELINE_TTL_SECONDS);
  return result;
}

async function getWeatherAndSoilData(lat, lng) {
  validateCoordinates(lat, lng);
  const key = cacheKey('weather-v2', lat.toFixed(3), lng.toFixed(3));
  const cached = await cache.get(key);
  if (cached) return cached;

  try {
    const params = new URLSearchParams({
      latitude: String(lat), longitude: String(lng), timezone: 'auto', forecast_days: '7',
      hourly: 'temperature_2m,relative_humidity_2m,precipitation,soil_moisture_0_to_1cm,soil_moisture_1_to_3cm,soil_temperature_0_to_7cm',
    });
    const forecastUrl = process.env.OPEN_METEO_FORECAST_URL || 'https://api.open-meteo.com/v1/forecast';
    const raw = await fetchJson(`${forecastUrl}?${params}`, { retries: 2 });
    const hours = normalizeHourly(raw.hourly);
    const next24 = hours.slice(0, 24);
    const next7 = hours.slice(0, 168);
    if (next24.length < 24 || next7.length < 168) throw new Error('Open-Meteo forecast is shorter than the required seven days');
    const precipitation24h = next24.reduce((sum, hour) => sum + hour.precipitation, 0);
    const precipitation7d = next7.reduce((sum, hour) => sum + hour.precipitation, 0);

    let baseline;
    try {
      baseline = await getHistoricalRainfallBaseline(lat, lng, firstForecastDate(next7));
    } catch (error) {
      // Forecast remains useful if the historical endpoint is temporarily unavailable.
      baseline = { precipitation7dBaselineMm: Number(process.env.HISTORICAL_DAILY_RAINFALL_MM || 4) * 7, years: 0, source: 'configured-fallback' };
      console.warn('Historical rainfall baseline unavailable:', error.message);
    }
    const result = {
      temperatureC: Number(Math.max(...next24.map((hour) => hour.temperature)).toFixed(1)),
      humidityPercent: Math.round(average(next24.map((hour) => hour.humidity))),
      expectedPrecipitation24hMm: Number(precipitation24h.toFixed(1)),
      precipitation7dMm: Number(precipitation7d.toFixed(1)),
      precipitation7dBaselineMm: baseline.precipitation7dBaselineMm,
      precipitationAnomalyMm: Number((precipitation7d - baseline.precipitation7dBaselineMm).toFixed(1)),
      topsoilMoistureIndex: Number(average(next24.map((hour) => hour.soilMoisture)).toFixed(3)),
      soilTemperatureC: Number(average(next24.map((hour) => hour.soilTemperature)).toFixed(1)),
      flags: {
        heatwave: next24.some((hour) => hour.temperature > 40),
        heavyRain: precipitation24h > 35,
        drySpell: precipitation7d < baseline.precipitation7dBaselineMm * 0.4,
      },
      source: { forecast: 'open-meteo', historicalBaseline: baseline.source },
      dataQuality: baseline.source === 'configured-fallback' ? 'degraded-baseline' : 'verified-historical-baseline',
      observedAt: new Date().toISOString(),
    };
    await cache.set(key, result, WEATHER_TTL_SECONDS);
    lastKnownWeather.set(key, result);
    return result;
  } catch (error) {
    const stale = lastKnownWeather.get(key);
    if (stale) return { ...stale, dataQuality: 'stale-fallback', observedAt: new Date().toISOString() };
    error.statusCode = error.statusCode || 503;
    throw error;
  }
}

// Deterministic daily variation produces testable, realistic price movement while retaining a stable cached quote.
function getMandiPrices(cropName, district) {
  const crop = (cropName || '').trim().toLowerCase();
  const msp = MSP[crop] || 3000;
  const day = Math.floor(Date.now() / 86_400_000);
  const seed = [...`${crop}:${district || ''}:${day}`].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
  const volatilityPercent = ((seed % 4101) / 100) - 30;
  const currentPrice = Math.max(1, Math.round(msp * (1 + volatilityPercent / 100)));
  const deviationPercent = Number((((msp - currentPrice) / msp) * 100).toFixed(2));
  return Promise.resolve({ cropName, district, msp, currentPrice, deviationPercent, volatilityPercent: Number(volatilityPercent.toFixed(2)), market: 'Agmarknet simulation', quotedAt: new Date().toISOString() });
}

module.exports = { getWeatherAndSoilData, getHistoricalRainfallBaseline, getMandiPrices };
