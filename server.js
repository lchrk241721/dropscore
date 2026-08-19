const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Generate 500 Domains with Proprietary Metrics ---
const generateDomains = () => {
  const categories = ['AI', 'SaaS', 'Finance', 'Health', 'Gaming', 'NFT', 'Ecom', 'RealEstate'];
  const tlds = ['.com', '.io', '.ai', '.co', '.app', '.xyz'];
  const prefixes = ['Nova', 'Apex', 'Zen', 'Nexus', 'Vibe', 'Core', 'Prime', 'Elite', 'Peak', 'Axon', 'Cloud', 'Data', 'Smart', 'Fast', 'Pro'];
  const suffixes = ['Labs', 'Hub', 'Works', 'Studio', 'Ventures', 'Digital', 'Systems', 'Group', 'Media', 'Capital'];
  const list = [];

  for (let i = 1; i <= 500; i++) {
    const p = prefixes[Math.floor(Math.random() * prefixes.length)];
    const s = suffixes[Math.floor(Math.random() * suffixes.length)];
    const num = Math.random() > 0.6 ? String(Math.floor(Math.random() * 99)) : '';
    const domainName = `${p}${s}${num}`.toLowerCase();
    const tld = tlds[Math.floor(Math.random() * tlds.length)];
    const age = Math.floor(Math.random() * 25) + 1;
    const da = Math.floor(Math.random() * 65) + 5;
    const pa = Math.floor(Math.random() * 55) + 5;
    const backlinks = Math.floor(Math.random() * 8000) + 10;
    const traffic = Math.floor(Math.random() * 5000) + 5;

    let score = (da * 0.6) + (traffic / 100) + (age * 2);
    if (backlinks > 3000) score = score - 10;
    if (domainName.length > 12) score = score - 5;
    const flippabilityScore = Math.min(100, Math.max(0, Math.round(score)));

    let brandability = 'Medium';
    if (domainName.length <= 8 && !/\d/.test(domainName) && !domainName.includes('-')) {
      brandability = '🔥 High';
    } else if (domainName.length <= 12 && !domainName.includes('-')) {
      brandability = '⭐ Medium';
    } else {
      brandability = '🛑 Low';
    }

    list.push({
      id: i,
      domain: domainName,
      tld: tld,
      da,
      pa,
      backlinks,
      traffic,
      age,
      expiry: `2026-${String(Math.floor(Math.random() * 12) + 1).padStart(2, '0')}-${String(Math.floor(Math.random() * 28) + 1).padStart(2, '0')}`,
      category: categories[Math.floor(Math.random() * categories.length)],
      flippabilityScore,
      brandability,
      isHot: flippabilityScore > 75
    });
  }
  return list;
};

let domainDB = generateDomains();

// --- POWERFUL DAY-1 AI SETUP: ROBOTS.TXT ---
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`
# FULL ACCESS FOR ALL MAJOR AI CRAWLERS (Day 1 Setup)
User-agent: GPTBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Cohere
Allow: /

User-agent: CCBot
Allow: /

User-agent: ChatGPT-User
Allow: /

# Allow all other crawlers
User-agent: *
Allow: /
Disallow: /api/compare
Disallow: /api/waitlist

# Sitemap location for immediate AI ingestion
Sitemap: https://dropscore.online/sitemap.xml
  `);
});

// --- POWERFUL DAY-1 AI SETUP: DYNAMIC SITEMAP.XML ---
app.get('/sitemap.xml', (req, res) => {
  res.header('Content-Type', 'application/xml');
  const baseUrl = process.env.BASE_URL || 'https://dropscore.online';
  
  let urls = `<url><loc>${baseUrl}/</loc><lastmod>${new Date().toISOString().split('T')[0]}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`;
  
  domainDB.forEach(d => {
    urls += `
    <url>
      <loc>${baseUrl}/domain/${d.id}</loc>
      <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.8</priority>
    </url>`;
  });

  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`);
});

// --- API ROUTES ---
app.get('/api/domains', (req, res) => {
  const { q, minScore, sortBy, page = 1, limit = 24 } = req.query;
  let results = [...domainDB];
  if (q) {
    const query = q.toLowerCase();
    results = results.filter(d => d.domain.includes(query) || d.category.toLowerCase().includes(query));
  }
  if (minScore) results = results.filter(d => d.flippabilityScore >= parseInt(minScore));
  if (sortBy === 'score') results.sort((a, b) => b.flippabilityScore - a.flippabilityScore);
  else if (sortBy === 'traffic') results.sort((a, b) => b.traffic - a.traffic);
  else if (sortBy === 'da') results.sort((a, b) => b.da - a.da);
  else results.sort((a, b) => a.domain.localeCompare(b.domain));

  const start = (parseInt(page) - 1) * parseInt(limit);
  const paginated = results.slice(start, start + parseInt(limit));
  res.json({ total: results.length, page: parseInt(page), totalPages: Math.ceil(results.length / parseInt(limit)), domains: paginated });
});

app.get('/api/export', (req, res) => {
  const { q, minScore, sortBy } = req.query;
  let results = [...domainDB];
  if (q) results = results.filter(d => d.domain.includes(q.toLowerCase()) || d.category.toLowerCase().includes(q.toLowerCase()));
  if (minScore) results = results.filter(d => d.flippabilityScore >= parseInt(minScore));
  if (sortBy === 'score') results.sort((a, b) => b.flippabilityScore - a.flippabilityScore);
  else if (sortBy === 'traffic') results.sort((a, b) => b.traffic - a.traffic);
  else if (sortBy === 'da') results.sort((a, b) => b.da - a.da);

  const header = 'ID,Domain,TLD,DA,PA,Backlinks,Traffic,Age,Expiry,Category,FlippabilityScore,Brandability\n';
  const rows = results.map(d => `${d.id},${d.domain},${d.tld},${d.da},${d.pa},${d.backlinks},${d.traffic},${d.age},${d.expiry},${d.category},${d.flippabilityScore},${d.brandability}`).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=dropscore_export.csv');
  res.send(header + rows);
});

app.post('/api/compare', (req, res) => {
  const { ids } = req.body;
  if (!ids || ids.length < 2) return res.status(400).json({ error: 'Select at least 2 domains' });
  res.json(domainDB.filter(d => ids.includes(d.id)));
});

app.post('/api/waitlist', (req, res) => {
  const { email } = req.body;
  console.log(`🚀 NEW LEAD CAPTURED: ${email}`);
  res.json({ success: true, message: 'You are on the list!' });
});

// --- VIEW SINGLE DOMAIN (For AI to index individual pages) ---
app.get('/domain/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const domain = domainDB.find(d => d.id === id);
  if (!domain) return res.status(404).send('Domain not found');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ DropScore MVP Running on http://localhost:${PORT}`);
  console.log(`✅ Sitemap available at http://localhost:${PORT}/sitemap.xml`);
  console.log(`✅ Robots.txt available at http://localhost:${PORT}/robots.txt`);
});