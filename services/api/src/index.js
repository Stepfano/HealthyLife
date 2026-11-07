import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import { MongoClient } from 'mongodb';

const app = express();
const port = Number(process.env.PORT || 4000);
const isProduction = process.env.NODE_ENV === 'production';
const secret = process.env.JWT_SECRET;
const mongoUri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DATABASE || 'healthylife';
const allowedOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (isProduction && (!secret || secret.length < 32)) {
  throw new Error('Set JWT_SECRET to a random value of at least 32 characters.');
}

const signingSecret = secret || 'local-dev-secret-change-before-deployment';
const memory = {
  users: new Map(),
  favorites: new Map(),
  activities: new Map(),
  watches: new Map(),
};

let collections = null;
let mongoClient = null;

app.use(cors({
  origin(origin, callback) {
    const allowed = !origin
      || (!isProduction && allowedOrigins.length === 0)
      || allowedOrigins.includes(origin);
    callback(null, allowed);
  },
}));
app.use(express.json({ limit: '32kb' }));

function fail(res, status, error) {
  return res.status(status).json({ error });
}

function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return fail(res, 401, 'Silakan masuk terlebih dahulu.');
    req.user = jwt.verify(token, signingSecret);
    return next();
  } catch {
    return fail(res, 401, 'Sesi berakhir. Silakan masuk kembali.');
  }
}

const store = {
  async findUserByEmail(email) {
    if (collections) return collections.users.findOne({ email });
    return [...memory.users.values()].find((user) => user.email === email) || null;
  },
  async findUserById(id) {
    if (collections) return collections.users.findOne({ _id: id });
    return memory.users.get(id) || null;
  },
  async createUser(user) {
    if (collections) {
      await collections.users.insertOne({ ...user, _id: user.id });
      return;
    }
    memory.users.set(user.id, user);
  },
  async getFavorites(userId) {
    if (collections) {
      const document = await collections.favorites.findOne({ _id: userId });
      return document?.items || [];
    }
    return memory.favorites.get(userId) || [];
  },
  async setFavorites(userId, items) {
    if (collections) {
      await collections.favorites.updateOne(
        { _id: userId },
        { $set: { items } },
        { upsert: true },
      );
      return;
    }
    memory.favorites.set(userId, items);
  },
  async getActivities(userId) {
    if (collections) {
      const document = await collections.activities.findOne({ _id: userId });
      return document?.items || [];
    }
    return memory.activities.get(userId) || [];
  },
  async addActivity(userId, activity) {
    if (collections) {
      await collections.activities.updateOne(
        { _id: userId },
        { $push: { items: { $each: [activity], $position: 0, $slice: 100 } } },
        { upsert: true },
      );
      return collections.activities.findOne({ _id: userId });
    }
    const items = memory.activities.get(userId) || [];
    items.unshift(activity);
    memory.activities.set(userId, items.slice(0, 100));
    return { items: memory.activities.get(userId) };
  },
  async getWatch(userId) {
    if (collections) {
      const document = await collections.watches.findOne({ _id: userId });
      if (!document) return null;
      const { _id, ...watch } = document;
      return watch;
    }
    return memory.watches.get(userId) || null;
  },
  async setWatch(userId, watch) {
    if (collections) {
      await collections.watches.updateOne(
        { _id: userId },
        { $set: watch },
        { upsert: true },
      );
      return;
    }
    memory.watches.set(userId, watch);
  },
};

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'healthylife-api', database: collections ? 'atlas' : 'memory' });
});

