const express = require('express');
const cors = require('cors');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// CONFIGURATION
// ============================================
const CATCHDOMS_FREE_URL = 'https://catchdoms.com/mcp/catchdoms/free';

// ============================================
// 1. HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    message: 'DropScore API is running',
    dataSource: 'CatchDoms MCP (Free Tier)'
  });
});

// ============================================
// 2. FETCH EXPIRED DOMAINS VIA CATCHDOMS MCP
// ============================================
app.get('/api/fetch-expiring-domains', async (req, res) => {
  let client = null;
  try {
    console.log('📡 Connecting to CatchDoms MCP (Free Tier)...');

    // 1. Create and connect the MCP client
    const transport = new SSEClientTransport(new URL(CATCHDOMS_FREE_URL));
    client = new Client(
      { name: 'dropscore-mvp', version: '1.0.0' },
      { capabilities: {} }
    );

    await client.connect(transport);
    console.log('✅ Connected to CatchDoms MCP');

    // 2. Call the search_domains tool with basic parameters
    // The free tier returns up to 50 results, but only the first 10 have visible names.
    const result = await client.callTool({
      name: 'search_domains',
      arguments: {
        limit: 50 // Request the maximum for free tier
      }
    });

    // 3. Parse the result (CatchDoms returns JSON as a text block)
    let domainsList = [];
    if (result.content && Array.isArray(result.content)) {
      const textBlock = result.content.find(c => c.type === 'text');
      if (textBlock && textBlock.text) {
        try {
          const parsed = JSON.parse(textBlock.text);
          // CatchDoms may return an array directly or an object with a 'domains' key
          domainsList = Array.isArray(parsed) ? parsed : (parsed.domains || []);
        } catch (parseErr) {
          console.error('Failed to parse CatchDoms response:', parseErr.message);
          throw new Error('Invalid response format from CatchDoms');
        }
      }
    }

    if (!Array.isArray(domainsList) || domainsList.length === 0) {
      return res.json({
        success: true,
        count: 0,
        domains: [],
        fetchedAt: new Date().toISOString(),
        message: 'No expired domains found at this time. Please try again later.'
      });
    }

    // 4. Transform CatchDoms data to DropScore format
    const domains = domainsList.map((d, index) => {
      // CatchDoms field names (based on their API docs)
      const domainName = d.domain || d.name || `unknown${index}`;
      const parts = domainName.split('.');
      const name = parts[0] || domainName;
      const tld = parts.length > 1 ? `.${parts.slice(1).join('.')}` : '.com';

      const da = d.domain_authority || d.da || 0;
      const backlinks = d.backlinks || d.referring_domains || 0;
      const age = d.age_years || d.age || 0;
      const traffic = d.traffic || 0; // May not be available on free tier

      // Calculate Flippability Score using available metrics
      const flippabilityScore = Math.min(100, Math.round(
        (da * 0.6) + (traffic / 100) + (age * 2)
      ));

      // Brandability check
      let brandability = '⭐ Medium';
      if (name.length <= 8 && !/\d/.test(name) && !name.includes('-')) {
        brandability = '🔥 High';
      } else if (name.length > 12 || name.includes('-') || /\d/.test(name)) {
        brandability = '🛑 Low';
      }

      return {
        id: index + 1,
        domain: name.toLowerCase(),
        tld: tld,
        da: da,
        pa: d.page_authority || 0,
        backlinks: backlinks,
        traffic: traffic,
        age: age,
        expiry: d.expiry_date || d.drop_date || 'N/A',
        category: d.source || 'Expired',
        flippabilityScore: flippabilityScore,
        brandability: brandability,
        isHot: flippabilityScore > 65,
        // Preserve original source for transparency
        source: d.source || 'CatchDoms'
      };
    });

    // Free tier: only the first 10 domains will have real names.
    // We still send all 50, but the UI will display what it receives.
    const finalDomains = domains.slice(0, 50);

    console.log(`✅ Fetched ${finalDomains.length} domains from CatchDoms`);

    res.json({
      success: true,
      count: finalDomains.length,
      domains: finalDomains,
      fetchedAt: new Date().toISOString(),
      message: `Successfully fetched ${finalDomains.length} expired domains (free tier limit)`
    });

  } catch (error) {
    console.error('❌ CatchDoms MCP error:', error.message);

    // Graceful fallback: return an informative message and an empty list
    res.json({
      success: false,
      count: 0,
      domains: [],
      fetchedAt: new Date().toISOString(),
      message: 'Could not reach CatchDoms right now. Please try again in a moment.',
      error: error.message
    });
  } finally {
    // Always close the MCP client to free resources
    if (client) {
      try {
        await client.close();
        console.log('🔌 CatchDoms MCP connection closed');
      } catch (closeErr) {
        console.error('Error closing MCP client:', closeErr.message);
      }
    }
  }
});

