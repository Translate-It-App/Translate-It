# OpenAI concurrency comparison — gpt-4o-2024-11-20

## Benchmark conditions and successful timing measurements

The benchmark used model `gpt-4o-2024-11-20`, endpoint
`https://api.openai.com/v1/chat/completions`, Optimization Level 3, and batch
size 30. JSON and HAR evidence recorded 24 successful trials out of 25 and
331 successful HTTP requests out of 333. For each successful trial, the
120-target fixture used 5 requests and 4,446 input tokens; the 600-target
fixture used 21 requests and 18,398 input tokens. Cache hit rate was 0%.
Request payloads were identical across concurrency variants for each fixture
size.

The reported median completion times were:

| Targets | Concurrency 2 | Concurrency 3 | Concurrency 4 |
| ---: | ---: | ---: | ---: |
| 120 | 13.25s | 11.54s | 10.57s |
| 600 | 48.01s | 34.16s | 31.38s |

At 600 targets, concurrency 3 reduced the reported median completion time by
28.8% versus concurrency 2. These measurements support the Level 3 capacity
choice as directional evidence, not a latency guarantee. The medians exclude
the unsuccessful trial described separately below.

The medians do not measure translation quality, and observed completion times
may vary with browser, network, service, and other runtime conditions. Do not
generalize these results to other models or environments.

## Separate credit-exhaustion failure

The single failed trial was the 600-target concurrency-4 run described above;
the HTTP 429 reported `insufficient_quota`. It is documented separately from
the successful timing measurements and contributes no completion time to the
medians.
