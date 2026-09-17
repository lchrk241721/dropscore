const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// CONFIGURATION
// ============================================
const CATCHDOMS_FREE_URL = 'https://catchdoms.com/mcp/catchdoms/free';
const CRAWLY_API_KEY = process.env.CRAWLY_API_KEY || '';

// ============================================
// 1. HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    message: 'DropScore API is running',
    features: ['CatchDoms', 'RDAP', 'Wayback', 'Spam Check']
  });
});

// ============================================
// 2. FETCH EXPIRED DOMAINS (CatchDoms MCP)
// ============================================
app.get('/api/fetch-expiring-domains', async (req, res) => {
  let client = null;
  try {
    const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');

    const transport = new StreamableHTTPClientTransport(new URL(CATCHDOMS_FREE_URL));
    client = new Client({ name: 'dropscore-mvp', version: '1.0.0' }, { capabilities: {} });

    await client.connect(transport);

    const result = await client.callTool({
      name: 'search_domains',
      arguments: { limit: 50 }
    });

    let domainsList = [];
    if (result.content && Array.isArray(result.content)) {
      const textBlock = result.content.find(c => c.type === 'text');
      if (textBlock && textBlock.text) {
        const parsed = JSON.parse(textBlock.text);
        domainsList = Array.isArray(parsed) ? parsed : (parsed.domains || []);
      }
    }

    if (domainsList.length === 0) {
      return res.json({ success: true, count: 0, domains: [], message: 'No domains found.' });
    }

    const domains = domainsList.map((d, index) => {
      const domainName = d.domain || d.name || `unknown${index}`;
      const parts = domainName.split('.');
      const name = parts[0] || domainName;
      const tld = parts.length > 1 ? `.${parts.slice(1).join('.')}` : '.com';

      const da = d.domain_authority || d.da || 0;
      const backlinks = d.backlinks || d.referring_domains || 0;
      const age = d.age_years || d.age || 0;

      const flippabilityScore = Math.min(100, Math.round((da * 0.6) + (age * 2)));

      let brandability = '⭐ Medium';
      if (name.length <= 8 && !/\d/.test(name) && !name.includes('-')) brandability = '🔥 High';
      else if (name.length > 12 || name.includes('-') || /\d/.test(name)) brandability = '🛑 Low';

      return {
        id: index + 1,
        domain: name.toLowerCase(),
        tld: tld,
        da: da,
        pa: d.page_authority || 0,
        backlinks: backlinks,
        traffic: d.traffic || 0,
        age: age,
        expiry: d.expiry_date || d.drop_date || 'N/A',
        category: d.source || 'Expired',
        flippabilityScore: flippabilityScore,
        brandability: brandability,
        isHot: flippabilityScore > 65
      };
    });

    res.json({
      success: true,
      count: domains.length,
      domains: domains.slice(0, 50),
      fetchedAt: new Date().toISOString(),
      message: `Fetched ${domains.length} domains`
    });

  } catch (error) {
    console.error('CatchDoms error:', error.message);
    res.json({ success: false, count: 0, domains: [], message: 'Could not reach CatchDoms.' });
  } finally {
    if (client) { try { await client.close(); } catch (e) {} }
  }
});

