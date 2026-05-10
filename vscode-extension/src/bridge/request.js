const { MAX_REQUEST_BODY_BYTES } = require('../common/constants');

class HttpRequestError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = 'HttpRequestError';
    this.statusCode = statusCode;
  }
}

function requestError(message, statusCode) {
  return new HttpRequestError(message, statusCode);
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let receivedBytes = 0;
    let rejected = false;

    req.on('data', (chunk) => {
      if (rejected) return;
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        req.destroy();
        reject(requestError('request body too large', 413));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on('end', () => {
      if (rejected) return;
      try {
        const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(requestError('invalid JSON request body', 400));
      }
    });

    req.on('error', (error) => {
      if (!rejected) reject(error);
    });
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

module.exports = {
  HttpRequestError,
  requestError,
  readRequestJson,
  sendJson,
};