app.post('/api/auth/register', async (req, res, next) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
    return fail(res, 400, 'Periksa nama, email, dan kata sandi (minimal 8 karakter).');
  }

  try {
    const user = { id: randomUUID(), name, email, passwordHash: await bcrypt.hash(password, 10) };
    await store.createUser(user);
    const token = jwt.sign({ sub: user.id }, signingSecret, { expiresIn: '7d' });
    return res.status(201).json({ token, user: { id: user.id, name, email } });
  } catch (error) {
    if (error.code === 11000) return fail(res, 409, 'Email sudah terdaftar. Silakan masuk.');
    return next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = await store.findUserByEmail(email);
    if (!user || !await bcrypt.compare(password, user.passwordHash)) {
      return fail(res, 401, 'Email atau kata sandi tidak sesuai.');
    }
    const token = jwt.sign({ sub: user.id || user._id }, signingSecret, { expiresIn: '7d' });
    return res.json({ token, user: { id: user.id || user._id, name: user.name, email: user.email } });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/me', auth, async (req, res, next) => {
  try {
    const user = await store.findUserById(req.user.sub);
    if (!user) return fail(res, 404, 'Akun tidak ditemukan.');
    return res.json({ user: { id: user.id || user._id, name: user.name, email: user.email } });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/favorites', auth, async (req, res, next) => {
  try {
    return res.json({ favorites: await store.getFavorites(req.user.sub) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/favorites', auth, async (req, res, next) => {
  const contentId = String(req.body.contentId || '');
  if (!/^a[1-9]\d*$/.test(contentId)) return fail(res, 400, 'Konten tidak valid.');
  try {
    const current = await store.getFavorites(req.user.sub);
    const exists = current.includes(contentId);
    const favorites = exists ? current.filter((id) => id !== contentId) : [...current, contentId];
    await store.setFavorites(req.user.sub, favorites);
    return res.json({ saved: !exists, favorites });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/activities', auth, async (req, res, next) => {
  try {
    return res.json({ activities: await store.getActivities(req.user.sub) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/activities', auth, async (req, res, next) => {
  const title = String(req.body.title || '').trim();
  const minutes = Number(req.body.minutes);
  if (!title || title.length > 100 || !Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    return fail(res, 400, 'Data aktivitas tidak valid.');
  }
  try {
    const activity = {
      id: randomUUID(),
      title,
      minutes,
      source: req.body.source === 'watch' ? 'watch' : 'manual',
      createdAt: new Date().toISOString(),
    };
    const result = await store.addActivity(req.user.sub, activity);
    return res.status(201).json({ activities: result.items });
  } catch (error) {
    return next(error);
  }
});

app.get('/api/watch', auth, async (req, res, next) => {
  try {
    return res.json({ watch: await store.getWatch(req.user.sub) });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/watch/sync', auth, async (req, res, next) => {
  const steps = Number(req.body.steps);
  const activeMinutes = Number(req.body.activeMinutes);
  if (!Number.isInteger(steps) || steps < 0 || steps > 200000
    || !Number.isInteger(activeMinutes) || activeMinutes < 0 || activeMinutes > 1440) {
    return fail(res, 400, 'Ringkasan kesehatan tidak valid.');
  }
  try {
    const watch = {
      connected: true,
      provider: String(req.body.provider || 'HealthKit / Health Connect'),
      steps,
      activeMinutes,
      lastSync: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
    };
    await store.setWatch(req.user.sub, watch);
    const result = await store.addActivity(req.user.sub, {
      id: randomUUID(),
      title: `Sinkron langkah smartwatch · ${steps.toLocaleString('id-ID')} langkah`,
      minutes: activeMinutes,
      source: 'watch',
      createdAt: new Date().toISOString(),
    });
    return res.json({ watch, activities: result.items });
  } catch (error) {
    return next(error);
  }
});

app.post('/api/watch', auth, async (req, res, next) => {
  try {
    const watch = {
      connected: Boolean(req.body.connected),
      provider: String(req.body.provider || 'HealthKit / Health Connect'),
      steps: 0,
      activeMinutes: 0,
      lastSync: null,
    };
    await store.setWatch(req.user.sub, watch);
    return res.json({ watch });
  } catch (error) {
    return next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error('API request failed:', error.message);
  return res.status(500).json({ error: 'Terjadi kendala pada server.' });
});

async function start() {
  if (mongoUri) {
    mongoClient = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 10000 });
    await mongoClient.connect();
    const database = mongoClient.db(databaseName);
    collections = {
      users: database.collection('users'),
      favorites: database.collection('favorites'),
      activities: database.collection('activities'),
      watches: database.collection('watches'),
    };
    await collections.users.createIndex({ email: 1 }, { unique: true });
    console.log(`Connected to MongoDB database "${databaseName}"`);
  } else if (isProduction) {
    throw new Error('MONGODB_URI is required in production.');
  } else {
    console.warn('MONGODB_URI is unset; using a temporary in-memory store.');
  }

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`HealthyLife API listening on port ${port}`);
  });

  async function shutdown() {
    server.close();
    await mongoClient?.close();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((error) => {
  console.error('API failed to start:', error.message);
  process.exit(1);
});
