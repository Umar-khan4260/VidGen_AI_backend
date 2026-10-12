const express = require('express');
const routes = require('./routes');

const app = express();

app.use(express.json());

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

module.exports = app;
