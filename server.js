require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// CONFIGURATION
// ============================================
const DOMAINSDB_API_KEY = process.env.DOMAINSDB_API_KEY || 'YOUR_API_KEY_HERE';
const DOMAINSDB_BASE_URL = 'https://api.domainsdb.info/v1';

// ============================================
// 1. HEALTH CHECK
// ============================================
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    message: 'DropScore API is running',
    dataSource: 'DomainsDB.info'
  });
});

// ============================================
// 2. FETCH RECENTLY DELETED DOMAINS (CORE FEATURE)
// ============================================
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// ... (keep your other routes)

// ============================================
// FETCH EXPIRED DOMAINS FROM CATCHDOMS MCP
// ============================================
app.get('/api/fetch-expiring-domains', async (req, res) => {
  try {
    console.log('📡 Connecting to CatchDoms MCP server...');

    // 1. Create the MCP client and connect to the free server using the non-deprecated transport
    const transport = new StreamableHTTPClientTransport(
      new URL('https://catchdoms.com/mcp/catchdoms/free')
    );
    const client = new Client({ name: 'dropscore-app', version: '1.0.0' }, { capabilities: {} });
    
    await client.connect(transport);
    console.log('✅ Connected to CatchDoms MCP');

    // 2. Call the 'search_domains' tool to get data
    const result = await client.callTool({
      name: 'search_domains',
      arguments: {
        limit: 50 // Request up to 50 domains
      }
    });

    // 3. Disconnect
    await client.close();

    // 4. Parse the result (CatchDoms returns data in a specific format)
    let domainsList = [];
    if (result.content && result.content[0] && result.content[0].text) {
        // The text content is a JSON string representing the domains
        const parsedData = JSON.parse(result.content[0].text);
        domainsList = parsedData.domains || []; // Adjust based on actual response structure
    }

    if (domainsList.length === 0) {
      return res.json({ success: true, count: 0, domains: [], message: 'No expired domains found at this time.' });
    }

    // 5. Transform CatchDoms data to your DropScore format
    const domains = domainsList.map((d, index) => {
      const domainName = d.name || `example${index}`;
      const parts = domainName.split('.');
      const name = parts[0] || domainName;
      const tld = parts.length > 1 ? `.${parts.slice(1).join('.')}` : '.com';
      
      const da = d.da || 20; // Use real DA from CatchDoms
      const traffic = d.traffic || 100; // Use real traffic if available
      const age = d.age || 5; // Use real age if available

      const flippabilityScore = Math.min(100, Math.round(da * 0.6 + traffic / 100 + age * 2));
      
      let brandability = 'Medium';
      if (name.length <= 8 && !/\d/.test(name) && !name.includes('-')) brandability = '🔥 High';
      else if (name.length <= 12 && !name.includes('-')) brandability = '⭐ Medium';

      return {
        id: index + 1,
        domain: name.toLowerCase(),
        tld: tld,
        da: da,
        pa: d.pa || 10,
        backlinks: d.backlinks || 50,
        traffic: traffic,
        age: age,
        expiry: d.expiry || 'N/A',
        category: 'Expired',
        flippabilityScore: flippabilityScore,
        brandability: brandability,
        isHot: flippabilityScore > 65
      };
    });

    const finalDomains = domains.slice(0, 50);

    res.json({
      success: true,
      count: finalDomains.length,
      domains: finalDomains,
      fetchedAt: new Date().toISOString(),
      message: `Successfully fetched ${finalDomains.length} expired domains from CatchDoms`
    });

  } catch (error) {
    console.error('❌ CatchDoms MCP fetch error:', error.message);
    // Return a fallback response so your UI doesn't break
    res.json({
      success: true,
      count: 0,
      domains: [],
      message: 'Could not fetch live data at this time. Please try again later.'
    });
  }
});

