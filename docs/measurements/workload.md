# Production workload envelope

This report uses one week of real visual-test traffic. It turns that traffic
into estimates for storage, queues, and workers. We can use it to choose
hosting and test worker runtimes. We do not need a new monitoring system.

## What this tells us

- Current traffic is close to 500,000 screenshots per month.
- A typical build is small, but traffic arrives in sharp bursts. The busiest
  minute contained 1,838 screenshots.
- More than 99% of screenshots matched their baseline exactly. Most requests
  only need metadata work. They do not need a pixel comparison.
- At one million screenshots per month, the expected model needs about 2.8 GB
  of live source and diff storage, 55,000 queue jobs, and 4.5 worker hours.
- The stress model assumes much less image reuse. It needs 17 GB of live
  storage, 170,000 queue jobs, and 58 worker hours.
- Worker tests should include a burst of 143 jobs, long images, transparent
  images, dimension changes, noisy images, and invalid files.

These numbers are for planning. They do not set file-size or memory limits.
Worker tests must set those safety limits.

## Sources and sampling method

The seven-day window starts at `2026-07-04T09:30:00Z`. It ends just before
`2026-07-11T09:30:00Z`.

1. We paged every build in the
   [Argos `shipfox/platform` project](https://app.argos-ci.com/shipfox/platform/builds)
   during the window. We saved timestamps, build states, and total screenshot
   counts. We did not save names, commits, branches, image URLs, or pixels.
2. We measured active builds from `createdAt → finalizedAt`. We measured image
   processing from `finalizedAt → concludedAt`. Minute peaks group builds by
   their UTC start minute.
3. The image sample has 178 new screenshots from 11 builds. They came from the
   successful main CI run
   [29147363313](https://github.com/ShipfoxHQ/shipfox/actions/runs/29147363313).
   Argos supplied the image dimensions. A one-byte request supplied the size of
   each stored file. We did not keep the image.
4. Argos file paths include a fingerprint of the image bytes. We used that
   fingerprint to detect reuse. A new image counts as reused when its
   fingerprint exists in the baseline set. An exact baseline match means both
   fingerprints are the same.

The image sample is smaller than the traffic sample. It answers size and shape
questions without downloading a week of private images. The committed
[benchmark corpus](../../benchmarks/corpus/v1/README.md) is fully synthetic. It
contains no Shipfox or customer data.

## Observed workload

The week contained 6,350 builds and 132,026 screenshots. The same weekly rate
would produce 574,077 screenshots in an average month. This supports using
500,000 screenshots as the planning floor.

| Measurement | Result |
| --- | ---: |
| Builds/week | 6,350 |
| Screenshots/week | 132,026 |
| Screenshots/build median | 6 |
| Screenshots/build mean | 21 |
| Screenshots/build P95 | 88 |
| Screenshots/build P99 | 390 |
| Screenshots/build maximum | 400 |
| Peak builds created in one minute | 20 |
| Screenshots in that peak creation minute | 1,838 |
| Peak concurrent uploading builds | 2 builds / 760 screenshots |
| Peak concurrent processing builds | 6 builds / 482 screenshots |

The baseline is the last accepted image. The new image comes from the current
build.

| Outcome | Count | Share of screenshots |
| --- | ---: | ---: |
| Baseline and new image have identical bytes | 131,019 | 99.237% |
| Existing image changed | 640 | 0.485% |
| New image added | 193 | 0.146% |
| Baseline image removed | 174 | 0.132% |
| Processing failed | 0 | 0.000% |

In the 178-image sample, 96.63% of new images were already in the baseline set.
The same share had an exact baseline match. The sample had 157 distinct new
images. That is 88.20% of the sample. The full-week match rate is more useful
for planning. The smaller sample came from a main run with new package changes.

## Optimized image distribution

The file-size values cover the 157 distinct new images. The width, height, and
pixel values cover all 178 new screenshots.

| Metric | Median | P95 | P99 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Optimized bytes | 31,928 | 81,187 | 162,516 | 162,751 |
| Width | 1,200 | 1,280 | 1,280 | 1,280 |
| Height | 900 | 947 | 1,468 | 1,804 |
| Decoded pixels | 1,080,000 | 1,136,400 | 1,761,600 | 2,164,800 |

The mean stored size was 40,897 bytes. The expected cost model uses that value.
The stress model uses P95 instead. Neither value is a decoder safety limit. The
test set also has a 1,200×4,000 long page. It has a 4,096×4,096 image that is
small on disk. Worker tests can use them to measure memory and error isolation.

## Monthly scenarios and burst envelope

Build counts use the measured mean of 21 screenshots per build. Steady rates
use 30.4375 days per month. The 500k case keeps the measured burst peak. Larger
cases scale that peak with volume. Monthly averages alone are not safe sizing
inputs.

| Scenario | Builds/month | Average screenshots/min | Peak builds/min target | Peak screenshots/min target | Concurrent processing target |
| --- | ---: | ---: | ---: | ---: | ---: |
| 500k | 23,810 | 11.4 | 20 | 1,838 | 6 builds / 482 screenshots |
| 750k | 35,715 | 17.1 | 27 | 2,402 | 8 builds / 630 screenshots |
| 1M | 47,620 | 22.8 | 35 | 3,202 | 11 builds / 840 screenshots |

In the 1M stress case, a processing burst creates 126 file-check jobs. It also
creates 17 pixel-diff jobs. That is 143 jobs arriving together. Worker tests
should run this burst. They should also run the P99, long-page, transparent,
dimension-change, noisy, and corrupt cases on their own.

## Monthly infrastructure load

The expected case stays close to the measured week. The stress case assumes
less reuse, larger files, and slower workers.

| Input | Expected planning value | Conservative bound | Evidence |
| --- | ---: | ---: | --- |
| Image already stored | 95% | 85% | 96.63% sampled |
| Baseline and new image are identical | 99.0% | 98.0% | 99.237% across week |
| Images requiring pixel comparison | 0.5% | 2.0% | 0.485% across week |
| Encoded bytes per new source/mask | 40,897 | 81,187 | sampled mean / P95 |
| Artifact retention in live storage | 37 days | 37 days | 30-day root + 7-day deletion grace |
| Verification worker time | 0.25 s | 1.0 s | provisional; replace after benchmarking |
| Diff worker time | 0.75 s | 3.0 s | provisional; replace after benchmarking |

The tables below estimate billable units. They are not vendor prices. A hosting
review can apply current local prices without repeating the traffic research.

Expected model:

| Scenario | New source writes | Changed diffs/masks | Live source+mask GB | Object operations | Queue jobs / API ops | Worker hours |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 500k | 25,000 | 2,500 | 1.39 | 57,500 | 27,500 / 82,500 | 2.26 |
| 750k | 37,500 | 3,750 | 2.08 | 86,250 | 41,250 / 123,750 | 3.39 |
| 1M | 50,000 | 5,000 | 2.77 | 115,000 | 55,000 / 165,000 | 4.51 |

Conservative model:

| Scenario | New source writes | Changed diffs/masks | Live source+mask GB | Object operations | Queue jobs / API ops | Worker hours |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 500k | 75,000 | 10,000 | 8.51 | 180,000 | 85,000 / 255,000 | 29.17 |
| 750k | 112,500 | 15,000 | 12.77 | 270,000 | 127,500 / 382,500 | 43.75 |
| 1M | 150,000 | 20,000 | 17.02 | 360,000 | 170,000 / 510,000 | 58.33 |

Calculations:

- New file writes equal screenshots × `(1 - reuse rate)`.
- Diff jobs and mask writes equal screenshots × the changed-image rate.
- Live GB equals `(new files + masks) × bytes × 37/30 ÷ 1e9`.
- Storage calls include writes and file-check reads. Each diff adds two reads
  and one mask write. The short formula is `2 × files + 3 × diffs`.
- Queue jobs include file checks and diffs. Queue API calls assume one send,
  receive, and delete for each successful job. Retries are extra.
- Worker time includes both file checks and diffs.

Current baselines add a small permanent storage root. It is outside the 37-day
estimate. We saw 16 build names and a P99 of 390 screenshots per build. If none
of those files are shared, they use about 0.26–0.51 GB.

## Conservative interpretation and follow-up boundary

- The seven-day outcome counts are exact. The monthly cases are planning
  volumes, not forecasts.
- Image reuse comes from comparing new file fingerprints with baseline file
  fingerprints. It does not come from upload responses. The model rounds below
  the measured reuse rate. It also tests an 85% reuse rate.
- Peak activity is what Argos saw at build boundaries. CI may capture images
  earlier. Glint must still absorb the measured burst and the scaled 1M burst.
- File size and dimensions come from a sample. They support cost estimates.
  They do not define rejection limits. Worker tests must set byte, pixel,
  width, height, timeout, memory, disk, and concurrency limits.
- This work adds no collector, dashboard, or scheduled query. Repeat the
  measurement before a major hosting choice or after a large traffic change.
