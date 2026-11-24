# DeepL Translate concurrency evaluation

## Results

| Configuration | Successful trials | Median successful completion | Outcome |
| --- | ---: | ---: | --- |
| C5 baseline | 4/4 | 6.078s | All trials succeeded |
| Initial C6 | 2/4 | — | Run interrupted by quota exhaustion |
| C6 retest | 2/3 | 4.581s | Other trials failed with rate-limit errors |
| C8 | Not tested | — | — |

The C6 retest's successful-trial median was faster than the C5 baseline, but
that performance result is accompanied by inconsistent success and must be
treated as directional. Initial C6 stopped after quota exhaustion; the
separate C6 retest recorded rate-limit failures. These are distinct reported
outcomes and are not treated as interchangeable explanations.

## Decision and limitations

Retain C5. Reliability takes precedence over the observed C6 performance
improvement, and C8 was not tested. The sample is small: four baseline trials,
four initial C6 trials, and three C6 retest trials, with only two successful
retest measurements. The available data does not establish a reliable
performance or failure-rate estimate.
