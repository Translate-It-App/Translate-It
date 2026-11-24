# Microsoft Edge concurrency benchmark (2026-11-24)

## Conditions and measurements

The benchmark used Microsoft Edge translation at Optimization Level 3,
English to Persian, with 600 designated targets, batch size 25, and a 5,000
character limit. Lazy loading and automatic DOM translation were disabled.
The fixture contributes three heading/introduction segments in addition to
the 600 designated targets, for 603 translated text segments. This same input
workload was used at every concurrency setting.

| Concurrency | Page workers | Median first visible | Median completion |
| ---: | ---: | ---: | ---: |
| C5 | 2 | 0.502s | 4.187s |
| C6 | 3 | 0.465s | 3.028s |
| C8 | 4 | 0.671s | 2.660s |

C6 reduced median completion time by 27.7% versus the C5 baseline and also
had the fastest first-visible median. C8 completed 0.368s sooner than C6,
but its first-visible median was 0.206s slower and it used one more Page
worker (four rather than three). C6 is therefore the preferred balance in
these measurements: it improves initial responsiveness and completion over
C5 without taking C8's additional concurrent provider capacity. This is a
policy choice supported by directional benchmark evidence, not a latency
guarantee.

## HAR verification

All 12/12 trials and 300/300 HTTP requests succeeded. Each trial used 25
requests: 24 batches of 25 segments and one batch of 3. This is 603 segment
entries per trial, consistent with the fixture's 600 designated targets plus
three heading/introduction segments. Batch payloads were identical across all
trials, and every response count matched its request.

Observed HAR concurrency peaks were:

| Setting | Observed peaks |
| ---: | :--- |
| C5 | `[3, 2, 2, 2]` |
| C6 | `[4, 3, 3, 3]` |
| C8 | `[4, 4, 4, 4]` |

The HAR overlap alone does not establish a scheduler violation. It records
overlapping requests but does not, by itself, attribute them to scheduler
ownership or prove that a worker-cap invariant was breached.

## Limitations

The sample comprises 12 successful trials in total, so the medians are
directional and may vary with backend conditions. The benchmark does not
establish translation-quality differences or guarantee performance on other
pages, network conditions, or service load.
