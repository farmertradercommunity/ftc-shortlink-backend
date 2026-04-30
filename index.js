require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Supabase client ────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cors({
  origin: [
    'https://ftc-shortlink-frontend.vercel.app/', // domain frontend lo
  ]
}));

// Rate limit buat endpoint create link (anti spam)
const createLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 30,
  message: { error: 'Terlalu banyak request, coba lagi nanti.' }
});

// Rate limit buat redirect (lebih longgar)
const redirectLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 menit
  max: 200
});

// ─── Helper: cek Admin Secret ────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized. Header x-admin-secret salah.' });
  }
  next();
}

// ─── Helper: ambil IP asli ───────────────────────────────────────────────────
function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress ||
    null
  );
}

// ─── Validasi slug ───────────────────────────────────────────────────────────
function isValidSlug(slug) {
  return /^[a-zA-Z0-9\-_]{1,60}$/.test(slug);
}

// ════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ════════════════════════════════════════════════════════════════════════════

// ── GET /api/links — ambil semua link (admin only) ──────────────────────────
app.get('/api/links', requireAdmin, async (req, res) => {
  try {
    const { search, limit = 100, offset = 0 } = req.query;

    let query = supabase
      .from('links_with_clicks')
      .select('*')
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    if (search) {
      query = query.ilike('slug', `%${search}%`);
    }

    const { data, error } = await query;
    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/links error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/links/:slug/logs — click log detail ────────────────────────────
app.get('/api/links/:slug/logs', requireAdmin, async (req, res) => {
  try {
    const { slug } = req.params;

    const { data: link, error: linkErr } = await supabase
      .from('links')
      .select('id')
      .eq('slug', slug)
      .single();

    if (linkErr || !link) return res.status(404).json({ error: 'Link tidak ditemukan.' });

    const { data, error } = await supabase
      .from('click_logs')
      .select('*')
      .eq('link_id', link.id)
      .order('clicked_at', { ascending: false })
      .limit(500);

    if (error) throw error;

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/stats — ringkasan global ───────────────────────────────────────
app.get('/api/stats', requireAdmin, async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/links — buat link baru ────────────────────────────────────────
app.post('/api/links', requireAdmin, createLimiter, async (req, res) => {
  try {
    const { slug, destination } = req.body;

    if (!slug || !destination) {
      return res.status(400).json({ error: 'slug dan destination wajib diisi.' });
    }

    if (!isValidSlug(slug)) {
      return res.status(400).json({
        error: 'Slug hanya boleh huruf, angka, dash (-), underscore (_). Maks 60 karakter.'
      });
    }

    if (!/^https?:\/\/.+/.test(destination)) {
      return res.status(400).json({ error: 'URL tujuan harus valid (mulai https:// atau http://).' });
    }

    const { data, error } = await supabase
      .from('links')
      .insert([{ slug: slug.toLowerCase(), destination }])
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

// ── PATCH /api/links/:slug — update destination atau status ─────────────────
app.patch('/api/links/:slug', requireAdmin, async (req, res) => {
  try {
    const { slug } = req.params;
    const { destination, active } = req.body;

    const updates = {};
    if (destination !== undefined) {
      if (!/^https?:\/\/.+/.test(destination)) {
        return res.status(400).json({ error: 'URL tujuan tidak valid.' });
      }
      updates.destination = destination;
    }
    if (active !== undefined) updates.active = Boolean(active);

    const { data, error } = await supabase
      .from('links')
      .update(updates)
      .eq('slug', slug)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/links/:slug — hapus link ────────────────────────────────────
app.delete('/api/links/:slug', requireAdmin, async (req, res) => {
  try {
    const { slug } = req.params;
    const { error } = await supabase.from('links').delete().eq('slug', slug);
    if (error) throw error;
    res.json({ success: true, message: `Link /${slug} dihapus.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// REDIRECT ROUTE — HARUS DI PALING BAWAH
// GET /:slug — redirect ke destination dan catat klik
// ════════════════════════════════════════════════════════════════════════════
app.get('/:slug', redirectLimiter, async (req, res) => {
  try {
    const { slug } = req.params;

    if (!isValidSlug(slug)) {
      return res.status(404).send('Link tidak ditemukan.');
    }

    const { data: link, error } = await supabase
      .from('links')
      .select('id, destination, active')
      .eq('slug', slug.toLowerCase())
      .single();

    if (error || !link) {
      return res.status(404).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:4rem">
          <h2>404 — Link tidak ditemukan</h2>
          <p>Short link <strong>/${slug}</strong> tidak ada atau sudah dihapus.</p>
          <a href="/">Kembali ke FTC Jember</a>
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

    // Catat klik secara async (jangan nunggu, biar redirect cepat)
    supabase.from('click_logs').insert([{
      link_id: link.id,
      ip_address: getIP(req),
      user_agent: req.headers['user-agent'] || null,
      referer: req.headers['referer'] || null
    }]).then(({ error: logErr }) => {
      if (logErr) console.error('Log klik gagal:', logErr.message);
    });

    // Redirect!
    res.redirect(302, link.destination);
  } catch (err) {
    console.error('Redirect error:', err);
    res.status(500).send('Server error.');
  }
});

// ─── Root ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ message: 'FTC Jember URL Shortener API — running!' });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`FTC Jember Shortlink backend running on port ${PORT}`);
});
