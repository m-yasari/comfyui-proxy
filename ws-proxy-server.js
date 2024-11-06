import { WebSocketServer, WebSocket } from 'ws';
import https from 'https';
import url from 'url';
import fs from 'fs';

// Configuration
const PROXY_PORT = 3001;
const TARGET_URL = process.env.targetUrl || 'ws://localhost:8188';

// SSL Configuration
const SSL_CONFIG = {
    // Server's own certificates
    cert: fs.readFileSync("keys/server-cert.pem"),
    key: fs.readFileSync("keys/server-key.pem"),
    
    // CA cert that signed client certificates
    ca: fs.readFileSync("keys/ca-cert.pem"),
    
    // Request client certificate
    requestCert: true,
    
    // Reject connections without valid client certificate
    rejectUnauthorized: true
};

// Create an HTTPS server with SSL configuration
const server = https.createServer(SSL_CONFIG);

// Create a WebSocket server attached to the HTTPS server
const wsServer = new WebSocketServer({ 
    server,
    // Custom verification function for WebSocket upgrade requests
    verifyClient: (info, callback) => {
        const cert = info.req.socket.getPeerCertificate();
        
        if (info.req.client.authorized) {
            console.log('Client authorized with certificate:');
            console.log('- Subject:', cert.subject);
            console.log('- Issuer:', cert.issuer);
            console.log('- Valid until:', cert.valid_to);
            callback(true);
        } else {
            console.log('Client certificate validation failed');
            callback(false, 401, 'Client certificate authentication failed');
        }
    }
});

// Certificate revocation list (CRL) checking
function isCertificateRevoked(cert) {
    // Implementation of CRL checking logic
    // This is a placeholder - implement according to your CRL management system
    const revokedCerts = new Set([
        // Add known revoked certificate serial numbers
        // 'SERIALNUMBER1',
        // 'SERIALNUMBER2'
    ]);
    
    return revokedCerts.has(cert.serialNumber);
}

// Handle new WebSocket connections
wsServer.on('connection', (clientWs, request) => {
    const cert = request.socket.getPeerCertificate();
    console.log(`Client connected with certificate CN=${cert.subject.CN}`);
    
    // Additional security check - CRL
    if (isCertificateRevoked(cert)) {
        console.log('Certificate has been revoked');
        clientWs.close(1008, 'Certificate revoked');
        return;
    }
    
    // Parse the target URL from the request or use default
    const targetUrl = url.parse(request.url).query 
        ? `${TARGET_URL}${request.url}` 
        : TARGET_URL;
    
    // Connect to the target WebSocket server
    const targetWs = new WebSocket(targetUrl, {
        // Optional: Add client certificate for target server if needed
        // cert: fs.readFileSync(path.join(__dirname, 'certs', 'proxy-client.crt')),
        // key: fs.readFileSync(path.join(__dirname, 'certs', 'proxy-client.key')),
        rejectUnauthorized: false // Change to true if target server uses valid SSL
    });
    
    // Handle connection to target
    targetWs.on('open', () => {
        console.log(`Proxy established for client ${cert.subject.CN}`);
        
        // Forward messages from client to target
        clientWs.on('message', (message) => {
            console.log(`checkpoint 1:`, message.toString());
            if (targetWs.readyState === WebSocket.OPEN) {
                console.log(`Forwarding to target from ${cert.subject.CN}:`, message.toString());
                targetWs.send(message);
            }
        });
        
        // Forward messages from target to client
        targetWs.on('message', (message) => {
            console.log(`checkpoint 2:`, message.toString());
            if (clientWs.readyState === WebSocket.OPEN) {
                console.log(`Forwarding to client ${cert.subject.CN}:`, message.toString());
                clientWs.send(message);
            }
        });
    });
    
    // Enhanced error handling with certificate info
    targetWs.on('error', (error) => {
        console.error(`Target connection error for client ${cert.subject.CN}:`, error);
        clientWs.close(1011, 'Target connection error');
    });
    
    clientWs.on('error', (error) => {
        console.error(`Client connection error for ${cert.subject.CN}:`, error);
        targetWs.close();
    });
    
    // Handle connection closures
    clientWs.on('close', (code, reason) => {
        console.log(`Client ${cert.subject.CN} disconnected:`, code, reason);
        targetWs.close();
    });
    
    targetWs.on('close', (code, reason) => {
        console.log(`Target disconnected for client ${cert.subject.CN}:`, code, reason);
        clientWs.close();
    });
});

// Start the server
server.listen(PROXY_PORT, () => {
    console.log(`Secure WebSocket proxy server running on port ${PROXY_PORT}`);
});

// Error handling for the server
server.on('error', (error) => {
    console.error('Server error:', error);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Received SIGTERM signal. Closing server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});