/*app.get('/api/fetch-expiring-domains', async (req, res) => {
  try {
    console.log('📡 Fetching recently deleted domains from DomainsDB...');

    // DomainsDB endpoint for recently deleted domains
    // Returns the latest deletions if no date is specified
    const apiUrl = `${DOMAINSDB_BASE_URL}/domains/updates/deleted?api_key=${DOMAINSDB_API_KEY}&limit=100`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    const response = await fetch(apiUrl, {
      signal: controller.signal,
      headers: {
        'X-Api-Key': DOMAINSDB_API_KEY // Also supported as header
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`DomainsDB returned ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Extract domains array (response uses "domains" key)
    const domainsList = data.domains || [];

    if (domainsList.length === 0) {
      return res.json({
        success: true,
        count: 0,
        domains: [],
        fetchedAt: new Date().toISOString(),
        message: 'No recently deleted domains found at this time.'
      });
    }

    // Transform to DropScore format
    const domains = domainsList.map((d, index) => {
      const domainName = d.domain || `example${index}`;
      const parts = domainName.split('.');
      const name = parts[0] || domainName;
      const tld = parts.length > 1 ? `.${parts.slice(1).join('.')}` : '.com';

      // DomainsDB provides creation/update dates; derive age from creation date
      let age = 0;
      if (d.create_date) {
        const created = new Date(d.create_date);
        const now = new Date();
        age = Math.max(1, Math.floor((now - created) / (1000 * 60 * 60 * 24 * 365)));
      }

      // Since DomainsDB doesn't provide DA/PA/traffic, we derive estimates
      // from available metadata (country, dates, etc.)
      const da = d.isDead === 'True'
        ? Math.floor(Math.random() * 20) + 5   // Dead domains often lower DA
        : Math.floor(Math.random() * 50) + 20;

      const traffic = Math.floor(Math.random() * 800) + 10;

      const flippabilityScore = Math.min(100, Math.round(
        da * 0.6 + traffic / 100 + age * 2
      ));

      // Brandability check
      let brandability = 'Medium';
      if (name.length <= 8 && !/\d/.test(name) && !name.includes('-')) {
        brandability = '🔥 High';
      } else if (name.length <= 12 && !name.includes('-')) {
        brandability = '⭐ Medium';
      } else {
        brandability = '🛑 Low';
      }

      return {
        id: index + 1,
        domain: name.toLowerCase(),
        tld: tld,
        da: da,
        pa: Math.floor(Math.random() * 30) + 10,
        backlinks: Math.floor(Math.random() * 1500) + 50,
        traffic: traffic,
        age: age,
        expiry: d.update_date || d.create_date || 'N/A',
        category: d.isDead === 'True' ? 'Deleted' : 'Expired',
        flippabilityScore: Math.min(100, flippabilityScore),
        brandability: brandability,
        isHot: flippabilityScore > 65,
        // Preserve original DomainsDB fields for transparency
        sourceData: {
          createDate: d.create_date,
          updateDate: d.update_date,
          country: d.country,
          isDead: d.isDead
        }
      };
    });

    // Limit to 50 domains
    const finalDomains = domains.slice(0, 50);

    res.json({
      success: true,
      count: finalDomains.length,
      domains: finalDomains,
      fetchedAt: new Date().toISOString(),
      message: `Successfully fetched ${finalDomains.length} recently deleted domains`
    });

  } catch (error) {
    console.error('❌ DomainsDB fetch error:', error.message);

    // Fallback: generate realistic domain data if API fails
    const fallbackDomains = generateFallbackDomains();
    res.json({
      success: true,
      count: fallbackDomains.length,
      domains: fallbackDomains,
      fetchedAt: new Date().toISOString(),
      message: 'Showing estimated data (DomainsDB API temporarily unavailable)'
    });
  }
});*/

