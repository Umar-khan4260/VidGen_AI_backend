const { getAuth } = require('firebase-admin/auth');

const verifyFirebaseAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split('Bearer ')[1];
  // console.log('Verifying Firebase token:', token); // Log the token for debugging

  try {
    const decodedToken = await getAuth().verifyIdToken(token);
    req.auth = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

module.exports = { verifyFirebaseAuth };