// ============================================
// 3. DOMAIN STATUS CHECK (RDAP with Fallback)
// ============================================
app.get('/api/domain-status', async (req, res) => {
  const { domain } = req.query;
  if (!domain) {
    return res.status(400).json({ error: 'Domain name required' });
  }

  const rdapProviders = [
    `https://rdap.org/domain/${domain}`,
    `https://rdap.verisign.com/com/v1/domain/${domain}`,
    `https://www.rdap.net/domain/${domain}`
  ];

  let lastError = null;

  for (const url of rdapProviders) {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/rdap+json, application/json' },
        signal: AbortSignal.timeout(8000)
      });

      if (response.status === 404) {
        return res.json({
          domain: domain,
          status: 'available',
          statusLabel: '🛒 Available for Registration',
          canRegister: true,
          actionUrl: `https://www.namecheap.com/domains/registration/results/?domain=${domain}`,
          actionLabel: 'Register Now 🛒',
          registrar: 'N/A',
          creationDate: 'N/A',
          expiryDate: 'N/A',
          statusCodes: ['available']
        });
      }

      if (!response.ok) {
        lastError = `RDAP returned ${response.status}`;
        continue;
      }

      const data = await response.json();
      const statusCodes = (data.status || []).map(s => s.toLowerCase());

      let status = 'active';
      let statusLabel = '🔒 Already Registered';
      let canRegister = false;
      let actionLabel = 'Check Auctions 🔍';
      let actionUrl = `https://www.namecheap.com/domains/registration/results/?domain=${domain}`;

      if (statusCodes.some(s => s.includes('pending delete') || s.includes('pendingdelete'))) {
        status = 'pendingDelete';
        statusLabel = '⏳ Dropping Soon';
        actionLabel = 'Watch for Drop ⏳';
      } else if (statusCodes.some(s => s.includes('redemption'))) {
        status = 'redemption';
        statusLabel = '🔄 In Redemption Period';
        actionLabel = 'Watch Redemption 🔄';
      } else if (statusCodes.some(s => s.includes('hold'))) {
        status = 'suspended';
        statusLabel = '⚠️ Suspended';
        actionLabel = 'Check WHOIS ⚠️';
      } else if (statusCodes.includes('active')) {
        const expiryEvent = data.events?.find(e => e.eventAction === 'expiration');
        if (expiryEvent && new Date(expiryEvent.eventDate) < new Date()) {
          status = 'expiredActive';
          statusLabel = '⏰ Expired – In Grace Period';
          actionLabel = 'Check Auctions 🔍';
        }
      }

      return res.json({
        domain: domain,
        status: status,
        statusLabel: statusLabel,
        canRegister: canRegister,
        actionUrl: actionUrl,
        actionLabel: actionLabel,
        creationDate: data.events?.find(e => e.eventAction === 'registration')?.eventDate || 'N/A',
        expiryDate: data.events?.find(e => e.eventAction === 'expiration')?.eventDate || 'N/A',
        registrar: data.entities?.find(e => e.roles?.includes('registrar'))?.vcardArray?.[1]?.[1]?.[3] || 'N/A',
        statusCodes: statusCodes
      });

    } catch (error) {
      lastError = error.message;
      continue;
    }
  }

  return res.json({
    domain: domain,
    status: 'unknown',
    statusLabel: '❓ Status Unavailable',
    canRegister: false,
    actionUrl: `https://www.namecheap.com/domains/registration/results/?domain=${domain}`,
    actionLabel: 'Check on Namecheap 🔍',
    registrar: 'N/A',
    creationDate: 'N/A',
    expiryDate: 'N/A',
    statusCodes: ['RDAP unavailable: ' + (lastError || 'unknown')]
  });
});

// ============================================
// 4. RDAP WHOIS LOOKUP
// ============================================
app.get('/api/domain-whois', async (req, res) => {
  const { domain } = req.query;
  if (!domain) return res.status(400).json({ error: 'Domain name required' });

  try {
    const response = await fetch(`https://rdap.org/domain/${domain}`, {
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    const data = await response.json();
    res.json({
      domain: domain,
      creationDate: data.events?.find(e => e.eventAction === 'registration')?.eventDate || 'N/A',
      expiryDate: data.events?.find(e => e.eventAction === 'expiration')?.eventDate || 'N/A',
      registrar: data.entities?.find(e => e.roles?.includes('registrar'))?.vcardArray?.[1]?.[1]?.[3] || 'N/A',
      nameservers: data.nameservers?.map(ns => ns.ldhName).join(', ') || 'N/A',
      status: data.status?.join(', ') || 'N/A'
    });
  } catch (error) {
    console.error('RDAP error:', error.message);
    res.status(500).json({ error: 'Failed to fetch WHOIS data' });
  }
});

// ============================================
// 5. WAITLIST (Make.com Webhook)
// ============================================
app.post('/api/waitlist', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const webhookUrl = 'https://hook.eu1.make.com/vxdpcrnqunfzmv86a7aglb64our85mcj';

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        email: email,
        ip: req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'N/A',
        userAgent: req.headers['user-agent'] || 'N/A',
        referrer: req.headers['referer'] || 'Direct',
        source: req.query.source || 'Direct'
      })
    });
    console.log(`✅ Lead captured: ${email}`);
  } catch (error) {
    console.error('Webhook error:', error.message);
  }

  res.json({ success: true, message: 'You are on the list!' });
});

// ============================================
// 6. ROBOTS.TXT
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
// 7. SITEMAP.XML
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
// 8. CATCH-ALL: 404 for /api/*, index.html for everything else
// ============================================
app.get('/api/*', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found', path: req.path });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// 9. START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`✅ DropScore running on http://localhost:${PORT}`);
  console.log(`✅ Data Source: CatchDoms MCP (Free Tier)`);
  console.log(`✅ Endpoints available:`);
  console.log(`   - /api/health`);
  console.log(`   - /api/fetch-expiring-domains (CatchDoms MCP)`);
  console.log(`   - /api/domain-status?domain=example.com`);
  console.log(`   - /api/domain-whois?domain=example.com`);
  console.log(`   - /api/waitlist`);
});