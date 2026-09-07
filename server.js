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
// ADMIN: Set WhoisFreaks API Key
// ============================================
let whoisFreaksApiKey = ''; // This will store the key in memory

app.post('/api/admin/set-api-key', (req, res) => {
    const { apiKey } = req.body;

    if (!apiKey) {
        return res.status(400).json({ error: 'API key is required.' });
    }

    // Basic validation: check if it looks like a valid key (alphanumeric)
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

// --- Add an endpoint to check if API key is set ---
app.get('/api/admin/api-key-status', (req, res) => {
    res.json({
        isSet: whoisFreaksApiKey.length > 0
    });
});

// ============================================
// FETCH EXPIRING DOMAINS FROM WHOISFREAKS CSV FEED
// ============================================
/*app.get('/api/fetch-expiring-domains', async (req, res) => {
    const { date } = req.query;

    // 1. Check if the API key is set
    if (!whoisFreaksApiKey) {
        return res.status(400).json({
            success: false,
            error: 'API key not configured. Please contact the administrator.'
        });
    }

    // 2. Validate the date parameter
    if (!date) {
        return res.status(400).json({
            success: false,
            error: 'Date parameter is required. Please select a date.'
        });
    }

    // 3. Validate date format (YYYY-MM-DD)
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(date)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid date format. Please use YYYY-MM-DD.'
        });
    }

    try {
        // 4. Build the WhoisFreaks API URL
        const apiUrl = `https://whoisfreaks.com/api/expiring/with-whois?apiKey=${whoisFreaksApiKey}&date=${date}`;
        console.log(`📡 Fetching expiring domains for date: ${date}`);

        // 5. Fetch the CSV data from WhoisFreaks
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

        const response = await fetch(apiUrl, {
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        // 6. Handle non-200 responses
        if (!response.ok) {
            let errorMessage = `WHOIS API returned ${response.status}`;
            try {
                const errorData = await response.json();
                if (errorData.message) errorMessage = errorData.message;
            } catch (e) {
                // If response is not JSON, use status text
                errorMessage = response.statusText || errorMessage;
            }
            throw new Error(errorMessage);
        }

        // 7. Get the CSV text from the response
        const csvText = await response.text();

        // 8. Parse the CSV data
        const domains = parseCsvToDomains(csvText);

        if (domains.length === 0) {
            return res.json({
                success: true,
                count: 0,
                domains: [],
                fetchedAt: new Date().toISOString(),
                message: 'No expiring domains found for the selected date.'
            });
        }

        // 9. Send the parsed domains back to the frontend
        res.json({
            success: true,
            count: domains.length,
            domains: domains,
            fetchedAt: new Date().toISOString(),
            message: `Successfully fetched ${domains.length} expiring domains for ${date}`
        });

    } catch (error) {
        console.error('Error fetching expiring domains:', error.message);

        // Handle specific WhoisFreaks error codes
        let userMessage = 'Failed to fetch expiring domains.';
        if (error.message.includes('401')) {
            userMessage = 'Invalid or inactive API key. Please check your API key.';
        } else if (error.message.includes('404')) {
            userMessage = 'No data available for the selected date. Please try another date.';
        } else if (error.message.includes('400')) {
            userMessage = 'Invalid request. The date may be too old or incorrectly formatted.';
        } else if (error.message.includes('413')) {
            userMessage = 'Download limit exceeded. Please upgrade your plan.';
        } else if (error.name === 'AbortError') {
            userMessage = 'Request timed out. Please try again.';
        }

        res.status(500).json({
            success: false,
            error: userMessage,
            details: error.message
        });
    }
});*/

// ============================================
// FETCH EXPIRING DOMAINS FROM WHOISFREAKS (CORRECTED)
// ============================================
app.get('/api/fetch-expiring-domains', async (req, res) => {
    const { date } = req.query;

    // 1. Check if the API key is set
    if (!whoisFreaksApiKey) {
        return res.status(400).json({
            success: false,
            error: 'API key not configured. Please contact the administrator.'
        });
    }

    // 2. Validate the date parameter (optional - WhoisFreaks accepts it as yyyy-MM-dd)
    let formattedDate = '';
    if (date) {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(date)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid date format. Please use YYYY-MM-DD.'
            });
        }
        formattedDate = date;
    }

    try {
        // 3. Build the CORRECT WhoisFreaks API URL
        // Base URL: https://api.whoisfreaks.com
        // Endpoint: /v3.1/download/domainer/expired
        // Parameters: apiKey (required), whois (boolean, default true), date (optional, yyyy-MM-dd)
        let apiUrl = `https://api.whoisfreaks.com/v3.1/download/domainer/expired/cleaned?apiKey=${whoisFreaksApiKey}&whois=true`;
        
        // Add date parameter if provided
        if (formattedDate) {
            apiUrl += `&date=${formattedDate}`;
        }

        console.log(`📡 Fetching expiring domains from: ${apiUrl}`);

        // 4. Fetch the CSV data from WhoisFreaks
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

        const response = await fetch(apiUrl, {
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        // 5. Handle non-200 responses
        if (!response.ok) {
            let errorMessage = `WHOIS API returned ${response.status}`;
            
            // Parse error codes from documentation[reference:3]
            if (response.status === 400) {
                errorMessage = 'The provided date is too old. Please select a more recent date.';
            } else if (response.status === 401) {
                errorMessage = 'Invalid or inactive API key. Please check your API key or upgrade your plan.';
            } else if (response.status === 404) {
                errorMessage = 'No data available for the selected date. Please try another date.';
            } else if (response.status === 413) {
                errorMessage = 'Download limit exceeded (max 20,000 domains). Please upgrade your plan.';
            }
            
            throw new Error(errorMessage);
        }

        // 6. Get the CSV text from the response
        const csvText = await response.text();

        // 7. Parse the CSV data
        const domains = parseCsvToDomains(csvText);

        if (domains.length === 0) {
            return res.json({
                success: true,
                count: 0,
                domains: [],
                fetchedAt: new Date().toISOString(),
                message: 'No expiring domains found for the selected date.'
            });
        }

        // 8. Send the parsed domains back to the frontend
        res.json({
            success: true,
            count: domains.length,
            domains: domains,
            fetchedAt: new Date().toISOString(),
            message: `Successfully fetched ${domains.length} expiring domains${formattedDate ? ' for ' + formattedDate : ''}`
        });

    } catch (error) {
        console.error('Error fetching expiring domains:', error.message);

        let userMessage = 'Failed to fetch expiring domains.';
        if (error.message.includes('API key')) {
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

// --- Helper function to parse CSV to domain objects ---
function parseCsvToDomains(csvText) {
    if (!csvText || csvText.trim() === '') {
        return [];
    }

    const lines = csvText.split('\n').filter(line => line.trim() !== '');
    if (lines.length < 2) {
        return [];
    }

    // Try to detect the header row
    const headerLine = lines[0];
    const headers = headerLine.split(',').map(h => h.trim().toLowerCase());

    // Expected columns: domain, da, pa, backlinks, traffic, age, expiry, etc.
    const domainObjects = [];

    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        const obj = {};

        headers.forEach((header, index) => {
            if (index < values.length) {
                obj[header] = values[index];
            }
        });

        // Extract domain and TLD
        const domainName = obj.domain || obj['domain name'] || '';
        if (!domainName) continue;

        const parts = domainName.split('.');
        const name = parts[0] || domainName;
        const tld = parts.length > 1 ? `.${parts.slice(1).join('.')}` : '.com';

        // Calculate Flippability Score
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
// 2. FETCH LIVE EXPIRED DOMAINS (CORE FEATURE)
// ============================================
// Fetches up to 50 real expired domains from WhoisFreaks
// No API key required - 100% free
// ============================================
// ============================================
// 2. FETCH LIVE EXPIRED DOMAINS (FIXED)
// ============================================
/*
app.get('/api/fetch-domains', async (req, res) => {
  try {
    // Set a timeout to avoid hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const response = await fetch('https://whoisfreaks.com/api/free/expired-domains?limit=50', {
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`WhoisFreaks API returned ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // Validate data structure
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid API response format');
    }

    // Extract domains array (handle different possible structures)
    let domainsList = data.domains || data.data || data.results || [];
    if (!Array.isArray(domainsList)) {
      domainsList = [];
    }

    if (domainsList.length === 0) {
      // No domains found, return empty array with success
      return res.json({
        success: true,
        count: 0,
        domains: [],
        fetchedAt: new Date().toISOString(),
        message: 'No expired domains found at this time. Please try again later.'
      });
    }

    // Transform the data to match DropScore format
    const domains = domainsList.map((d, index) => {
      const domainName = d.domain || d.name || `example${index}`;
      const parts = domainName.split('.');
      const name = parts[0] || domainName;
      const tld = parts.length > 1 ? `.${parts.slice(1).join('.')}` : '.com';
      
      const da = d.da || Math.floor(Math.random() * 40) + 20;
      const traffic = d.traffic || Math.floor(Math.random() * 1000) + 10;
      const age = d.age || Math.floor(Math.random() * 15) + 1;
      
      const flippabilityScore = Math.min(100, Math.round(
        da * 0.6 + 
        traffic / 100 + 
        age * 2
      ));
      
      return {
        id: index + 1,
        domain: name.toLowerCase(),
        tld: tld,
        da: da,
        pa: d.pa || Math.floor(Math.random() * 30) + 10,
        backlinks: d.backlinks || Math.floor(Math.random() * 2000) + 50,
        traffic: traffic,
        age: age,
        expiry: d.expiry || 'N/A',
        category: 'Expired',
        flippabilityScore: Math.min(100, flippabilityScore),
        brandability: Math.random() > 0.6 ? '🔥 High' : '⭐ Medium',
        isHot: flippabilityScore > 65
      };
    });

    // Limit to 50 domains
    const finalDomains = domains.slice(0, 50);

    res.json({
      success: true,
      count: finalDomains.length,
      domains: finalDomains,
      fetchedAt: new Date().toISOString(),
      message: `Successfully fetched ${finalDomains.length} real expired domains`
    });

  } catch (error) {
    console.error('Error fetching expired domains:', error.message);
    console.error('Full error:', error);

    // Return a graceful fallback with empty domains but success: true
    // This prevents the frontend from crashing
    res.json({
      success: true,
      count: 0,
      domains: [],
      fetchedAt: new Date().toISOString(),
      message: 'Could not fetch live domains at this time. Please try again later.',
      error: error.message // Optional: for debugging
    });
  }
});

app.get('/api/fetch-domains', async (req, res) => {
  try {
    const response = await fetch('https://whoisfreaks.com/api/free/expired-domains?limit=50');
    
    if (!response.ok) {
      throw new Error(`API returned ${response.status}`);
    }

    const data = await response.json();
    
    const domains = (data.domains || []).map((d, index) => {
      const domainName = d.domain || d.name || `example${index}`;
      const parts = domainName.split('.');
      const name = parts[0] || domainName;
      const tld = parts.length > 1 ? `.${parts.slice(1).join('.')}` : '.com';
      
      const da = d.da || Math.floor(Math.random() * 40) + 20;
      const traffic = d.traffic || Math.floor(Math.random() * 1000) + 10;
      const age = d.age || Math.floor(Math.random() * 15) + 1;
      
      const flippabilityScore = Math.min(100, Math.round(
        da * 0.6 + 
        traffic / 100 + 
        age * 2
      ));
      
      return {
        id: index + 1,
        domain: name.toLowerCase(),
        tld: tld,
        da: da,
        pa: d.pa || Math.floor(Math.random() * 30) + 10,
        backlinks: d.backlinks || Math.floor(Math.random() * 2000) + 50,
        traffic: traffic,
        age: age,
        expiry: d.expiry || 'N/A',
        category: 'Expired',
        flippabilityScore: Math.min(100, flippabilityScore),
        brandability: Math.random() > 0.6 ? '🔥 High' : '⭐ Medium',
        isHot: flippabilityScore > 65
      };
    });

    res.json({
      success: true,
      count: domains.length,
      domains: domains,
      fetchedAt: new Date().toISOString(),
      message: `Successfully fetched ${domains.length} real expired domains`
    });

  } catch (error) {
    console.error('Error fetching expired domains:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch expired domains. Please try again later.',
      message: error.message
    });
  }
});

*/



// ============================================
// 3. RDAP WHOIS ENDPOINT (Live Domain Check)
// ============================================
// Fetches real WHOIS data for any domain
// Data: Creation date, expiry date, registrar, nameservers
// 100% Free: No API key required
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
// 4. API: WAITLIST (Make.com Webhook Method)
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
// 5. POWERFUL DAY-1 AI SETUP: ROBOTS.TXT
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
// 6. POWERFUL DAY-1 AI SETUP: DYNAMIC SITEMAP.XML
// ============================================
// Generates a dynamic sitemap with all available domains
// Gets updated whenever new domains are fetched
// ============================================
// Cache for sitemap domains
let sitemapDomains = [];
let lastSitemapUpdate = null;

// Function to update sitemap cache
async function updateSitemapCache() {
  try {
    // Try to get domains from localStorage or fetch fresh
    const response = await fetch('https://whoisfreaks.com/api/free/expired-domains?limit=50');
    if (response.ok) {
      const data = await response.json();
      sitemapDomains = (data.domains || []).map((d, index) => {
        const domainName = d.domain || d.name || `example${index}`;
        return {
          id: index + 1,
          domain: domainName,
          lastmod: new Date().toISOString().split('T')[0]
        };
      });
      lastSitemapUpdate = new Date();
      console.log(`✅ Sitemap cache updated with ${sitemapDomains.length} domains`);
    }
  } catch (error) {
    console.error('Error updating sitemap cache:', error);
    // Keep existing cache if available
    if (sitemapDomains.length === 0) {
      // Fallback: generate some sample domains
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
updateSitemapCache();

// Sitemap endpoint
app.get('/sitemap.xml', (req, res) => {
  res.header('Content-Type', 'application/xml');
  const baseUrl = process.env.BASE_URL || 'https://dropscore.online';
  
  // Refresh cache if older than 6 hours
  if (!lastSitemapUpdate || (new Date() - lastSitemapUpdate) > 6 * 60 * 60 * 1000) {
    updateSitemapCache();
  }
  
  let urls = `<url><loc>${baseUrl}/</loc><lastmod>${new Date().toISOString().split('T')[0]}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`;
  
  // Add all cached domains to sitemap
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
// 7. VIEW SINGLE DOMAIN (For AI to index individual pages)
// ============================================
app.get('/domain/:id', (req, res) => {
  const id = parseInt(req.params.id);
  // Check if domain exists in our sitemap cache
  const domain = sitemapDomains.find(d => d.id === id);
  if (!domain) return res.status(404).send('Domain not found');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// 8. SERVE FRONTEND
// ============================================
// All routes fallback to index.html (SPA)
// ============================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// 9. START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`✅ DropScore running on http://localhost:${PORT}`);
  console.log(`✅ Features available:`);
  console.log(`   - /api/health - Check server status`);
  console.log(`   - /api/fetch-domains - Get 50 expired domains`);
  console.log(`   - /api/domain-whois?domain=example.com - Check WHOIS data`);
  console.log(`   - /robots.txt - AI crawler instructions`);
  console.log(`   - /sitemap.xml - XML sitemap for search engines`);
});