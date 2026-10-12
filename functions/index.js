'use strict';

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const app = require('./src/app');

const kieApiKey = defineSecret('KIE_API_KEY');

exports.api = onRequest({ secrets: [kieApiKey] }, (req, res) => {
  app.locals.kieApiKey = kieApiKey.value();
  app(req, res);
});
