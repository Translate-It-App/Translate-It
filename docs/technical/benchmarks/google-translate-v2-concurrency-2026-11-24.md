# Google Translate V2 concurrency benchmark (2026-11-24)

## Conditions and measurements

The benchmark used Google Translate V2 at Optimization Level 3, English to
Persian, client `t`, with 600 designated targets and 603 translated segments.
The extra three segments are fixture heading/introduction text. Batch size was
25, character limit 5,000, and both lazy loading and automatic DOM translation
were disabled. Each concurrency setting used the identical input workload.

| Concurrency | Page workers | Median first visible | Median completion |
| ---: | ---: | ---: | ---: |
| C4 | 2 | 1.303s | 3.586s |
| C6 | 3 | 1.425s | 2.902s |
| C8 | 4 | 1.404s | 2.599s |

C6 reduced median completion time by 19.1% versus C4. Its first-visible
median was 0.122s slower than C4 and 0.021s slower than C8; C8 completed
0.303s sooner than C6 while using one additional Page worker. C6 is the
benchmark-selected balance: it substantially improves completion over C4
with three workers, while C8's additional completion gain comes with another
concurrent worker and no meaningful first-visible improvement. This is
directional evidence, not a latency guarantee.

## HAR verification

All 12/12 trials and 324/324 HTTP requests succeeded. Each trial issued 27
requests carrying 603 segments. All concurrency settings used identical input
workloads, and all response source texts matched after whitespace
normalization. No HTTP 429 responses occurred.

Observed HAR concurrency peaks were:

| Setting | Observed peaks |
| ---: | :--- |
| C4 | `[3, 2, 2, 2]` |
| C6 | `[3, 3, 3, 3]` |
| C8 | `[5, 4, 4, 4]` |

These are observed overlapping HTTP requests, not direct scheduler-worker
counts; the HAR peaks alone do not establish a worker-cap violation.

## Interpretation and limitations

The sample comprises 12 successful trials in total. Backend variability and
the small sample limit confidence in the medians; results may differ under
other service load, networks, or workloads. Translation quality was not
compared.

This benchmark supports Google Translate V2's Level 3 C6 selection only.
Google Classic uses the same `[1, 2, 6, 7, 8]` curve for consistency, not
because this V2 benchmark validates its performance. Level 4 C7 is an
unvalidated policy choice.
