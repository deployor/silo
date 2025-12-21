
const path = "/api/dashboard/buckets/my-bucket/keys/123e4567-e89b-12d3-a456-426614174000";
const match = path.match(/^\/api\/dashboard\/buckets\/([a-z0-9-]+)\/keys\/([^/]+)$/);
console.log(match);
