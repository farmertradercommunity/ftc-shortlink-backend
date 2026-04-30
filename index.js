require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const serverless = require('serverless-http');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const adminSecretEnv = process.env.ADMIN_SECRET;
const PORT = process.env.PORT || 3000;

if (!supabaseUrl || !supabaseKey || !adminSecretEnv) {
  console.warn('Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, ADMIN_SECRET');
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.set('trust proxy', true);
app.use(express.json());

// FIX CORS (WAJIB)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }

  next();
});
app.options('*', cors());

const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak request, coba lagi nanti.' }
});

const redirectLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false
});

function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== adminSecretEnv) {
    return res.status(401).json({ error: 'Unauthorized. Header x-admin-secret salah.' });
  }
  next();
}

function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    null
  );
}

function isValidSlug(slug) {
  return /^[a-zA-Z0-9\-_]{1,60}$/.test(slug);
}

function normalizeSlug(slug) {
  return String(slug || '').trim().toLowerCase();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'ftc-shortlink-backend' });
});

app.get('/api/links', requireAdmin, async (req, res) => {
  try {
    const { search, limit = 100, offset = 0 } = req.query;

    let query = supabase
      .from('links_with_clicks')
      .select('*')
      .order('created_at', { ascending: false })
      .range(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 100) - 1);

    if (search) {
      query = query.ilike('slug', `%${search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('GET /api/links error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/links/:slug/logs', requireAdmin, async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);

    const { data: link, error: linkErr } = await supabase
      .from('links')
      .select('id')
      .eq('slug', slug)
      .maybeSingle();

    if (linkErr) throw linkErr;
    if (!link) return res.status(404).json({ error: 'Link tidak ditemukan.' });

    const { data, error } = await supabase
      .from('click_logs')
      .select('*')
      .eq('link_id', link.id)
      .order('clicked_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('GET /api/links/:slug/logs error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', requireAdmin, async (_req, res) => {
  try {
    const [linksRes, clicksRes] = await Promise.all([
      supabase.from('links').select('id', { count: 'exact', head: true }),
      supabase.from('click_logs').select('id', { count: 'exact', head: true })
    ]);

    res.json({
      success: true,
      total_links: linksRes.count || 0,
      total_clicks: clicksRes.count || 0
    });
  } catch (err) {
    console.error('GET /api/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/links', createLimiter, async (req, res) => {
  try {
    const { slug, destination } = req.body || {};
    const cleanSlug = normalizeSlug(slug);

    if (!cleanSlug || !destination) {
      return res.status(400).json({ error: 'slug dan destination wajib diisi.' });
    }

    if (!isValidSlug(cleanSlug)) {
      return res.status(400).json({
        error: 'Slug hanya boleh huruf, angka, dash (-), underscore (_). Maks 60 karakter.'
      });
    }

    if (!/^https?:\/\/.+/i.test(destination)) {
      return res.status(400).json({ error: 'URL tujuan harus valid (mulai http:// atau https://).' });
    }

    const { data, error } = await supabase
      .from('links')
      .insert([{ slug: cleanSlug, destination: String(destination).trim() }])
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ error: 'Slug sudah dipakai, coba yang lain.' });
      }
      throw error;
    }

    res.status(201).json({ success: true, data });
  } catch (err) {
    console.error('POST /api/links error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/links/:slug', requireAdmin, async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const { destination, active } = req.body || {};

    const updates = {};
    if (destination !== undefined) {
      if (!/^https?:\/\/.+/i.test(destination)) {
        return res.status(400).json({ error: 'URL tujuan tidak valid.' });
      }
      updates.destination = String(destination).trim();
    }
    if (active !== undefined) updates.active = Boolean(active);

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'Tidak ada field yang diupdate.' });
    }

    const { data, error } = await supabase
      .from('links')
      .update(updates)
      .eq('slug', slug)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Link tidak ditemukan.' });

    res.json({ success: true, data });
  } catch (err) {
    console.error('PATCH /api/links/:slug error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/links/:slug', requireAdmin, async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);
    const { error } = await supabase.from('links').delete().eq('slug', slug);
    if (error) throw error;
    res.json({ success: true, message: `Link /${slug} dihapus.` });
  } catch (err) {
    console.error('DELETE /api/links/:slug error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/:slug', redirectLimiter, async (req, res) => {
  try {
    const slug = normalizeSlug(req.params.slug);

    if (!isValidSlug(slug)) {
      return res.status(404).send('Link tidak ditemukan.');
    }

    const { data: link, error } = await supabase
      .from('links')
      .select('id, destination, active')
      .eq('slug', slug)
      .maybeSingle();

    if (error) throw error;

    if (!link) {
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:4rem">
          <h2>404 — Link tidak ditemukan</h2>
          <p>Short link <strong>/${slug}</strong> tidak ada atau sudah dihapus.</p>
        </body></html>
      `);
    }

    if (!link.active) {
      return res.status(410).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:4rem">
          <h2>Link Tidak Aktif</h2>
          <p>Short link <strong>/${slug}</strong> sudah dinonaktifkan.</p>
        </body></html>
      `);
    }

    const logPayload = {
      link_id: link.id,
      ip_address: getIP(req),
      user_agent: req.headers['user-agent'] || null,
      referer: req.headers['referer'] || null
    };

    const { error: logErr } = await supabase.from('click_logs').insert([logPayload]);
    if (logErr) {
      console.error('Log klik gagal:', logErr.message);
    }

    return res.redirect(302, link.destination);
  } catch (err) {
    console.error('Redirect error:', err);
    res.status(500).send('Server error.');
  }
});

app.get('/', (_req, res) => {
  res.json({ message: 'FTC Jember URL Shortener API — running!' });
});

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`FTC Jember Shortlink backend running on port ${PORT}`);
  });
}

module.exports = serverless(app);
