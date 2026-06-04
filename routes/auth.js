const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const db = require('../db');
const { authenticate } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

/**
 * Cookie options helper
 */
const getCookieOptions = () => {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  };
};

/**
 * Helper to generate JWT and set token cookie
 */
const setTokenCookie = (res, userId) => {
  const token = jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.cookie('token', token, getCookieOptions());
  return token;
};

/**
 * POST /api/auth/register
 * Register a user via email/password
 */
router.post('/register', async (req, res) => {
  const { email, password, first_name, last_name, phone_number, parish, role, provider_service } = req.body;

  if (!email || !password || !first_name || !last_name || !phone_number || !parish || !role) {
    return res.status(400).json({ success: false, message: 'Please fill in all required fields.' });
  }

  // Validate role
  const allowedRoles = ['homeowner', 'provider'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ success: false, message: 'Invalid user role selected.' });
  }

  try {
    // Check if user exists
    const userExist = await db.query('SELECT id FROM public.users WHERE email = $1', [email.toLowerCase()]);
    if (userExist.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'An account with this email address already exists.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    // Insert user
    const insertQuery = `
      INSERT INTO public.users (
        email, password_hash, first_name, last_name, phone_number, parish, role, provider_service, is_email_verified
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true) -- Email verification is marked true for mock flow
      RETURNING id, email, first_name, last_name, role, provider_service, avatar_url;
    `;
    const result = await db.query(insertQuery, [
      email.toLowerCase(),
      passwordHash,
      first_name,
      last_name,
      phone_number,
      parish,
      role,
      role === 'provider' ? provider_service : null
    ]);

    const user = result.rows[0];
    
    // Set cookie
    setTokenCookie(res, user.id);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      user
    });
  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error during registration.' });
  }
});

/**
 * POST /api/auth/login
 * Sign in a user via email/password
 */
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Please enter both email and password.' });
  }

  try {
    // Find user
    const result = await db.query(
      'SELECT id, email, password_hash, first_name, last_name, role, provider_service, avatar_url, phone_number, parish FROM public.users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid email or password.' });
    }

    const user = result.rows[0];

    // Check if it is a Google-only user
    if (!user.password_hash) {
      return res.status(400).json({ 
        success: false, 
        message: 'This email is linked to a Google account. Please use "Continue with Google" to sign in.' 
      });
    }

    // Verify password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid email or password.' });
    }

    // Set cookie
    setTokenCookie(res, user.id);

    // Remove password hash from response
    delete user.password_hash;

    return res.json({
      success: true,
      message: 'Sign in successful.',
      user
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error during login.' });
  }
});

/**
 * GET /api/auth/google
 * Redirect user to Google OAuth Concent screen
 */
router.get('/google', (req, res) => {
  const role = req.query.role || 'homeowner';
  
  const rootUrl = 'https://accounts.google.com/o/oauth2/v2/auth';
  const options = {
    redirect_uri: process.env.GOOGLE_CALLBACK_URL,
    client_id: process.env.GOOGLE_CLIENT_ID,
    access_type: 'offline',
    response_type: 'code',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/userinfo.email'
    ].join(' '),
    state: JSON.stringify({ role })
  };

  const qs = new URLSearchParams(options).toString();
  res.redirect(`${rootUrl}?${qs}`);
});

/**
 * GET /api/auth/google/callback
 * Handle Google OAuth redirection
 */
