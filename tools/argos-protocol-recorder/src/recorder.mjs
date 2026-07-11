import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {Readable} from 'node:stream';

const TOKEN = '0123456789012345678901234567890123456789';

function sanitizeHeader(name, value, requestIds) {
  if (name === 'authorization') {
    const token = value.replace(/^Bearer\s+/i, '');
    return `Bearer <redacted:${token.length}-character-token>`;
  }
  if (name === 'content-type') {
    return value.replace(/boundary=[^;]+/i, 'boundary=<multipart-boundary>');
  }
  if (name === 'x-argos-request-id') {
    if (!requestIds.has(value)) {
      requestIds.set(value, `<request-id-${requestIds.size + 1}>`);
    }
    return requestIds.get(value);
  }
  return value;
}

function sanitizeUrl(value, origin) {
  if (!value.startsWith(origin)) return value;
  const url = new URL(value);
  if (url.pathname.startsWith('/signed-upload/')) return '<signed-upload-url>';
  return `<recorder-origin>${url.pathname}`;
}

function sanitizeValue(value, origin) {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, origin));
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? sanitizeUrl(value, origin) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === 'fields' && item && typeof item === 'object' && !Array.isArray(item)) {
        return [
          key,
          Object.fromEntries(
            Object.keys(item).map((field) => [
              field,
              field.toLowerCase() === 'content-type'
                ? item[field]
                : `<redacted-signed-field:${field}>`,
            ]),
          ),
        ];
      }
      return [key, sanitizeValue(item, origin)];
    }),
  );
}

