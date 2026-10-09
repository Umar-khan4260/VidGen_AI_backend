const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// Initialize Firebase Admin (only once)
initializeApp();
const db = getFirestore();

module.exports = {
  db,
  FieldValue
};
