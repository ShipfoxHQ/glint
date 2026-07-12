import {createHash, randomBytes} from 'node:crypto';
import process from 'node:process';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {createPresignedPost} from '@aws-sdk/s3-presigned-post';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
export const REQUIRED_SIGNED_FIELDS = [
  'key',
  'policy',
  'x-amz-algorithm',
  'x-amz-credential',
  'x-amz-date',
  'x-amz-signature',
  'Content-Type',
];

export function validateSignedPost({fields, url}) {
  if (!url || new URL(url).protocol !== 'https:') {
    throw new Error('Signed POST URL must use HTTPS');
  }
  const missing = REQUIRED_SIGNED_FIELDS.filter((field) => !fields[field]);
  if (missing.length > 0) {
    throw new Error(`Signed POST is missing required fields: ${missing.join(', ')}`);
  }
  if (fields['Content-Type'] !== 'image/png') {
    throw new Error('Signed POST must constrain Content-Type to image/png');
  }
}

export function validateSignedReadUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Signed read URL must use HTTPS');
  }
  if (parsed.searchParams.get('X-Amz-Expires') !== '300') {
    throw new Error('Signed read URL must expire after five minutes');
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main() {
  const region = process.env.GLINT_S3_REGION ?? 'eu-central-1';
  const bucket = required('GLINT_S3_BUCKET');
  const endpoint = process.env.GLINT_S3_ENDPOINT;
  const forcePathStyle = process.env.GLINT_S3_FORCE_PATH_STYLE === 'true';
  const client = new S3Client({region, endpoint, forcePathStyle});
  const body = randomBytes(1024);
  const digest = createHash('sha256').update(body).digest('hex');
  const key = `provider-compatibility/${digest}.png`;

  const signed = await createPresignedPost(client, {
    Bucket: bucket,
    Key: key,
    Expires: 300,
    Fields: {'Content-Type': 'image/png'},
    Conditions: [
      ['eq', '$key', key],
      ['eq', '$Content-Type', 'image/png'],
      ['content-length-range', 1, MAX_UPLOAD_BYTES],
    ],
  });
  validateSignedPost(signed);

  const form = new FormData();
  for (const [name, value] of Object.entries(signed.fields)) {
    form.append(name, value);
  }
  form.append('file', new Blob([body], {type: 'image/png'}), `${digest}.png`);

  let uploaded = false;
  let result;
  try {
    const response = await fetch(signed.url, {method: 'POST', body: form});
    if (response.status !== 204) {
      throw new Error(
        `Signed multipart upload returned ${response.status}: ${await response.text()}`,
      );
    }
    uploaded = true;

    const head = await client.send(new HeadObjectCommand({Bucket: bucket, Key: key}));
    if (head.ContentLength !== body.byteLength || head.ContentType !== 'image/png') {
      throw new Error(
        `Uploaded object metadata mismatch: ${JSON.stringify({
          contentLength: head.ContentLength,
          contentType: head.ContentType,
        })}`,
      );
    }
    const signedReadUrl = await getSignedUrl(
      client,
      new GetObjectCommand({Bucket: bucket, Key: key}),
      {expiresIn: 300},
    );
    validateSignedReadUrl(signedReadUrl);
    const readResponse = await fetch(signedReadUrl);
    if (!readResponse.ok) {
      throw new Error(`Signed read returned ${readResponse.status}: ${await readResponse.text()}`);
    }
    const readBody = Buffer.from(await readResponse.arrayBuffer());
    const readDigest = createHash('sha256').update(readBody).digest('hex');
    if (readDigest !== digest) {
      throw new Error('Signed read returned different bytes from the signed upload');
    }
    result = {
      provider: endpoint ? 's3-compatible' : 'aws-s3',
      region,
      bucket,
      key,
      status: response.status,
      readStatus: readResponse.status,
      bytes: body.byteLength,
      contentType: head.ContentType,
      requiredFields: REQUIRED_SIGNED_FIELDS,
      passed: true,
    };
  } finally {
    if (uploaded) {
      await client.send(new DeleteObjectCommand({Bucket: bucket, Key: key}));
    }
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
