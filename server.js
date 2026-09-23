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
var sfToken = null;
var sfInstanceUrl = null;
var sfTokenExpiry = 0;

// DNP cache (refreshes every hour)
var dnpCache = null;
var dnpCacheExpiry = 0;
var DNP_CACHE_DURATION = 60 * 60 * 1000;

function getSalesforceToken() {
  return new Promise(function(resolve, reject) {
    if (sfToken && Date.now() < sfTokenExpiry) {
      return resolve({ token: sfToken, instanceUrl: sfInstanceUrl });
    }
    var loginHost = SF_LOGIN_URL.replace('https://', '');
    var params = 'grant_type=client_credentials&client_id=' + encodeURIComponent(SF_CLIENT_ID) + '&client_secret=' + encodeURIComponent(SF_CLIENT_SECRET);

    var options = {
      hostname: loginHost,
      path: '/services/oauth2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(params)
      }
    };

    var req = https.request(options, function(res) {
      var data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try {
          var parsed = JSON.parse(data);
          if (parsed.access_token) {
            sfToken = parsed.access_token;
            sfInstanceUrl = parsed.instance_url;
            sfTokenExpiry = Date.now() + (55 * 60 * 1000);
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
    req.write(params);
    req.end();
  });
}

function queryDNPFromSalesforce() {
  if (dnpCache && Date.now() < dnpCacheExpiry) {
    return Promise.resolve(dnpCache);
  }

  return getSalesforceToken().then(function(auth) {
    var soql = encodeURIComponent("SELECT Name, Do_not_Poach_End_Date__c, plaunch__LinkedIn__c FROM Account WHERE Do_Not_Poach__c = true");
    var host = auth.instanceUrl.replace('https://', '');

    return new Promise(function(resolve, reject) {
      var options = {
        hostname: host,
        path: '/services/data/v62.0/query?q=' + soql,
        method: 'GET',
        headers: {
          'Authorization': 'Bearer ' + auth.token,
          'Content-Type': 'application/json'
        }
      };

      var req = https.request(options, function(res) {
        var data = '';
        res.on('data', function(chunk) { data += chunk; });
        res.on('end', function() {
          try {
            var parsed = JSON.parse(data);
            if (parsed.records) {
              var header = 'Company,Type,Start Date,End Date,LinkedIn';
              var rows = parsed.records.map(function(r) {
                var name = '"' + (r.Name || '').replace(/"/g, '""') + '"';
                var endDate = r.Do_not_Poach_End_Date__c || '';
                var linkedin = r.plaunch__LinkedIn__c || '';
                return name + ',DNP,,' + endDate + ',' + linkedin;
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
  });
}

var server = require('http').createServer(function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'POST' && req.url === '/company-info') {
    var body = '';
    req.on('data', function(chunk) { body += chunk; });
    req.on('end', function() {
      try {
        var payload = JSON.parse(body);
        var options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          }
        };
        var apiReq = https.request(options, function(apiRes) {
          var data = '';
          apiRes.on('data', function(chunk) { data += chunk; });
          apiRes.on('end', function() {
            if (apiRes.statusCode !== 200) {
              console.error('ANTHROPIC_ERROR status=' + apiRes.statusCode + ' body=' + data);
            }
            res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
            res.end(data);
          });
        });
        apiReq.on('error', function(e) {
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
    queryDNPFromSalesforce()
      .then(function(data) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(data);
      })
      .catch(function(err) {
        console.error('SF DNP fetch failed, falling back to CSV:', err.message);
        try {
          var csvPath = path.join(__dirname, 'dnp.csv');
          var data = fs.readFileSync(csvPath, 'utf8');
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
server.listen(PORT, function() {
  console.log('Server running on port ' + PORT);
});