// ============================================
// 3. WAYBACK MACHINE CHECK (Free CDX API)
// ============================================
app.get('/api/wayback-check', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'Domain required' });

  try {
    // CDX API: returns every capture the Wayback Machine holds for a domain
    const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${domain}&output=json&limit=30&fl=timestamp,original,statuscode`;

    const cdxResponse = await fetch(cdxUrl, {
      signal: AbortSignal.timeout(15000)
    });

    let snapshots = [];
    let firstCapture = null;
    let lastCapture = null;

    if (cdxResponse.ok) {
      const cdxData = await cdxResponse.json();
      // First row is column headers; remaining rows are data
      if (cdxData.length > 1) {
        snapshots = cdxData.slice(1).map(row => ({
          timestamp: row[0],
          url: row[1],
          status: row[2]
        }));
        firstCapture = snapshots[0]?.timestamp;
        lastCapture = snapshots[snapshots.length - 1]?.timestamp;
      }
    }

    // Determine risk level from archive history
    let riskLevel = 'low';
    let riskLabel = '✅ Clean History';

    if (snapshots.length === 0) {
      riskLevel = 'medium';
      riskLabel = '⚠️ No Archive History';
    } else if (snapshots.length > 100) {
      riskLevel = 'high';
      riskLabel = '🚨 Heavy Archive Activity';
    }

    res.json({
      domain: domain,
      totalSnapshots: snapshots.length,
      firstCapture: firstCapture,
      lastCapture: lastCapture,
      riskLevel: riskLevel,
      riskLabel: riskLabel,
      snapshots: snapshots.slice(0, 10),
      waybackUrl: `https://web.archive.org/web/*/${domain}`
    });

  } catch (error) {
    console.error('Wayback error:', error.message);
    res.json({
      domain: domain,
      totalSnapshots: 0,
      riskLevel: 'unknown',
      riskLabel: '❓ Could not check',
      error: error.message
    });
  }
});

// ============================================
// 4. SPAM SCORE CHECK (Crawly API + Fallback)
// ============================================
app.get('/api/spam-check', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'Domain required' });

  try {
    // Try Crawly API if key is configured
    if (CRAWLY_API_KEY) {
      const spamUrl = `https://www.getcrawly.com/api/v1/spam-score?domain=${domain}`;
      const response = await fetch(spamUrl, {
        headers: { Authorization: `Bearer ${CRAWLY_API_KEY}` },
        signal: AbortSignal.timeout(10000)
      });

      if (response.ok) {
        const data = await response.json();
        const score = data.spam_score || data.score || 0;

        let riskLabel = '✅ Low Risk';
        if (score > 60) riskLabel = '🚨 High Spam Risk';
        else if (score > 30) riskLabel = '⚠️ Medium Risk';

        return res.json({
          domain: domain,
          spamScore: score,
          riskLabel: riskLabel,
          source: 'Crawly'
        });
      }
    }

    // Fallback: estimate from domain characteristics
    const domainLength = domain.length;
    const hasNumbers = /\d/.test(domain);
    const hasHyphens = domain.includes('-');
    const hasRepeatedChars = /(.)\1{3,}/.test(domain);

    let estimatedScore = 5;
    if (hasNumbers) estimatedScore += 15;
    if (hasHyphens) estimatedScore += 20;
    if (domainLength > 20) estimatedScore += 10;
    if (hasRepeatedChars) estimatedScore += 15;

    estimatedScore = Math.min(100, estimatedScore);

    let riskLabel = '✅ Low Risk';
    if (estimatedScore > 60) riskLabel = '🚨 High Spam Risk';
    else if (estimatedScore > 30) riskLabel = '⚠️ Medium Risk';

    res.json({
      domain: domain,
      spamScore: estimatedScore,
      riskLabel: riskLabel,
      source: 'Estimated'
    });

  } catch (error) {
    console.error('Spam check error:', error.message);
    res.json({
      domain: domain,
      spamScore: 0,
      riskLabel: '❓ Could not check',
      error: error.message
    });
  }
});