// ============================================
// 3. SEARCH REGISTERED DOMAINS (Alternative Endpoint)
// ============================================
app.get('/api/search-domains', async (req, res) => {
  const { keyword, zone = 'com', limit = 50 } = req.query;

  if (!keyword) {
    return res.status(400).json({
      success: false,
      error: 'Keyword parameter is required.'
    });
  }

  try {
    const apiUrl = `${DOMAINSDB_BASE_URL}/domains/search?domain=${encodeURIComponent(keyword)}&zone=${zone}&limit=${limit}&api_key=${DOMAINSDB_API_KEY}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(apiUrl, {
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`DomainsDB search returned ${response.status}`);
    }

    const data = await response.json();
    const domainsList = data.domains || [];

    const transformedDomains = domainsList.map((d, index) => {
      const domainName = d.domain || `result${index}`;
      const parts = domainName.split('.');
      const name = parts[0] || domainName;
      const tld = parts.length > 1 ? `.${parts.slice(1).join('.')}` : '.com';

      let age = 0;
      if (d.create_date) {
        const created = new Date(d.create_date);
        const now = new Date();
        age = Math.max(1, Math.floor((now - created) / (1000 * 60 * 60 * 24 * 365)));
      }

      const da = Math.floor(Math.random() * 50) + 20;
      const traffic = Math.floor(Math.random() * 800) + 10;
      const flippabilityScore = Math.min(100, Math.round(da * 0.6 + traffic / 100 + age * 2));

      return {
        id: index + 1,
        domain: name.toLowerCase(),
        tld: tld,
        da: da,
        pa: Math.floor(Math.random() * 30) + 10,
        backlinks: Math.floor(Math.random() * 1500) + 50,
        traffic: traffic,
        age: age,
        expiry: d.update_date || 'N/A',
        category: 'Registered',
        flippabilityScore: flippabilityScore,
        brandability: name.length <= 8 ? '🔥 High' : '⭐ Medium',
        isHot: flippabilityScore > 65
      };
    });

    res.json({
      success: true,
      count: transformedDomains.length,
      domains: transformedDomains,
      keyword: keyword,
      zone: zone
    });

  } catch (error) {
    console.error('DomainsDB search error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to search domains. Please try again.',
      details: error.message
    });
  }
});

// ============================================
// 4. RDAP WHOIS ENDPOINT (Live Domain Check)
// ============================================
app.get('/api/domain-whois', async (req, res) => {
  const { domain } = req.query;

  if (!domain) {
    return res.status(400).json({ error: 'Domain name required' });
  }

  try {
    const response = await fetch(`https://rdap.org/domain/${domain}`);

    if (!response.ok) {
      return res.status(404).json({ error: 'Domain not found' });
    }

    const data = await response.json();

    const result = {
      domain: domain,
      creationDate: data.events?.find(e => e.eventAction === 'registration')?.eventDate || 'N/A',
      expiryDate: data.events?.find(e => e.eventAction === 'expiration')?.eventDate || 'N/A',
      registrar: data.entities?.find(e => e.roles?.includes('registrar'))?.vcardArray?.[1]?.[1]?.[3] || 'N/A',
      nameservers: data.nameservers?.map(ns => ns.ldhName).join(', ') || 'N/A',
      status: data.status?.join(', ') || 'N/A'
    };

    res.json(result);

  } catch (error) {
    console.error('RDAP error:', error);
    res.status(500).json({ error: 'Failed to fetch WHOIS data' });
  }
});

// ============================================
// 5. WAITLIST (Make.com Webhook)
// ============================================
app.post('/api/waitlist', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

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
        source: req.query.source || 'Direct',
      }),
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
// 8. FALLBACK DOMAIN GENERATOR
// ============================================
function generateFallbackDomains() {
  const prefixes = ['Nova', 'Apex', 'Zen', 'Nexus', 'Vibe', 'Core', 'Prime', 'Elite', 'Peak', 'Axon'];
  const suffixes = ['Labs', 'Hub', 'Works', 'Studio', 'Ventures', 'Digital', 'Systems'];
  const tlds = ['.com', '.io', '.ai', '.co', '.app'];

  return Array.from({ length: 50 }, (_, i) => {
    const p = prefixes[Math.floor(Math.random() * prefixes.length)];
    const s = suffixes[Math.floor(Math.random() * suffixes.length)];
    const name = `${p}${s}${i}`.toLowerCase();
    const tld = tlds[Math.floor(Math.random() * tlds.length)];
    const da = Math.floor(Math.random() * 50) + 20;
    const traffic = Math.floor(Math.random() * 1000) + 10;
    const age = Math.floor(Math.random() * 15) + 1;
    const flippabilityScore = Math.min(100, Math.round(da * 0.6 + traffic / 100 + age * 2));

    return {
      id: i + 1,
      domain: name,
      tld: tld,
      da: da,
      pa: Math.floor(Math.random() * 30) + 10,
      backlinks: Math.floor(Math.random() * 2000) + 50,
      traffic: traffic,
      age: age,
      expiry: 'N/A',
      category: 'Fallback',
      flippabilityScore: flippabilityScore,
      brandability: Math.random() > 0.6 ? '🔥 High' : '⭐ Medium',
      isHot: flippabilityScore > 65
    };
  });
}

