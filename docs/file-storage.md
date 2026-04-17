# File Storage

Yopass encrypts files client-side before upload. The server stores only the opaque binary ciphertext. Three storage backends are available.

---

## Backends

### Database (default)

Files are stored alongside text secrets in Memcached or Redis. No extra configuration is needed.

```bash
yopass-server  # file-store defaults to the database backend
```

**Limitations:**
- Memcached has a default item size limit of ~1 MB. Files larger than this will fail to store.
- Redis has a higher default limit but is still not ideal for large binary objects.
- A warning is printed at startup if `--max-file-size` exceeds 1 MB without a dedicated file store configured.

Use the database backend when file uploads are small or infrequent and you want to keep the deployment simple.

---

### Disk

Files are written to the local filesystem as encrypted binary blobs. A sidecar `.meta` file tracks expiration for each upload.

```bash
yopass-server \
  --file-store      disk \
  --file-store-path /data/yopass-files
```

The directory is created automatically if it does not exist. Files are organized in two-character subdirectories (e.g. `/data/yopass-files/ab/abcdef123.bin`).

A background goroutine scans for and deletes expired files based on the `.meta` sidecar. The scan interval defaults to 60 seconds and is controlled by `--cleanup-interval`.

**Suitable for:** single-node deployments, moderate file sizes, no object storage dependency.

---

### S3

Files are stored in an AWS S3 bucket or any S3-compatible service (MinIO, Cloudflare R2, Backblaze B2, etc.).

```bash
# AWS S3
yopass-server \
  --file-store            s3 \
  --file-store-s3-bucket  my-yopass-bucket

# S3-compatible (MinIO, Cloudflare R2, etc.)
yopass-server \
  --file-store              s3 \
  --file-store-s3-bucket    my-bucket \
  --file-store-s3-endpoint  http://minio:9000 \
  --file-store-s3-region    us-east-1
```

AWS credentials are loaded from the standard credential chain: environment variables (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`), `~/.aws/credentials`, IAM instance profiles, etc.

**Suitable for:** multi-node deployments, large files, production environments where durability and scalability matter.

---

## Flags

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--file-store` | `FILE_STORE` | *(database)* | Backend: `disk` or `s3`. Omit for database. |
| `--file-store-path` | `FILE_STORE_PATH` | `/tmp/yopass-files` | Base directory for disk backend |
| `--file-store-s3-bucket` | `FILE_STORE_S3_BUCKET` | — | S3 bucket name (required for S3 backend) |
| `--file-store-s3-prefix` | `FILE_STORE_S3_PREFIX` | `yopass/` | Key prefix for all stored objects |
| `--file-store-s3-endpoint` | `FILE_STORE_S3_ENDPOINT` | — | Custom endpoint URL for S3-compatible services |
| `--file-store-s3-region` | `FILE_STORE_S3_REGION` | `us-east-1` | AWS region |
| `--max-file-size` | `MAX_FILE_SIZE` | `512KB` | Maximum upload size. Accepts `KB`, `MB`, `GB` suffixes. |
| `--cleanup-interval` | `CLEANUP_INTERVAL` | `60` | Cleanup scan frequency in seconds (disk and S3 backends) |
| `--disable-file-cleanup` | `DISABLE_FILE_CLEANUP` | `false` | Disable the built-in cleanup goroutine |
| `--disable-upload` | `DISABLE_UPLOAD` | `false` | Disable all file upload endpoints |

---

## File size limits

The `--max-file-size` flag accepts human-readable sizes:

```bash
--max-file-size 10KB
--max-file-size 512KB
--max-file-size 10MB
--max-file-size 1.5GB
```

Without a valid `--license-key`, file size is capped at **1 MB** regardless of what `--max-file-size` is set to. A warning is logged when the cap is applied.

---

## Expiration and cleanup

Every uploaded file is given an expiration time matching the TTL chosen by the uploader (1 hour, 1 day, or 1 week). The built-in cleanup goroutine removes expired files on a regular interval.

### Disk cleanup

The goroutine walks the `--file-store-path` directory, reads each `.meta` file, and deletes the corresponding `.bin` and `.meta` pair when expired.

### S3 cleanup

The goroutine lists all objects in the bucket under the configured prefix, reads their `yopass-expires` tag, and calls `DeleteObject` for any that have passed their expiry. At scale this becomes expensive — see [S3 lifecycle rules](#s3-lifecycle-rules) for the recommended alternative.

### Disabling built-in cleanup

```bash
yopass-server --disable-file-cleanup
```

Use this flag when managing expiration externally (e.g. via S3 lifecycle rules or an external cron job).

---

## S3 lifecycle rules

The built-in S3 cleanup scans and tags every object on each sweep. For buckets with many objects, this generates significant API costs. The recommended approach for production is to configure an S3 lifecycle rule and disable the built-in goroutine.

Since the maximum secret TTL is 1 week, a rule that deletes objects older than 7 days covers all cases:

```json
{
  "Rules": [
    {
      "ID": "yopass-expiration",
      "Filter": { "Prefix": "yopass/" },
      "Status": "Enabled",
      "Expiration": { "Days": 7 }
    }
  ]
}
```

Apply the rule via the AWS CLI:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-yopass-bucket \
  --lifecycle-configuration file://lifecycle.json
```

Then start Yopass without the cleanup goroutine:

```bash
yopass-server \
  --file-store              s3 \
  --file-store-s3-bucket    my-yopass-bucket \
  --disable-file-cleanup
```

---

## MinIO example

```bash
docker run -d \
  -p 9000:9000 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data

# Create the bucket
mc alias set local http://localhost:9000 minioadmin minioadmin
mc mb local/yopass-files

# Start Yopass
AWS_ACCESS_KEY_ID=minioadmin \
AWS_SECRET_ACCESS_KEY=minioadmin \
yopass-server \
  --file-store              s3 \
  --file-store-s3-bucket    yopass-files \
  --file-store-s3-endpoint  http://localhost:9000 \
  --file-store-s3-region    us-east-1
```

---

## Docker Compose example (disk)

```yaml
services:
  yopass:
    image: ghcr.io/jhaals/yopass:latest
    ports:
      - "1337:1337"
    volumes:
      - yopass-files:/data/yopass-files
    environment:
      MEMCACHED: memcached:11211
      FILE_STORE: disk
      FILE_STORE_PATH: /data/yopass-files
      MAX_FILE_SIZE: 50MB
    depends_on:
      - memcached

  memcached:
    image: memcached

volumes:
  yopass-files:
```

## Docker Compose example (S3)

```yaml
services:
  yopass:
    image: ghcr.io/jhaals/yopass:latest
    ports:
      - "1337:1337"
    environment:
      MEMCACHED: memcached:11211
      FILE_STORE: s3
      FILE_STORE_S3_BUCKET: my-yopass-bucket
      FILE_STORE_S3_REGION: eu-west-1
      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}
      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}
      DISABLE_FILE_CLEANUP: "true"  # using S3 lifecycle rules instead
    depends_on:
      - memcached

  memcached:
    image: memcached
```
