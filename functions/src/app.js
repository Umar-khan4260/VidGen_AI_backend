const express = require('express');
const routes = require('./routes');

const app = express();

app.use(express.json({ limit: '25mb' }));

app.use((req, res, next) => {
  if (req.app.locals.kieApiKey) {
    req.kieApiKey = req.app.locals.kieApiKey;
  }
  next();
});

app.use('/api', routes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Return clean JSON for errors thrown before/outside controllers (e.g. multer
// rejecting an oversized upload), so the client can always parse the response.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: `Upload rejected: ${err.message}`, code: err.code });
  }
  console.error('Unhandled error:', err);
  return res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
