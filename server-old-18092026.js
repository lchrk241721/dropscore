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
    message: 'DropScore API is running'
  });
});

// ============================================
// 2. HELPER: Check domain status via RDAP
// ============================================
async function getDomainStatus(domain) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: { 'Accept': 'application/rdap+json, application/json' },
      signal: controller.signal
    });

    clearTimeout(timeout);

    // 404 = domain is NOT registered → available
    if (response.status === 404) {
      return { status: 'available', statusLabel: '🛒 Available', statusColor: 'green' };
    }

    if (!response.ok) {
      return { status: 'unknown', statusLabel: '❓ Unknown', statusColor: 'gray' };
    }

    const data = await response.json();
    const statusCodes = (data.status || []).map(s => String(s).toLowerCase());

    if (statusCodes.some(s => s.includes('pending'))) {
      return { status: 'pendingDelete', statusLabel: '⏳ Dropping Soon', statusColor: 'yellow' };
    }
    if (statusCodes.some(s => s.includes('redemption'))) {
      return { status: 'redemption', statusLabel: '🔄 In Redemption', statusColor: 'orange' };
    }
    if (statusCodes.some(s => s.includes('hold'))) {
      return { status: 'suspended', statusLabel: '⚠️ Suspended', statusColor: 'red' };
    }

    // If CatchDoms returned it, and it's registered, it's likely in auction
    return { status: 'auction', statusLabel: '🏷️ In Auction', statusColor: 'purple' };

  } catch (e) {
    return { status: 'unknown', statusLabel: '❓ Unknown', statusColor: 'gray' };
  }
}

// ============================================
// 3. FETCH EXPIRED DOMAINS (WITH STATUS)
// ============================================
app.get('/api/fetch-expiring-domains', async (req, res) => {
  let client = null;
  try {
    console.log('📡 Connecting to CatchDoms...');

    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');

    const transport = new StreamableHTTPClientTransport(new URL(CATCHDOMS_FREE_URL));
    client = new Client({ name: 'dropscore-mvp', version: '1.0.0' }, { capabilities: {} });

    await client.connect(transport);
    console.log('✅ Connected');

    const result = await client.callTool({
      name: 'search_domains',
      arguments: { limit: 50 }
    });

    let domainsList = [];
    if (result.content && Array.isArray(result.content)) {
      const textBlock = result.content.find(c => c.type === 'text');
      if (textBlock && textBlock.text) {
        try {
          const parsed = JSON.parse(textBlock.text);
          domainsList = Array.isArray(parsed) ? parsed : (parsed.domains || []);
        } catch (parseErr) {
          console.error('Parse error:', parseErr.message);
        }
      }
    }

    console.log(`📦 Received ${domainsList.length} domains from CatchDoms`);

    if (domainsList.length === 0) {
      return res.json({
        success: false,
        count: 0,
        domains: [],
        message: 'CatchDoms returned no domains. Please try again in a moment.'
      });
    }

    // Transform to our format
    const transformed = domainsList.map((d, index) => {
      const domainName = d.domain || d.name || `unknown${index}.com`;
      const parts = domainName.split('.');
      const name = parts[0] || domainName;
      const tld = parts.length > 1 ? `.${parts.slice(1).join('.')}` : '.com';

      const da = parseInt(d.domain_authority || d.da || 0) || 0;
      const backlinks = parseInt(d.backlinks || d.referring_domains || 0) || 0;
      const age = parseInt(d.age_years || d.age || 0) || 0;

      const flippabilityScore = Math.min(100, Math.round((da * 0.6) + (age * 2) + 10));

      let brandability = '⭐ Medium';
      if (name.length <= 8 && !/\d/.test(name) && !name.includes('-')) brandability = '🔥 High';
      else if (name.length > 12 || name.includes('-') || /\d/.test(name)) brandability = '🛑 Low';

      return {
        id: index + 1,
        domain: name.toLowerCase(),
        tld: tld,
        fullDomain: domainName.toLowerCase(),
        da: da,
        pa: parseInt(d.page_authority || d.pa || 0) || 0,
        backlinks: backlinks,
        traffic: parseInt(d.traffic || 0) || 0,
        age: age,
        expiry: d.expiry_date || d.drop_date || 'N/A',
        category: d.source || 'Expired',
        flippabilityScore: flippabilityScore,
        brandability: brandability,
        isHot: flippabilityScore > 65
      };
    });

    // Enrich with status (parallel batches of 5)
    console.log(`🔍 Checking status for ${transformed.length} domains...`);

    const BATCH_SIZE = 5;
    const enriched = [];

    for (let i = 0; i < transformed.length; i += BATCH_SIZE) {
      const batch = transformed.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (d) => {
          const status = await getDomainStatus(d.fullDomain);
          return { ...d, ...status };
        })
      );
      enriched.push(...results);
      if (i + BATCH_SIZE < transformed.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Log summary
    const summary = enriched.reduce((acc, d) => {
      acc[d.status] = (acc[d.status] || 0) + 1;
      return acc;
    }, {});
    console.log('📊 Status summary:', summary);

    res.json({
      success: true,
      count: enriched.length,
      domains: enriched,
      fetchedAt: new Date().toISOString(),
      message: `Fetched ${enriched.length} domains`
    });

  } catch (error) {
    console.error('❌ CatchDoms error:', error.message);
    res.json({
      success: false,
      count: 0,
      domains: [],
      message: `Error: ${error.message}`
    });
  } finally {
    if (client) {
      try { await client.close(); } catch (e) {}
    }
  }
});

