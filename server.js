// server.js
const https = require('https');
const fs = require('fs');
const path = require('path');
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SF_CLIENT_ID = process.env.SF_CLIENT_ID;
const SF_CLIENT_SECRET = process.env.SF_CLIENT_SECRET;
const SF_LOGIN_URL = process.env.SF_LOGIN_URL;

// Salesforce token cache
let sfToken = null;
let sfInstanceUrl = null;
let sfTokenExpiry = 0;

// DNP cache (refreshes every hour)
let dnpCache = null;
let dnpCacheExpiry = 0;
const DNP_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

async function getSalesforceToken() {
  if (sfToken && Date.now() < sfTokenExpiry) return { token: sfToken, instanceUrl: sfInstanceUrl };

  return new Promise((resolve, reject) => {
    const loginHost = SF_LOGIN_URL.replace('https://', '');
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SF_CLIENT_ID,
      client_secret: SF_CLIENT_SECRET
    });
    const body = params.toString();

    const options = {
      hostname: loginHost,
      path: '/services/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) {
            sfToken = parsed.access_token;
            sfInstanceUrl = parsed.instance_url;
            sfTokenExpiry = Date.now() + (55 * 60 * 1000); // refresh 5 min before expiry
            resolve({ token: sfToken, instanceUrl: sfInstanceUrl });
          } else {
            console.error('SF auth failed:', data);
            reject(new Error('Salesforce auth failed'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function queryDNPFromSalesforce() {
  if (dnpCache && Date.now() < dnpCacheExpiry) return dnpCache;

  const { token, instanceUrl } = await getSalesforceToken();
  const soql = encodeURIComponent(
    "SELECT Name, Do_not_Poach_End_Date__c FROM Account WHERE Do_Not_Poach__c = true"
  );
  const host = instanceUrl.replace('https://', '');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      path: '/services/data/v62.0/query?q=' + soql,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.records) {
            // Build CSV format: Name,,,EndDate (matching existing CSV structure)
            const header = 'Company,Type,Start Date,End Date';
            const rows = parsed.records.map(r => {
              const name = '"' + (r.Name || '').replace(/"/g, '""') + '"';
              const endDate = r.Do_not_Poach_End_Date__c || '';
              return name + ',DNP,,' + endDate;
            });
            dnpCache = header + '\n' + rows.join('\n');
            dnpCacheExpiry = Date.now() + DNP_CACHE_DURATION;
            console.log('DNP list refreshed from Salesforce:', parsed.records.length, 'companies');
            resolve(dnpCache);
          } else {
            console.error('SF query error:', data);
            reject(new Error('Salesforce query failed'));
          }
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const server = require('http').createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'POST' && req.url === '/company-info') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          }
        };
        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              console.error('ANTHROPIC_ERROR status=' + apiRes.statusCode + ' body=' + data);
            }
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });
        apiReq.on('error', (e) => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        });
        apiReq.write(JSON.stringify(payload));
        apiReq.end();
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/dnp-list') {
    // Try Salesforce first, fall back to CSV
    queryDNPFromSalesforce()
      .then(data => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(data);
      })
      .catch(err => {
        console.error('SF DNP fetch failed, falling back to CSV:', err.message);
        try {
          const csvPath = path.join(__dirname, 'dnp.csv');
          const data = fs.readFileSync(csvPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(data);
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Could not load DNP list' }));
        }
      });
  } else {
    res.writeHead(404);
    res.end();
  }
});
server.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
