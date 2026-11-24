# Yandex Translate concurrency benchmark (2026-11-24)

## Conditions and measurements

The benchmark used Yandex Translate at Optimization Level 3, English to
Persian, with 600 designated targets and 603 translated segments. Batch size
was 25, character limit 10,000, and both lazy loading and automatic DOM
translation were disabled. Each concurrency setting used the identical
translation workload.

| Concurrency | Page workers | Median first visible | Median completion |
| ---: | ---: | ---: | ---: |
| C4 | 2 | 0.308s | 4.297s |
| C6 | 3 | 0.375s | 2.452s |
| C8 | 4 | 0.399s | 2.451s |

C6 reduced observed median completion time by 42.9% versus C4. C8 improved
completion by only 0.001s over C6 while using one additional Page worker, so
the additional concurrency provided negligible observed benefit. These are
directional results, not latency guarantees.

## HAR verification

All 12/12 trials succeeded. The 300/300 requests returned HTTP 200 and Yandex
JSON `code: 200`; response counts and translated-text validation passed.
Each trial issued 25 requests: 24 batches of 25 segments and one batch of 3.
All concurrency settings used identical translation workloads. Observed
concurrency peaks matched the Page worker counts:

| Setting | Page workers | Observed peak |
| ---: | ---: | ---: |
| C4 | 2 | 2 |
| C6 | 3 | 3 |
| C8 | 4 | 4 |

No HTTP or JSON 429 errors occurred.

The C4 JSON export (not the HAR) was mislabeled `GOOGLEV2-C8`. The user
confirmed the actual Yandex C4 configuration, and the HAR independently
verified Yandex traffic.

## Interpretation and limitations

The sample consists of 12 trials. Backend variability was visible, particularly
in the slow first C4 trial; this and the small sample limit confidence in the
medians. Results may differ with service load, network conditions, or workload.

The benchmark supports Level 3 C6 as the observed balance. Level 4 C7 remains
an unvalidated policy choice.
