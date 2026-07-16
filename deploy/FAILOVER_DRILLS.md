# Required failover drills

Do not set both activation flags to `true` until all five drills pass against
the real Aiven, Cloudflare, PawHost and Hetzner setup. Record timestamps,
incident ID, DNS answers, writer generations, image digests, canary results,
accounting totals before/after, alert delivery, and the GitHub run URLs.

## Safety setup

Keep `AUTO_ACTIVATE_FAILOVER=false` and `FAILOVER_DRILL_APPROVED=false`.
Use a dedicated test bucket and keys. Keep a direct connection to the fixed
primary and emergency origins, and watch the public status incident timeline.

## 1. Total PawHost outage

Stop or firewall both PawHost control-plane and dataplane. Confirm five
complete one-minute monitor rounds are required before provisioning begins.
Confirm Hetzner starts, exchanges its one-time token, pulls every image,
reports immutable digests, passes protected readiness, receives a new writer
generation, passes the write canary, and only then receives public DNS.
Verify `dash.onsilo.dev` redirects to status throughout the outage.

## 2. Backing-storage failure

Block or invalidate only the backing S3 dependency while PawHost health still
answers. Confirm readiness/canary detects the real failure and does not switch
DNS to an emergency dataplane that cannot reach the same storage. The status
page must show the failed provisioning/verification step and the safe 503
fallback; no second writer may appear.

## 3. Primary relapse during recovery grace

Recover PawHost for at least ten minutes and ten successful checks. Confirm
the controller drains emergency mutations, transfers the Aiven generation to
primary, changes DNS, and retains Hetzner for the ten-minute grace. Break
PawHost again inside that grace. Confirm deletion is cancelled, the writer
generation returns to emergency before DNS, and the incident records the
relapse.

## 4. Stale DNS traffic to both origins

Pin two clients directly to PawHost and Hetzner while alternately transferring
the writer lease. Run concurrent PUT, DELETE, create/upload/complete multipart,
and GET requests. Reads may work at both sites. Exactly one site must accept
each mutation; the stale site must return HTTP 503 with
`NotActiveWriter`. Start a multipart upload before transfer and confirm later
parts/completion return HTTP 409 `InvalidRequest` with restart guidance.
Confirm a long in-flight PUT finishes before the exclusive lease transfer
completes and no mutation overlaps generations.

## 5. Accounting-protected teardown

Generate emergency requests, ingress, egress and bucket byte changes. First
make Aiven accounting writes fail so events enter Valkey, then restore Aiven.
Trigger failback and teardown. Confirm `/api/internal/accounting/flush`
idempotently drains both queues, PostgreSQL totals match the generated usage,
and only then Hetzner is deleted. Repeat with Aiven unavailable: the destroy
workflow must fail, the VM must remain, the incident must say accounting
blocked teardown, and the alert webhook must fire.

After review, set `FAILOVER_DRILL_APPROVED=true` first. Set
`AUTO_ACTIVATE_FAILOVER=true` only in a separate change with the drill evidence
linked in its incident/change note.
