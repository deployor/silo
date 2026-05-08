# S3 benchmark report

Run ID: 2026-04-17T13-49-36-222Z
Generated at: 2026-04-17T14:08:53.197Z

## Configuration
- Repeats per single-object test: 5
- Heavy workload repeats: 2
- Object sizes: small=8 MiB, medium=64 MiB, large=256 MiB
- Parallel uploads=16, reads=16, deletes=32
- Many-object test count=10,000, payload=1.0 KB
- Deep list target=10,000 objects

## Ranking
| Rank | Provider | Overall | Capability | Latency | Throughput | Consistency | Scalability | Integrity |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | fil.one EU West 1 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |

## fil.one EU West 1

- Capability success: 100.0%
- Core failure rate: 0.0%
- Small upload median: 2446 ms | 3.27 MiB/s
- Large upload median: 41556 ms | 6.16 MiB/s
- Small download median: 2817 ms | 2.84 MiB/s
- Large download median: 32745 ms | 7.82 MiB/s
- Head small median latency: 316 ms
- Delete small median latency: 45.0 ms
- Parallel upload aggregate throughput: 7.10 MiB/s
- Parallel read aggregate throughput: 8.05 MiB/s
- List scan rate: 1239 obj/s
- Seed-many rate: 223 obj/s
- Delete-many rate: 522 obj/s
- Read-after-write visibility median: 302 ms
- Delete propagation median: 36.8 ms

