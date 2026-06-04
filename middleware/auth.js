const jwt = require('jsonwebtoken');
const db = require('../db');

/**
 * Protect routes: Authenticates request and sets req.user
 */
async function authenticate(req, res, next) {
  let token = null;

  // 1. Check cookies first (HttpOnly cookies for frontend)
  if (req.cookies && req.cookies.token) {
    token = req.cookies.token;
  }
  // 2. Fallback to Authorization Header
  else if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Access denied. No session token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    
    // Fetch the user from the DB to make sure they still exist
    const userRes = await db.query(
      'SELECT id, email, first_name, last_name, role, provider_service, avatar_url, is_email_verified FROM public.users WHERE id = $1', 
      [decoded.id]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid session. User not found.' });
    }

    req.user = userRes.rows[0];
    next();
  } catch (err) {
    console.error('Authentication JWT error:', err.message);
    return res.status(401).json({ success: false, message: 'Invalid or expired session token.' });
  }
}

/**
 * Role authorization guard: restrict access to specific roles (e.g. 'admin')
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Unauthorized. Authentication required.' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        success: false, 
        message: `Forbidden. Role '${req.user.role}' is not authorized to access this resource.` 
      });
    }

    next();
  };
}

module.exports = {
  authenticate,
  authorize
};
