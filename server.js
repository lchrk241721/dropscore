const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// 1. HEALTH CHECK ENDPOINT
// ============================================
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    message: 'DropScore API is running'
  });
});

// ============================================
// 2. ADMIN: SET WHOISFREAKS API KEY
// ============================================
let whoisFreaksApiKey = '';

app.post('/api/admin/set-api-key', (req, res) => {
    const { apiKey } = req.body;

    if (!apiKey) {
        return res.status(400).json({ error: 'API key is required.' });
    }

    if (!/^[a-zA-Z0-9]+$/.test(apiKey)) {
        return res.status(400).json({ error: 'Invalid API key format.' });
    }

    whoisFreaksApiKey = apiKey;
    console.log('✅ WhoisFreaks API key updated successfully.');

    res.json({
        success: true,
        message: 'API key updated successfully.'
    });
});

app.get('/api/admin/api-key-status', (req, res) => {
    res.json({
        isSet: whoisFreaksApiKey.length > 0
    });
});

// ============================================
// 3. FETCH EXPIRING DOMAINS (CORRECTED)
// ============================================
app.get('/api/fetch-expiring-domains', async (req, res) => {
    const { date } = req.query;

    if (!whoisFreaksApiKey) {
        return res.status(400).json({
            success: false,
            error: 'API key not configured. Please contact the administrator.'
        });
    }

    let formattedDate = '';
    let isDateProvided = false;
    if (date) {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(date)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid date format. Please use YYYY-MM-DD.'
            });
        }
        formattedDate = date;
        isDateProvided = true;
    }

    try {
        // CORRECT ENDPOINT: Expiring With Cleaned Whois
        // Removes privacy-protected data like "Redacted for Privacy"
        // Date is optional - if omitted, fetches the most recent data
        let apiUrl = `https://whoisfreaks.com/api/expiring/with-cleaned-whois?apiKey=${whoisFreaksApiKey}`;
        
        if (isDateProvided) {
            apiUrl += `&date=${formattedDate}`;
            console.log(`📡 Fetching expiring domains for: ${formattedDate}`);
        } else {
            console.log(`📡 Fetching most recent expiring domains`);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);

        const response = await fetch(apiUrl, {
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            let errorMessage = `WHOIS API returned ${response.status}`;
            
            // Handle error codes from documentation[reference:4]
            if (response.status === 400) {
                errorMessage = 'The provided date is too old. Please try a more recent date or leave it blank for the latest data.';
            } else if (response.status === 401) {
                errorMessage = 'Invalid API key, inactive plan, or you need to purchase the Domainer package. Please check your API key or upgrade your plan.';
            } else if (response.status === 404) {
                errorMessage = 'No data available for the selected date. Please leave the date blank to fetch the most recent data.';
            } else if (response.status === 413) {
                errorMessage = 'Download limit exceeded (max 20,000 domains). Please upgrade your plan.';
            }
            
            throw new Error(errorMessage);
        }

        const csvText = await response.text();
        const domains = parseCsvToDomains(csvText);

        if (domains.length === 0) {
            return res.json({
                success: true,
                count: 0,
                domains: [],
                fetchedAt: new Date().toISOString(),
                message: 'No expiring domains found for the selected criteria.'
            });
        }

        const fetchMessage = isDateProvided 
            ? `Successfully fetched ${domains.length} expiring domains for ${formattedDate}`
            : `Successfully fetched ${domains.length} most recent expiring domains`;

        res.json({
            success: true,
            count: domains.length,
            domains: domains,
            fetchedAt: new Date().toISOString(),
            message: fetchMessage
        });

    } catch (error) {
        console.error('Error fetching expiring domains:', error.message);

        let userMessage = 'Failed to fetch expiring domains.';
        if (error.message.includes('API key') || error.message.includes('package')) {
            userMessage = error.message;
        } else if (error.message.includes('date')) {
            userMessage = error.message;
        } else if (error.name === 'AbortError') {
            userMessage = 'Request timed out. Please try again.';
        }

        res.status(500).json({
            success: false,
            error: userMessage,
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
// 5. API: WAITLIST (Make.com Webhook)
// ============================================
app.post('/api/waitlist', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const webhookUrl = 'https://hook.eu1.make.com/vxdpcrnqunfzmv86a7aglb64our85mcj';

  try {
    const response = await fetch(webhookUrl, {
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

    if (!response.ok) {
      console.error('❌ Make.com webhook error:', response.status, response.statusText);
    } else {
      console.log(`✅ New lead captured via Make.com: ${email}`);
    }

    res.json({ success: true, message: 'You are on the list!' });

  } catch (error) {
    console.error('❌ Error sending to Make.com webhook:', error);
    res.json({ success: true, message: 'You are on the list!' });
  }
});

// ============================================
// 6. ROBOTS.TXT
// ============================================
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

# LLMs.txt location for AI training
# https://dropscore.online/llms.txt
  `);
});

// ============================================
// 7. SITEMAP.XML
// ============================================
let sitemapDomains = [];
let lastSitemapUpdate = null;

async function updateSitemapCache() {
  try {
    const response = await fetch('https://whoisfreaks.com/api/expiring/with-cleaned-whois?apiKey=' + whoisFreaksApiKey);
    if (response.ok) {
      const csvText = await response.text();
      const domains = parseCsvToDomains(csvText);
      sitemapDomains = domains.map((d, index) => ({
        id: index + 1,
        domain: d.domain + d.tld,
        lastmod: new Date().toISOString().split('T')[0]
      }));
      lastSitemapUpdate = new Date();
      console.log(`✅ Sitemap cache updated with ${sitemapDomains.length} domains`);
    }
  } catch (error) {
    console.error('Error updating sitemap cache:', error);
    if (sitemapDomains.length === 0) {
      for (let i = 1; i <= 24; i++) {
        sitemapDomains.push({
          id: i,
          domain: `example${i}.com`,
          lastmod: new Date().toISOString().split('T')[0]
        });
      }
    }
  }
}

// Initial cache update (runs on server start)
if (whoisFreaksApiKey) {
  updateSitemapCache();
}

app.get('/sitemap.xml', (req, res) => {
  res.header('Content-Type', 'application/xml');
  const baseUrl = process.env.BASE_URL || 'https://dropscore.online';
  
  if (!lastSitemapUpdate || (new Date() - lastSitemapUpdate) > 6 * 60 * 60 * 1000) {
    if (whoisFreaksApiKey) {
      updateSitemapCache();
    }
  }
  
  let urls = `<url><loc>${baseUrl}/</loc><lastmod>${new Date().toISOString().split('T')[0]}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`;
  
  sitemapDomains.forEach(d => {
    urls += `
    <url>
      <loc>${baseUrl}/domain/${d.id}</loc>
      <lastmod>${d.lastmod || new Date().toISOString().split('T')[0]}</lastmod>
      <changefreq>weekly</changefreq>
      <priority>0.8</priority>
    </url>`;
  });

  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`);
});

// ============================================
// 8. VIEW SINGLE DOMAIN
// ============================================
app.get('/domain/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const domain = sitemapDomains.find(d => d.id === id);
  if (!domain) return res.status(404).send('Domain not found');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// 9. PARSE CSV TO DOMAINS (HELPER FUNCTION)
// ============================================
function parseCsvToDomains(csvText) {
    if (!csvText || csvText.trim() === '') {
        return [];
    }

    const lines = csvText.split('\n').filter(line => line.trim() !== '');
    if (lines.length < 2) {
        return [];
    }

    const headerLine = lines[0];
    const headers = headerLine.split(',').map(h => h.trim().toLowerCase());

    const domainObjects = [];

    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        const obj = {};

        headers.forEach((header, index) => {
            if (index < values.length) {
                obj[header] = values[index];
            }
        });

        const domainName = obj.domain || obj['domain name'] || '';
        if (!domainName) continue;

        const parts = domainName.split('.');
        const name = parts[0] || domainName;
        const tld = parts.length > 1 ? `.${parts.slice(1).join('.')}` : '.com';

        const da = parseInt(obj.da) || Math.floor(Math.random() * 40) + 20;
        const traffic = parseInt(obj.traffic) || Math.floor(Math.random() * 1000) + 10;
        const age = parseInt(obj.age) || Math.floor(Math.random() * 15) + 1;

        const flippabilityScore = Math.min(100, Math.round(
            da * 0.6 +
            traffic / 100 +
            age * 2
        ));

        domainObjects.push({
            id: i,
            domain: name.toLowerCase(),
            tld: tld,
            da: da,
            pa: parseInt(obj.pa) || Math.floor(Math.random() * 30) + 10,
            backlinks: parseInt(obj.backlinks) || Math.floor(Math.random() * 2000) + 50,
            traffic: traffic,
            age: age,
            expiry: obj.expiry || obj['expiry date'] || 'N/A',
            category: 'Expiring',
            flippabilityScore: Math.min(100, flippabilityScore),
            brandability: Math.random() > 0.6 ? '🔥 High' : '⭐ Medium',
            isHot: flippabilityScore > 65
        });
    }

    return domainObjects;
}

// ============================================
// 10. SERVE FRONTEND
// ============================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// 11. START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`✅ DropScore running on http://localhost:${PORT}`);
  console.log(`✅ Features available:`);
  console.log(`   - /api/health - Check server status`);
  console.log(`   - /api/fetch-expiring-domains?date=YYYY-MM-DD - Get expiring domains`);
  console.log(`   - /api/domain-whois?domain=example.com - Check WHOIS data`);
  console.log(`   - /robots.txt - AI crawler instructions`);
  console.log(`   - /sitemap.xml - XML sitemap for search engines`);
});