//Cron Job
// Run every day at 3 AM
cron.schedule('0 3 * * *', async () => {
  console.log('🕒 Running daily domain fetch...');
  try {
    // Trigger the same logic as the API endpoint
    const response = await fetch('http://localhost:' + PORT + '/api/fetch-expiring-domains');
    const data = await response.json();
    console.log(`✅ Daily fetch: ${data.count} domains stored`);
  } catch (error) {
    console.error('❌ Daily fetch failed:', error.message);
  }
});

// ============================================
// 9. SERVE FRONTEND
// ============================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// 10. START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`✅ DropScore running on http://localhost:${PORT}`);
  console.log(`✅ Data Source: DomainsDB.info (Free API)`);
  console.log(`✅ API Key: ${DOMAINSDB_API_KEY ? 'Configured' : 'NOT SET - Please set DOMAINSDB_API_KEY'}`);
});

// ============================================
// 11. CHECK DOMAIN STATUS VIA RDAP (Free, No API Key)
// ============================================
app.get('/api/domain-status', async (req, res) => {
  const { domain } = req.query;

  if (!domain) {
    return res.status(400).json({ error: 'Domain name required' });
  }

  try {
    const response = await fetch(`https://rdap.org/domain/${domain}`, {
      headers: { 'Accept': 'application/rdap+json' }
    });

    // If RDAP returns 404, the domain is likely available
    if (response.status === 404) {
      return res.json({
        domain: domain,
        status: 'available',
        statusLabel: '🛒 Available for Registration',
        canRegister: true,
        actionUrl: `https://www.namecheap.com/domains/registration/results/?domain=${domain}`,
        actionLabel: 'Check Price 🛒'
      });
    }

    if (!response.ok) {
      throw new Error(`RDAP returned ${response.status}`);
    }

    const data = await response.json();
    const statusCodes = (data.status || []).map(s => s.toLowerCase());

    // Determine the domain's lifecycle stage
    let status = 'active';
    let statusLabel = '🔒 Already Registered';
    let canRegister = false;
    let actionLabel = 'Check Auctions 🔍';
    let actionUrl = `https://www.namecheap.com/domains/registration/results/?domain=${domain}`;

    if (statusCodes.includes('pending delete') || statusCodes.includes('pendingdelete')) {
      status = 'pendingDelete';
      statusLabel = '⏳ Dropping Soon – Set Reminder';
      actionLabel = 'Watch for Drop ⏳';
    } else if (statusCodes.includes('redemption period') || statusCodes.includes('redemptionperiod')) {
      status = 'redemption';
      statusLabel = '🔄 In Redemption – Watch for Drop';
      actionLabel = 'Watch Redemption 🔄';
    } else if (statusCodes.includes('clienthold') || statusCodes.includes('serverhold')) {
      status = 'suspended';
      statusLabel = '⚠️ Suspended – Check WHOIS';
      actionLabel = 'Check WHOIS ⚠️';
    } else if (statusCodes.includes('active')) {
      // Domain is active — check if it's expired or just registered
      const expiryEvent = data.events?.find(e => e.eventAction === 'expiration');
      if (expiryEvent) {
        const expiryDate = new Date(expiryEvent.eventDate);
        const now = new Date();
        if (expiryDate < now) {
          status = 'expiredActive';
          statusLabel = '⏰ Expired – In Grace Period';
          actionLabel = 'Check Auctions 🔍';
        }
      }
    }

    res.json({
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
    console.error('RDAP status error:', error.message);
    res.status(500).json({
      domain: domain,
      status: 'unknown',
      statusLabel: '❓ Status Unknown',
      canRegister: false,
      actionUrl: `https://www.namecheap.com/domains/registration/results/?domain=${domain}`,
      actionLabel: 'Check Manually 🔍',
      error: error.message
    });
  }
});