# S3 benchmark report

Run ID: 2026-03-31T16-48-09-805Z
Generated at: 2026-03-31T18:11:24.561Z

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
| 1 | Hetzner FSN1 | 79.73 | 100.00 | 69.55 | 77.07 | 51.81 | 100.00 | 100.00 |
| 2 | Impossible API | 79.20 | 100.00 | 58.02 | 98.68 | 65.18 | 63.59 | 100.00 |
| 3 | MEGA S4 Amsterdam | 68.72 | 100.00 | 54.48 | 60.31 | 81.25 | 42.03 | 100.00 |
| 4 | Wasabi EU Central 2 | 66.73 | 100.00 | 61.02 | 64.65 | 27.39 | 75.50 | 100.00 |
| 5 | Cloudflare R2 | 37.53 | 100.00 | 33.22 | 0.00 | 16.99 | 36.45 | 100.00 |

## Hetzner FSN1

- Capability success: 100.0%
- Core failure rate: 0.0%
- Small upload median: 631 ms | 12.68 MiB/s
- Large upload median: 15931 ms | 16.07 MiB/s
- Small download median: 589 ms | 13.57 MiB/s
- Large download median: 20675 ms | 12.38 MiB/s
- Head small median latency: 19.9 ms
- Delete small median latency: 29.4 ms
- Parallel upload aggregate throughput: 18.25 MiB/s
- Parallel read aggregate throughput: 14.98 MiB/s
- List scan rate: 12417 obj/s
- Seed-many rate: 343 obj/s
- Delete-many rate: 624 obj/s
- Read-after-write visibility median: 17.8 ms
- Delete propagation median: 16.6 ms

## Impossible API

- Capability success: 100.0%
- Core failure rate: 0.0%
- Small upload median: 480 ms | 16.67 MiB/s
- Large upload median: 13125 ms | 19.51 MiB/s
- Small download median: 1011 ms | 7.91 MiB/s
- Large download median: 14078 ms | 18.18 MiB/s
- Head small median latency: 39.7 ms
- Delete small median latency: 22.2 ms
- Parallel upload aggregate throughput: 21.63 MiB/s
- Parallel read aggregate throughput: 14.10 MiB/s
- List scan rate: 10837 obj/s
- Seed-many rate: 134 obj/s
- Delete-many rate: 51 obj/s
- Read-after-write visibility median: 55.1 ms
- Delete propagation median: 23.9 ms

## MEGA S4 Amsterdam

- Capability success: 100.0%
- Core failure rate: 0.0%
- Small upload median: 1025 ms | 7.80 MiB/s
- Large upload median: 14000 ms | 18.29 MiB/s
- Small download median: 445 ms | 17.99 MiB/s
- Large download median: 22406 ms | 11.43 MiB/s
- Head small median latency: 11.2 ms
- Delete small median latency: 67.9 ms
- Parallel upload aggregate throughput: 14.64 MiB/s
- Parallel read aggregate throughput: 8.66 MiB/s
- List scan rate: 9291 obj/s
- Seed-many rate: 26 obj/s
- Delete-many rate: 34 obj/s
- Read-after-write visibility median: 12.7 ms
- Delete propagation median: 9.9 ms

## Wasabi EU Central 2

- Capability success: 100.0%
- Core failure rate: 0.0%
- Small upload median: 507 ms | 15.77 MiB/s
- Large upload median: 15325 ms | 16.70 MiB/s
- Small download median: 587 ms | 13.62 MiB/s
- Large download median: 16065 ms | 15.94 MiB/s
- Head small median latency: 79.0 ms
- Delete small median latency: 39.9 ms
- Parallel upload aggregate throughput: 16.69 MiB/s
- Parallel read aggregate throughput: 6.08 MiB/s
- List scan rate: 12401 obj/s
- Seed-many rate: 69 obj/s
- Delete-many rate: 262 obj/s
- Read-after-write visibility median: 65.6 ms
- Delete propagation median: 17.9 ms

## Cloudflare R2

- Capability success: 100.0%
- Core failure rate: 0.0%
- Small upload median: 702 ms | 11.39 MiB/s
- Large upload median: 37754 ms | 6.78 MiB/s
- Small download median: 613 ms | 13.04 MiB/s
- Large download median: 34108 ms | 7.51 MiB/s
- Head small median latency: 92.8 ms
- Delete small median latency: 93.8 ms
- Parallel upload aggregate throughput: 9.98 MiB/s
- Parallel read aggregate throughput: 6.02 MiB/s
- List scan rate: 154 obj/s
- Seed-many rate: 91 obj/s
- Delete-many rate: 361 obj/s
- Read-after-write visibility median: 107 ms
- Delete propagation median: 63.6 ms

