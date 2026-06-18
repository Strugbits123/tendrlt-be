const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const authRoutes     = require('./routes/auth');
const providersRoutes = require('./routes/providers');
const servicesRoutes  = require('./routes/services');
const tendersRoutes   = require('./routes/tenders');
const adminRoutes     = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 5000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// ── CORS allow-list ──────────────────────────────────────────────
// credentials:true forbids a wildcard origin, so we must reflect the
// specific request origin when it's allowed. We allow:
//   • localhost (any port) for local dev
//   • FRONTEND_URL and any comma-separated ALLOWED_ORIGINS from env
//   • any https://*.tendrit.com subdomain (staging, app, admin, etc.) + the apex
// This fixes production where the frontend is served from staging.tendrit.com
// but FRONTEND_URL points at a single different origin.
const explicitOrigins = new Set(
  [FRONTEND_URL, ...(process.env.ALLOWED_ORIGINS || '').split(',')]
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

const isAllowedOrigin = (origin) => {
  if (!origin) return true; // same-origin / curl / server-to-server
  const clean = origin.replace(/\/$/, '');
  if (explicitOrigins.has(clean)) return true;
  try {
    const { protocol, hostname } = new URL(clean);
    if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
    // tendrit.com and any subdomain, https only
    if (protocol === 'https:' && (hostname === 'tendrit.com' || hostname.endsWith('.tendrit.com'))) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

const connectionString = process.env.DATABASE_URL;
// Middlewares
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // ensure preflight (OPTIONS) is handled for all routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Static files (if needed)
app.use(express.static(path.join(__dirname, 'public')));

// Mount routes
app.use('/api/auth',      authRoutes);
app.use('/api/providers', providersRoutes);
app.use('/api/services',  servicesRoutes);
app.use('/api/tenders',   tendersRoutes);
app.use('/api/admin',     adminRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// Root route
app.get('/', (req, res) => {
  res.send(`TendrIt Backend API is running.`);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err.stack);
  res.status(500).json({ success: false, message: 'Something went wrong on the server!' });
});

// Start Server
app.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(`  TendrIt Auth Backend Service started   `);
  console.log(`  Listening on port: ${PORT}             `);
  console.log(`  CORS allow-list: ${[...explicitOrigins].join(', ')} + *.tendrit.com`);
  console.log(`=========================================`);
});
