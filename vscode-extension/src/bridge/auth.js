const { randomUUID, timingSafeEqual } = require('node:crypto');

function createAuthToken() {
  return randomUUID();
}

function isAuthorized(req, authToken) {
  if (!authToken || typeof req.headers.authorization !== 'string') return false;

  const expected = Buffer.from(`Bearer ${authToken}`);
  const actual = Buffer.from(req.headers.authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

module.exports = {
  createAuthToken,
  isAuthorized,
};
