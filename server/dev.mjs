// Runs the API locally for development. Same handlers Vercel would run.
import http from 'node:http';
import quote from './api/quote.mjs';

const PORT = Number(process.argv[2] ?? 8790);
http.createServer((req, res) => {
  if (new URL(req.url, 'http://x').pathname === '/api/quote') return quote(req, res).catch((error) => { res.statusCode = 500; res.end(JSON.stringify({ error: String(error.message) })); });
  res.statusCode = 404;
  res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`api on http://127.0.0.1:${PORT}`));