async function parseRequestBody(request, contentType) {
  if (request.method === 'GET' || request.method === 'HEAD') return null;
  const webRequest = new Request('http://recorder.invalid', {
    method: request.method,
    headers: request.headers,
    body: Readable.toWeb(request),
    duplex: 'half',
  });
  if (contentType.includes('application/json')) {
    const text = await webRequest.text();
    return text ? JSON.parse(text) : null;
  }
  if (contentType.includes('multipart/form-data')) {
    const form = await webRequest.formData();
    const fields = {};
    let file = null;
    for (const [name, value] of form.entries()) {
      if (typeof value === 'string') {
        fields[name] = name.toLowerCase() === 'content-type' ? value : `<redacted:${name}>`;
      } else {
        const bytes = new Uint8Array(await value.arrayBuffer());
        file = {
          field: name,
          filename: '<generated-upload-filename>',
          contentType: value.type,
          size: value.size,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }
    }
    return {fields, file};
  }
  const body = await webRequest.text();
  return body || null;
}

function buildResponse(scenario, buildId) {
  return {
    id: buildId,
    status: scenario.outcome ?? 'pending',
    url: `http://127.0.0.1.invalid/builds/${buildId}`,
  };
}

function uploadFields(key, contentType) {
  return {
    key: `recordings/${key}`,
    policy: 'recorder-policy',
    'x-amz-algorithm': 'AWS4-HMAC-SHA256',
    'x-amz-credential': 'recorder-credential',
    'x-amz-date': '20260711T000000Z',
    'x-amz-signature': 'recorder-signature',
    'Content-Type': contentType,
  };
}

export function createProtocolRecorder(scenario) {
  const exchanges = [];
  const requestIds = new Map();
  const attempts = new Map();
  let origin = null;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', origin);
      const routeKey = `${request.method} ${url.pathname}`;
      const attempt = attempts.get(routeKey) ?? 0;
      attempts.set(routeKey, attempt + 1);
      const contentType = request.headers['content-type'] ?? '';
      const body = await parseRequestBody(request, contentType);
      const headers = {};
      for (const name of [
        'accept',
        'authorization',
        'content-type',
        'user-agent',
        'x-argos-request-id',
        'x-argos-retry-attempt',
      ]) {
        const value = request.headers[name];
        if (typeof value === 'string') headers[name] = sanitizeHeader(name, value, requestIds);
      }
      const exchange = {
        sequence: exchanges.length + 1,
        request: {
          method: request.method,
          path: url.pathname,
          headers,
          body,
        },
        response: null,
      };
      exchanges.push(exchange);

      const send = (status, responseBody = null) => {
        exchange.response = {
          status,
          headers: responseBody === null ? {} : {'content-type': 'application/json'},
          body: sanitizeValue(responseBody, origin),
        };
        response.statusCode = status;
        if (responseBody === null) {
          response.end();
          return;
        }
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(responseBody));
      };

      if (scenario.retryRoute === routeKey && attempt === 0) {
        send(500, {
          error: 'temporary recorder failure',
          details: [{message: 'retry this request'}],
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v2/project') {
        send(
          200,
          scenario.minimalResponses
            ? {hasRemoteContentAccess: true}
            : {
                id: 'project-recording',
                account: {id: 'account-recording', slug: 'recording'},
                name: 'Argos protocol recording',
                defaultBaseBranch: 'main',
                hasRemoteContentAccess: true,
              },
        );
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v2/builds') {
        const buildId = `build-${scenario.name}`;
        if (body?.skipped) {
          send(201, {build: buildResponse({...scenario, outcome: 'skipped'}, buildId)});
          return;
        }
        const requestedScreenshots = Array.isArray(body?.screenshots) ? body.screenshots : [];
        const screenshots =
          scenario.uploads === 'none'
            ? []
            : requestedScreenshots.map((screenshot) => ({
                key: screenshot.key,
                postUrl: `${origin}/signed-upload/${screenshot.key}`,
                fields: uploadFields(screenshot.key, screenshot.contentType),
              }));
        send(201, {
          build: scenario.minimalResponses ? {id: buildId} : buildResponse(scenario, buildId),
          screenshots,
          pwTraces: [],
        });
        return;
      }

      if (request.method === 'PUT' && url.pathname.startsWith('/v2/builds/')) {
        const buildId = url.pathname.slice('/v2/builds/'.length);
        if (buildId === 'undefined') {
          send(404, {error: 'build id is required'});
          return;
        }
        send(200, {
          build: scenario.minimalResponses
            ? {url: `http://127.0.0.1.invalid/builds/${buildId}`}
            : buildResponse(scenario, buildId),
        });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v2/builds/finalize') {
        send(200, {
          builds: [buildResponse(scenario, `build-${scenario.name}`)],
        });
        return;
      }

      if (request.method === 'POST' && url.pathname.startsWith('/signed-upload/')) {
        if (scenario.uploads === 'fail') {
          send(503, {
            error: 'signed upload unavailable',
            details: [{message: 'fixture-induced upload failure'}],
          });
          return;
        }
        send(204);
        return;
      }

      send(404, {error: `unhandled recorder route: ${routeKey}`});
    } catch (error) {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({error: error instanceof Error ? error.message : String(error)}));
    }
  });

  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Recorder did not bind a port');
      origin = `http://127.0.0.1:${address.port}`;
      return `${origin}/v2/`;
    },
    async stop() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    recording(result) {
      const canonicalExchanges = [];
      for (let index = 0; index < exchanges.length; ) {
        if (!exchanges[index].request.path.startsWith('/signed-upload/')) {
          canonicalExchanges.push(exchanges[index]);
          index += 1;
          continue;
        }
        const uploads = [];
        while (index < exchanges.length && exchanges[index].request.path.startsWith('/signed-upload/')) {
          uploads.push(exchanges[index]);
          index += 1;
        }
        uploads.sort((left, right) => {
          if (left.request.path < right.request.path) return -1;
          if (left.request.path > right.request.path) return 1;
          return 0;
        });
        canonicalExchanges.push(...uploads);
      }
      for (const [index, exchange] of canonicalExchanges.entries()) exchange.sequence = index + 1;
      return {
        schemaVersion: 1,
        scenario: scenario.name,
        producer: scenario.producer,
        expectedFailure: Boolean(scenario.expectedFailure),
        result,
        exchanges: canonicalExchanges,
      };
    },
  };
}

export function recorderToken() {
  return TOKEN;
}
