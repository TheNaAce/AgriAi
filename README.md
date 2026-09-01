# Smart Crop Advisory API

Production-oriented Express/MongoDB backend for PS-02, including passwordless OTP login, weather and mandi intelligence, multilingual advisories, risk scoring, and agricultural-officer escalation workflows.

## Run


1. Run `npm install` with Node.js 18 or later.
2. Create `.env` with local values such as:

```env
NODE_ENV=development
PORT=5000
MONGODB_URI=mongodb://127.0.0.1:27017/agri-ai
JWT_SECRET=agri-ai-local-dev-secret-change-before-production
ADMIN_API_KEY=dev-admin-key
FAST2SMS_ENABLED=false
ML_SERVICE_URL=http://127.0.0.1:8001
```

3. Run `npm run dev` (or `npm start`).

Redis is optional: if it cannot connect, the service uses an expiring in-memory cache. Set `FAST2SMS_ENABLED=true` and `FAST2SMS_API_KEY` for real SMS; development mode logs a sandbox OTP instead.

Set `ML_SERVICE_URL=http://127.0.0.1:8001` to connect this backend to the Python ML/CV service in `AgriAI/ml`.

In development, `POST /api/v1/auth/send-otp` also returns `sandboxOtp` in the JSON response, so the frontend can auto-fill the OTP while no SMS provider is configured. Leaf diagnosis and distress scoring use deterministic backend fallbacks if the Python ML service is offline; set `ML_FALLBACK_ENABLED=false` to require the real ML service.

## Agricultural data reliability

Weather and modelled soil measurements use Open-Meteo's forecast API. Each seven-day rainfall forecast is compared with a location-specific, ten-year historical precipitation baseline from Open-Meteo's archive API. Forecast data is cached for one hour and historical baselines for 30 days. The payload declares `dataQuality` as `verified-historical-baseline`, `degraded-baseline`, or `stale-fallback`; critical workflows can act conservatively when the quality is degraded.

## API surface

- `POST /api/v1/auth/send-otp`, `POST /api/v1/auth/verify-otp`
- `POST /api/v1/farmer/onboard`, `GET /api/v1/farmer/profile`, `GET /api/v1/farmer/dashboard`, `POST /api/v1/farmer/trigger-risk-eval`
- `POST /api/v1/farmer/diagnose-leaf` with multipart form field `file`
- `POST /api/v1/farmer/score-distress`
- `GET /api/v1/admin/distress-map`, `GET /api/v1/admin/alerts`, `PATCH /api/v1/admin/alerts/:id/status`

Farmer routes require `Authorization: Bearer <JWT>`. Admin routes require `X-Admin-API-Key`; put this behind your organization’s identity gateway in production.
