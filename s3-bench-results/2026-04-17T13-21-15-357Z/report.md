# S3 benchmark report

Run ID: 2026-04-17T13-21-15-357Z
Generated at: 2026-04-17T13:21:57.455Z

## Configuration
- Repeats per single-object test: 2
- Heavy workload repeats: 1
- Object sizes: small=1 MiB, medium=8 MiB, large=32 MiB
- Parallel uploads=8, reads=8, deletes=12
- Many-object test count=256, payload=512 B
- Deep list target=256 objects

## Ranking
| Rank | Provider | Overall | Capability | Latency | Throughput | Consistency | Scalability | Integrity |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | fil.one EU West 1 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 | 100.00 |

## fil.one EU West 1

- Capability success: 100.0%
- Core failure rate: 0.0%
- Small upload median: 222 ms | 6.47 MiB/s
- Large upload median: 4040 ms | 8.32 MiB/s
- Small download median: 616 ms | 1.74 MiB/s
- Large download median: 4586 ms | 6.98 MiB/s
- Head small median latency: 40.7 ms
- Delete small median latency: 68.7 ms
- Parallel upload aggregate throughput: 5.43 MiB/s
- Parallel read aggregate throughput: 3.40 MiB/s
- List scan rate: 1173 obj/s
- Seed-many rate: 102 obj/s
- Delete-many rate: 241 obj/s
- Read-after-write visibility median: 117 ms
- Delete propagation median: 39.3 ms

