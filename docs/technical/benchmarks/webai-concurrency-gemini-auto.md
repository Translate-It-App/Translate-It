# WebAI concurrency comparison — gemini-auto

## Benchmark conditions and results

The WebAI Page Translation benchmark used model `gemini-auto`, endpoint
`/translate`, Optimization Level 3, 120 targets, and batch size 30. The merged
Page Translation timeout fix was applied. Each concurrency setting was run
four times; all trials succeeded.

| Concurrency | Median first visible | Median completion | Successful trials |
| ---: | ---: | ---: | ---: |
| C2 (retest) | 6.60s | 26.41s | 4/4 |
| C3 | 6.74s | 23.65s | 4/4 |
| C4 | 7.11s | 16.11s | 4/4 |

C4 reduced median completion time by approximately 39% versus C2 and 32%
versus C3. First-visible medians were 6.60s, 6.74s, and 7.11s for C2, C3,
and C4 respectively; higher concurrency did not improve that measure in these
trials.

## HAR verification

- Actual request concurrency matched each configured setting.
- Request payloads were identical across concurrency settings.
- All 60 HTTP requests succeeded and all response IDs matched.
- No timeouts or recovery retries occurred.

## Interpretation and policy

These results are directional: the sample is limited to four trials per
setting and timing may vary with backend conditions. They support the
benchmark-selected Level 3 concurrency of 4, but do not establish a general
latency guarantee or translation-quality result.

WebAI Levels 4 and 5 use concurrency 5 and 6 as policy choices. They were not
tested by this benchmark and remain unvalidated.
