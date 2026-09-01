const { buildApp } = require('../server');
const { connectDatabase } = require('../config/db');
const { initCache } = require('../services/cacheService');

let ready;
function init() {
  if (!ready) {
    ready = Promise.all([connectDatabase(), initCache()]);
  }
  return ready;
}

const app = buildApp();

module.exports = async (req, res) => {
  await init();
  return app(req, res);
};