import express from "express";
import axios from "axios";
import fs from "fs";
import https from "https";

const TARGET_BASE_URL = process.env.TARGET_BASE_URL || "http://127.0.0.1:8188";

// Express app setup
const app = express();
app.use(express.json());

// HTTPS server options with client authentication
const httpsOptions = {
  // Server's own certificates
  key: fs.readFileSync(process.env.SERVER_KEY || 'keys/server-key.pem'),
  cert: fs.readFileSync(process.env.SERVER_CERT || 'keys/server-cert.pem'),
  
  // Client authentication settings
  requestCert: true,  // Require client certificate
  rejectUnauthorized: true,  // Reject requests without valid client certificates
  ca: [fs.readFileSync(process.env.CA_CERT || 'keys/ca-cert.pem')]  // Certificate authority that signed client certs
};

// Middleware to verify client certificate
app.use((req, res, next) => {
  const cert = req.socket.getPeerCertificate();
  
  if (!cert || !req.client.authorized) {
    res.status(401).json({ error: 'Invalid client certificate' });
    return;
  }
  
  // You can also check specific certificate properties
  console.log('Client Certificate CN:', cert.subject.CN);
  next();
});

// Headers we don't want to forward from the original request
const excludedRequestHeaders = [
  'host',
  'connection',
  'content-length',
  'transfer-encoding'
];

// Headers we don't want to forward from the target response
const excludedResponseHeaders = [
  'transfer-encoding',
  'connection',
  'content-encoding'
];

// Proxy middleware
async function proxyRequest(req, res) {
  const targetUrl = TARGET_BASE_URL + req.url;

  //console.log("request body: ", req.body);
  
  // Filter and prepare request headers
  const headers = Object.entries(req.headers)
    .filter(([key]) => !excludedRequestHeaders.includes(key.toLowerCase()))
    .reduce((acc, [key, value]) => {
      acc[key] = value;
      return acc;
    }, {});

  try {
    const response = await axios({
      method: req.method,
      url: targetUrl,
      data: req.body,
      headers: {
        ...headers,
        host: new URL(targetUrl).host
      },
      validateStatus: false,
      // Important: get the raw response headers
      maxRedirects: 0,
      decompress: false,
      responseType: 'arraybuffer'
    });
    
    // Forward all response headers except excluded ones
    Object.entries(response.headers)
      .filter(([key]) => !excludedResponseHeaders.includes(key.toLowerCase()))
      .forEach(([key, value]) => {
        res.setHeader(key, value);
      });

    
    // Set the correct status code
    res.status(response.status);

    // Handle different content types appropriately
    const contentType = response.headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      // Parse JSON responses
      const data = JSON.parse(response.data.toString());
      res.json(data);
    } else {
      // Send raw data for other content types
      res.send(response.data);
    }
  } catch (error) {
    console.error('Proxy error:', error.message);
    res.status(500).json({ error: 'Proxy request failed' });
  }
}

// Route all requests through proxy
app.all('*', proxyRequest);

// Start HTTPS server
const PORT = process.env.PORT || 3000;
const server = https.createServer(httpsOptions, app);

server.listen(PORT, () => {
  console.log(`HTTPS proxy server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM signal. Closing server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});