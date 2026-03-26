// server.js

const https = require('https');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const server = require('http').createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
      const { company } = JSON.parse(body);

      const prompt = `Return a JSON object about "${company}" with exactly these keys:
- description: 2-3 sentence summary of what the company does
- fundingRound: latest funding round (e.g. Series B, Seed, IPO, Public)
- lastFunded: approximate date of last funding (e.g. March 2022)
- employees: approximate employee count or range (e.g. 500-1000)

Respond with only the JSON object, no other text.`;

      const payload = JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [{ role: 'user', content: prompt }]
      });

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
          try {
            const parsed = JSON.parse(data);
            const text = parsed.content[0].text;
            const companyData = JSON.parse(text);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(companyData));
          } catch (e) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to parse response' }));
          }
        });
      });

      apiReq.on('error', (e) => {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });

      apiReq.write(payload);
      apiReq.end();
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