// ============================================
// 4. WAYBACK MACHINE CHECK (FULL HISTORY)
// ============================================
app.get('/api/wayback-check', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'Domain required' });

  try {
    // Request ALL captures for the domain, not just the latest 30.
    // We use fl to select only the fields we need (timestamp, status).
    // The API returns a JSON array where the first row is the column header.
    const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${domain}&output=json&fl=timestamp,statuscode&collapse=digest`;

    const response = await fetch(cdxUrl, { signal: AbortSignal.timeout(20000) });

    let allSnapshots = [];
    if (response.ok) {
      const data = await response.json();
      // data[0] is the header row; the rest are snapshot records
      if (data.length > 1) {
        allSnapshots = data.slice(1).map(row => ({
          timestamp: row[0],
          status: row[1]
        }));
      }
    }

    // Prepare the summary data
    let firstCapture = null;
    let lastCapture = null;
    let totalSnapshots = allSnapshots.length;
    let yearlySummary = {};

    if (totalSnapshots > 0) {
      firstCapture = allSnapshots[0].timestamp;
      lastCapture = allSnapshots[allSnapshots.length - 1].timestamp;

      // Build a per-year summary for the last 5 years of activity
      allSnapshots.forEach(s => {
        const year = s.timestamp.slice(0, 4);
        yearlySummary[year] = (yearlySummary[year] || 0) + 1;
      });

      // Sort years descending so the most recent activity appears first
      yearlySummary = Object.entries(yearlySummary)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 5);
    }

    // Determine a simple risk level based on archive volume
    let riskLevel = 'low';
    let riskLabel = '✅ Clean History';
    if (totalSnapshots === 0) {
      riskLevel = 'medium';
      riskLabel = '⚠️ No Archive History';
    } else if (totalSnapshots > 100) {
      riskLevel = 'high';
      riskLabel = '🚨 Heavy Archive Activity';
    }

    res.json({
      domain,
      totalSnapshots,
      firstCapture,
      lastCapture,
      yearlySummary,
      riskLevel,
      riskLabel,
      waybackUrl: `https://web.archive.org/web/*/${domain}`
    });

  } catch (error) {
    console.error('Wayback error:', error.message);
    res.json({
      domain,
      totalSnapshots: 0,
      riskLevel: 'unknown',
      riskLabel: '❓ Could not check',
      error: error.message,
      waybackUrl: `https://web.archive.org/web/*/${domain}`
    });
  }
});

// ============================================
// 5. SPAM CHECK
// ============================================
app.get('/api/spam-check', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'Domain required' });

  // Estimate from domain characteristics (always works)
  const name = domain.split('.')[0] || '';
  let score = 5;
  if (/\d/.test(name)) score += 15;
  if (name.includes('-')) score += 20;
  if (name.length > 20) score += 10;
  if (/(.)\1{3,}/.test(name)) score += 15;
  score = Math.min(100, score);

  let riskLabel = '✅ Low Risk';
  if (score > 60) riskLabel = '🚨 High Spam Risk';
  else if (score > 30) riskLabel = '⚠️ Medium Risk';

  res.json({ domain, spamScore: score, riskLabel, source: 'Estimated' });
});