// ============================================
// 5. DOMAIN STATUS CHECK (RDAP)
// ============================================
app.get('/api/domain-status', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'Domain required' });

  const rdapProviders = [
    `https://rdap.org/domain/${domain}`,
    `https://www.rdap.net/domain/${domain}`
  ];

  for (const url of rdapProviders) {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/rdap+json, application/json' },
        signal: AbortSignal.timeout(8000)
      });

      if (response.status === 404) {
        return res.json({
          domain: domain, status: 'available', statusLabel: '🛒 Available for Registration',
          canRegister: true,
          actionUrl: `https://www.namecheap.com/domains/registration/results/?domain=${domain}`,
          actionLabel: 'Register Now 🛒', registrar: 'N/A', creationDate: 'N/A', expiryDate: 'N/A',
          statusCodes: ['available']
        });
      }

      if (!response.ok) continue;

      const data = await response.json();
      const statusCodes = (data.status || []).map(s => s.toLowerCase());

      let status = 'active', statusLabel = '🔒 Already Registered';
      let actionLabel = 'Check Auctions 🔍';
      let actionUrl = `https://www.namecheap.com/domains/registration/results/?domain=${domain}`;

      if (statusCodes.some(s => s.includes('pending delete'))) {
        status = 'pendingDelete'; statusLabel = '⏳ Dropping Soon';
        actionLabel = 'Watch for Drop ⏳';
      } else if (statusCodes.some(s => s.includes('redemption'))) {
        status = 'redemption'; statusLabel = '🔄 In Redemption Period';
        actionLabel = 'Watch Redemption 🔄';
      }

      return res.json({
        domain, status, statusLabel, canRegister: false, actionUrl, actionLabel,
        creationDate: data.events?.find(e => e.eventAction === 'registration')?.eventDate || 'N/A',
        expiryDate: data.events?.find(e => e.eventAction === 'expiration')?.eventDate || 'N/A',
        registrar: data.entities?.find(e => e.roles?.includes('registrar'))?.vcardArray?.[1]?.[1]?.[3] || 'N/A',
        statusCodes
      });
    } catch (e) { continue; }
  }

  res.json({
    domain, status: 'unknown', statusLabel: '❓ Status Unavailable', canRegister: false,
    actionUrl: `https://www.namecheap.com/domains/registration/results/?domain=${domain}`,
    actionLabel: 'Check on Namecheap 🔍', registrar: 'N/A', creationDate: 'N/A', expiryDate: 'N/A',
    statusCodes: []
  });
});

// ============================================
// 6. RDAP WHOIS LOOKUP
// ============================================
app.get('/api/domain-whois', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'Domain required' });

  try {
    const response = await fetch(`https://rdap.org/domain/${domain}`, {
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return res.status(404).json({ error: 'Domain not found' });

    const data = await response.json();
    res.json({
      domain,
      creationDate: data.events?.find(e => e.eventAction === 'registration')?.eventDate || 'N/A',
      expiryDate: data.events?.find(e => e.eventAction === 'expiration')?.eventDate || 'N/A',
      registrar: data.entities?.find(e => e.roles?.includes('registrar'))?.vcardArray?.[1]?.[1]?.[3] || 'N/A',
      nameservers: data.nameservers?.map(ns => ns.ldhName).join(', ') || 'N/A',
      status: data.status?.join(', ') || 'N/A'
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch WHOIS' });
  }
});

// ============================================
// 7. WAITLIST (Make.com Webhook)
// ============================================
app.post('/api/waitlist', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const webhookUrl = 'https://hook.eu1.make.com/vxdpcrnqunfzmv86a7aglb64our85mcj';

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        email,
        ip: req.ip || req.headers['x-forwarded-for'] || 'N/A',
        userAgent: req.headers['user-agent'] || 'N/A',
        referrer: req.headers['referer'] || 'Direct',
        source: req.query.source || 'Direct'
      })
    });
  } catch (e) {}

  res.json({ success: true, message: 'You are on the list!' });
});

// ============================================
// 8. ROBOTS.TXT
// ============================================
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send(`# FULL ACCESS FOR ALL MAJOR AI CRAWLERS
User-agent: GPTBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: *
Allow: /
Disallow: /api/waitlist

Sitemap: https://dropscore.online/sitemap.xml
`);
});

// ============================================
// 9. SITEMAP.XML
// ============================================
app.get('/sitemap.xml', (req, res) => {
  res.header('Content-Type', 'application/xml');
  const baseUrl = process.env.BASE_URL || 'https://dropscore.online';
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
</urlset>`);
});

// ============================================
// 10. CATCH-ALL
// ============================================
app.get('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found', path: req.path });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// 11. START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`✅ DropScore running on http://localhost:${PORT}`);
  console.log(`✅ Features: CatchDoms, RDAP, Wayback, Spam Check`);
});