router.get('/google/callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state ? JSON.parse(req.query.state) : { role: 'homeowner' };
  const roleFromState = state.role || 'homeowner';

  if (!code) {
    return res.redirect(`${FRONTEND_URL}/auth?error=google_auth_failed`);
  }

  try {
    // 1. Exchange code for tokens
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    const values = {
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_CALLBACK_URL,
      grant_type: 'authorization_code'
    };

    const tokenRes = await axios.post(tokenUrl, new URLSearchParams(values).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const { access_token, id_token } = tokenRes.data;

    // 2. Fetch User Profile from Google
    const profileRes = await axios.get(
      `https://www.googleapis.com/oauth2/v3/userinfo?alt=json&access_token=${access_token}`,
      { headers: { Authorization: `Bearer ${id_token}` } }
    );

    const googleUser = profileRes.data; // sub, name, given_name, family_name, picture, email, email_verified

    // 3. Find or Create User in database
    // Find by google_id first
    let userRes = await db.query('SELECT * FROM public.users WHERE google_id = $1', [googleUser.sub]);
    let isNewUser = false;
    let user = null;

    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
    } else {
      // Find by email next (link accounts if they signed up by email previously)
      userRes = await db.query('SELECT * FROM public.users WHERE email = $1', [googleUser.email.toLowerCase()]);
      
      if (userRes.rows.length > 0) {
        user = userRes.rows[0];
        // Link Google ID to existing email account
        await db.query(
          'UPDATE public.users SET google_id = $1, avatar_url = COALESCE(avatar_url, $2) WHERE id = $3',
          [googleUser.sub, googleUser.picture, user.id]
        );
        user.google_id = googleUser.sub;
        if (!user.avatar_url) user.avatar_url = googleUser.picture;
      } else {
        // Create partial user (requires complete-profile step)
        isNewUser = true;
        const insertQuery = `
          INSERT INTO public.users (
            email, first_name, last_name, role, google_id, avatar_url, is_email_verified
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING *;
        `;
        const newUserRes = await db.query(insertQuery, [
          googleUser.email.toLowerCase(),
          googleUser.given_name || googleUser.name || 'Google',
          googleUser.family_name || 'User',
          roleFromState,
          googleUser.sub,
          googleUser.picture,
          googleUser.email_verified || true
        ]);
        user = newUserRes.rows[0];
      }
    }

    // 4. Set session token cookie
    setTokenCookie(res, user.id);

    // 5. Redirect based on completeness of profile
    const isProfileIncomplete = !user.phone_number || !user.parish;
    
    if (isProfileIncomplete || isNewUser) {
      const nameParam = encodeURIComponent(`${user.first_name} ${user.last_name}`);
      res.redirect(`${FRONTEND_URL}/complete-profile?role=${user.role}&name=${nameParam}`);
    } else {
      const redirectPath = user.role === 'provider' ? '/provider-browse' : '/dashboard';
      res.redirect(`${FRONTEND_URL}${redirectPath}`);
    }
  } catch (err) {
    console.error('Google OAuth callback error:', err.response?.data || err.message);
    res.redirect(`${FRONTEND_URL}/auth?error=google_auth_failed`);
  }
});

/**
 * POST /api/auth/complete-profile
 * Complete user profile (for Google OAuth users or onboarding)
 */
router.post('/complete-profile', authenticate, async (req, res) => {
  const { phone_number, parish, role, provider_service } = req.body;

  if (!phone_number || !parish || !role) {
    return res.status(400).json({ success: false, message: 'Phone number, parish, and role are required.' });
  }

  const allowedRoles = ['homeowner', 'provider'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ success: false, message: 'Invalid role selected.' });
  }

  try {
    const updateQuery = `
      UPDATE public.users
      SET phone_number = $1, parish = $2, role = $3, provider_service = $4
      WHERE id = $5
      RETURNING id, email, first_name, last_name, role, provider_service, phone_number, parish, avatar_url;
    `;

    const result = await db.query(updateQuery, [
      phone_number,
      parish,
      role,
      role === 'provider' ? provider_service : null,
      req.user.id
    ]);

    return res.json({
      success: true,
      message: 'Profile completed successfully.',
      user: result.rows[0]
    });
  } catch (err) {
    console.error('Complete profile error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error completing profile.' });
  }
});

/**
 * GET /api/auth/me
 * Retrieve the current authenticated user profile
 */
router.get('/me', authenticate, (req, res) => {
  return res.json({
    success: true,
    user: req.user
  });
});

/**
 * POST /api/auth/logout
 * Log out and clear session cookie
 */
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
  });
  return res.json({ success: true, message: 'Logged out successfully.' });
});

module.exports = router;