// ============================================
// 6. DOMAIN AUTHORITY (Crawly)
// ============================================
app.get('/api/domain-authority', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'Domain required' });

  const estimateDA = (d) => {
    let score = 15;
    const name = d.split('.')[0] || '';
    if (name.length <= 6) score += 10;
    if (name.length > 15) score -= 5;
    if (/\d/.test(name)) score -= 8;
    if (name.includes('-')) score -= 10;
    return Math.max(1, Math.min(60, score));
  };

  if (!CRAWLY_API_KEY) {
    return res.json({
      domain, authorityScore: estimateDA(domain),
      referringDomains: 0, totalBacklinks: 0, source: 'Estimated'
    });
  }

  try {
    const url = `https://www.getcrawly.com/api/v1/domain-authority?domain=${domain}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${CRAWLY_API_KEY}` },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) throw new Error(`Crawly ${response.status}`);

    const data = await response.json();
    const harmonic = data.score?.harmonic_score;
    const referring = data.summary?.referring_domains || 0;
    const backlinks = data.summary?.total_links || 0;

    let authorityScore;
    if (typeof harmonic === 'number') {
      authorityScore = Math.min(100, Math.round(harmonic * 100));
    } else if (referring > 0) {
      authorityScore = Math.min(100, Math.round(Math.log10(referring + 1) * 22));
    } else {
      authorityScore = estimateDA(domain);
    }

    res.json({
      domain, authorityScore, referringDomains: referring,
      totalBacklinks: backlinks, source: 'Crawly'
    });
  } catch (error) {
    res.json({
      domain, authorityScore: estimateDA(domain),
      referringDomains: 0, totalBacklinks: 0,
      source: 'Estimated', error: error.message
    });
  }
});

// ============================================
// 7. DOMAIN STATUS (RDAP direct)
// ============================================
app.get('/api/domain-status', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'Domain required' });

  try {
    const response = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: { 'Accept': 'application/rdap+json' },
      signal: AbortSignal.timeout(8000)
    });

    if (response.status === 404) {
      return res.json({
        domain, status: 'available', statusLabel: '🛒 Available for Registration',
        actionUrl: `https://www.namecheap.com/domains/registration/results/?domain=${domain}`,
        actionLabel: 'Register Now 🛒', registrar: 'N/A',
        creationDate: 'N/A', expiryDate: 'N/A'
      });
    }

    if (!response.ok) throw new Error('RDAP failed');

    const data = await response.json();
    const statusCodes = (data.status || []).map(s => String(s).toLowerCase());

    let status = 'active', statusLabel = '🔒 Already Registered';
    let actionLabel = 'Check Auctions 🔍';
    const actionUrl = `https://www.namecheap.com/domains/registration/results/?domain=${domain}`;

    if (statusCodes.some(s => s.includes('pending'))) {
      status = 'pendingDelete'; statusLabel = '⏳ Dropping Soon'; actionLabel = 'Watch Drop ⏳';
    } else if (statusCodes.some(s => s.includes('redemption'))) {
      status = 'redemption'; statusLabel = '🔄 In Redemption'; actionLabel = 'Watch 🔄';
    }

    res.json({
      domain, status, statusLabel, actionUrl, actionLabel,
      creationDate: data.events?.find(e => e.eventAction === 'registration')?.eventDate || 'N/A',
      expiryDate: data.events?.find(e => e.eventAction === 'expiration')?.eventDate || 'N/A',
      registrar: 'N/A'
    });
  } catch (error) {
    res.json({
      domain, status: 'unknown', statusLabel: '❓ Status Unavailable',
      actionUrl: `https://www.namecheap.com/domains/registration/results/?domain=${domain}`,
      actionLabel: 'Check Manually 🔍', registrar: 'N/A',
      creationDate: 'N/A', expiryDate: 'N/A'
    });
  }
});

// ============================================
// 8. WAITLIST (Make.com)
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
        source: req.query.source || 'Direct'
      })
    });
  } catch (e) {}

  res.json({ success: true, message: 'You are on the list!' });
});

// ============================================
// 9. ROBOTS.TXT & SITEMAP
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

app.get('/sitemap.xml', (req, res) => {
  res.header('Content-Type', 'application/xml');
  const baseUrl = process.env.BASE_URL || 'https://dropscore.online';
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${baseUrl}/</loc><priority>1.0</priority></url>
</urlset>`);
});

// ============================================
// 10. CATCH-ALL
// ============================================
app.get('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// START
// ============================================
app.listen(PORT, () => {
  console.log(`✅ DropScore running on http://localhost:${PORT}`);
});