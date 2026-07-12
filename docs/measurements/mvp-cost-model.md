# Minimum viable product cost model

Prices were checked on 2026-07-12. They are planning estimates in USD, exclude taxes, and deliberately show list price before AWS free tiers or credits. Workload units come from [`workload.md`](workload.md).

## Price inputs

| Component | Planning rate |
| --- | ---: |
| Neon Launch compute | $0.106 per compute-unit hour |
| Neon storage | $0.35 per GB-month |
| S3 Standard storage | $0.023 per GB-month |
| S3 writes | $0.005 per 1,000 |
| S3 reads | $0.0004 per 1,000 |
| SQS Standard requests | $0.40 per million |
| Lambda x86 compute | $0.0000166667 per GB-second |
| Lambda requests | $0.20 per million |
| API Gateway HTTP API | $1.00 per million for this volume band |
| Route 53 hosted zone | $0.50 per month |

The database planning envelope assumes a 0.25-compute-unit production instance active for eight
hours on 22 working days and 5 GB of metadata: `44 × $0.106 + 5 × $0.35 = $6.414/month`.
Scale-to-zero makes this an upper estimate for a month that stays at minimum compute during every
working hour; idle gaps reduce it. Autoscaling above 0.25 compute units increases it. Actual compute
duty cycle and metadata size replace this assumption after staging.

The API estimate assumes three compatibility API calls per build (`GET project`, create,
update/finalize), 512 MiB, and 100 ms per invocation. This is separate from the workload table's
SQS operations, which count queue send, receive, and delete calls. It excludes reviewer/dashboard
reads and GitHub webhooks because the workload measurement did not observe them.

## Storage and operations

| Scenario | Expected S3 | Conservative S3 | Expected SQS | Conservative SQS |
| --- | ---: | ---: | ---: | ---: |
| 500k | $0.18 | $0.66 | $0.033 | $0.102 |
| 750k | $0.27 | $0.99 | $0.050 | $0.153 |
| 1M | $0.36 | $1.32 | $0.066 | $0.204 |

S3 splits workload object operations into writes `(new source + masks)` and reads/checks `(new source + 2 × diffs)`. For the expected 1M case, that is 2.77 GB, 55,000 writes, and 60,000 reads: `2.77 × $0.023 + 55 × $0.005 + 60 × $0.0004 = $0.363`.

All queue scenarios are below SQS's published one-million-request monthly free tier. The table keeps list price visible so the architecture does not depend on an account-specific allowance.

## Worker and API compute

| Scenario | Expected worker Lambda | Conservative worker Lambda | Compatibility API |
| --- | ---: | ---: | ---: |
| 500k | $0.14 | $1.77 | $0.15 |
| 750k | $0.21 | $2.65 | $0.22 |
| 1M | $0.28 | $3.53 | $0.29 |

Worker cost uses the measured model's worker hours at 1 GiB plus one Lambda request per queue job. The conservative 1M case is `58.33 × 3,600 = 209,988 GB-seconds`, or about `$3.50` compute plus `$0.034` requests. The expected and conservative cases both fit within Lambda's 400,000 GB-second and one-million-request monthly free tier if that account allowance is unused.

## Planning total

| Scenario | Expected | Conservative |
| --- | ---: | ---: |
| 500k | $7.42 | $9.60 |
| 750k | $7.66 | $10.93 |
| 1M | $7.91 | $12.26 |

Totals include the `$6.414` working-hours Neon planning envelope, S3, SQS, worker Lambda,
compatibility API Gateway/Lambda, and one `$0.50` hosted zone. They exclude:

- dashboard/API usage not present in the workload sample;
- Vercel plan charges and client bandwidth;
- reviewer image delivery from S3;
- CloudWatch log ingestion/retention beyond free allowances;
- container registry storage, secrets, backups beyond the selected seven-day restore history,
  support, and taxes.

Those exclusions are measurable staging follow-ups, not provider decisions. Add alarms at `$20`,
`$35`, and `$50` monthly so unknown reader traffic cannot silently dominate the image-processing
estimate.

## Sources

- Neon rates and typical workload examples: <https://neon.com/pricing>
- S3 prices: <https://aws.amazon.com/s3/pricing/>
- SQS prices and free tier: <https://aws.amazon.com/sqs/pricing/>
- Lambda rates and free tier: <https://aws.amazon.com/lambda/pricing/>
- API Gateway HTTP API rates: <https://aws.amazon.com/api-gateway/pricing/>
