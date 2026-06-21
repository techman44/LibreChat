const rateLimit = require('express-rate-limit');
const { limiterCache } = require('@librechat/api');

const { CONNECTION_TEST_WINDOW = 1, CONNECTION_TEST_MAX = 10 } = process.env;
const windowMs = CONNECTION_TEST_WINDOW * 60 * 1000;
const max = CONNECTION_TEST_MAX;
const windowInMinutes = windowMs / 60000;
const message = `Too many connection tests, please try again after ${windowInMinutes} minute(s)`;

const limiterOptions = {
  windowMs,
  max,
  keyGenerator: (req) => req.user?.id,
  store: limiterCache('connection_test_limiter'),
  handler: (req, res) => res.status(429).json({ message }),
};

const connectionTestLimiter = rateLimit(limiterOptions);

module.exports = connectionTestLimiter;
