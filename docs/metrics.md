# Metrics & Monitoring

Yopass exposes metrics in [Prometheus](https://prometheus.io/) / [OpenMetrics](https://openmetrics.io/) format on a dedicated port, separate from the main server port.

---

## Enabling metrics

```bash
yopass-server --metrics-port 9090
```

Metrics are served at `http://host:9090/metrics`. The metrics endpoint is intentionally on a separate port so it can be firewalled from public access while remaining reachable by your Prometheus scraper.

---

## Available metrics

### HTTP request metrics

| Metric | Type | Description |
|--------|------|-------------|
| `yopass_http_requests_total` | Counter | Total HTTP requests, labeled by `handler`, `method`, and `code` |
| `yopass_http_request_duration_seconds` | Histogram | Request latency in seconds, labeled by `handler` and `method` |

Handler labels correspond to the route name (e.g. `create_secret`, `get_secret`, `create_file`, `get_file`, `config`, `health`).

### Go runtime metrics

| Metric prefix | Description |
|---------------|-------------|
| `go_gc_*` | Garbage collection statistics |
| `go_goroutines` | Number of goroutines |
| `go_memstats_*` | Memory allocator statistics |
| `go_threads` | OS thread count |

### Process metrics

| Metric prefix | Description |
|---------------|-------------|
| `process_cpu_seconds_total` | Total user/system CPU time |
| `process_open_fds` | Open file descriptors |
| `process_resident_memory_bytes` | Resident memory usage |
| `process_virtual_memory_bytes` | Virtual memory usage |

### License metrics

When `--license-key` is configured, an additional gauge is registered:

| Metric | Type | Description |
|--------|------|-------------|
| `yopass_license_days_until_expiry` | Gauge | Days until the license expires; negative if already expired |

---

## Prometheus configuration

Add a scrape job to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: yopass
    static_configs:
      - targets: ["yopass-host:9090"]
```

For a Docker deployment, use the container name as the target:

```yaml
scrape_configs:
  - job_name: yopass
    static_configs:
      - targets: ["yopass:9090"]
```

---

## Docker Compose example

```yaml
services:
  yopass:
    image: ghcr.io/jhaals/yopass:latest
    ports:
      - "1337:1337"
      - "9090:9090"   # metrics — restrict this in production
    environment:
      MEMCACHED: memcached:11211
      METRICS_PORT: "9090"
    depends_on:
      - memcached

  memcached:
    image: memcached

  prometheus:
    image: prom/prometheus
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9091:9090"

  grafana:
    image: grafana/grafana
    ports:
      - "3000:3000"
    depends_on:
      - prometheus
```

---

## Example alerting rules

Save as `yopass-alerts.yml` and reference it from your Prometheus configuration:

```yaml
groups:
  - name: yopass
    rules:
      - alert: YopassHighErrorRate
        expr: |
          sum(rate(yopass_http_requests_total{code=~"5.."}[5m]))
          /
          sum(rate(yopass_http_requests_total[5m])) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Yopass HTTP error rate above 5%"

      - alert: YopassHighLatency
        expr: |
          histogram_quantile(0.95,
            sum by (le, handler) (rate(yopass_http_request_duration_seconds_bucket[5m]))
          ) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Yopass p95 latency above 2s on {{ $labels.handler }}"

      - alert: YopassLicenseExpiringSoon
        expr: yopass_license_days_until_expiry < 14
        labels:
          severity: warning
        annotations:
          summary: "Yopass license expires in {{ $value | humanizeDuration }}"

      - alert: YopassLicenseExpired
        expr: yopass_license_days_until_expiry < 0
        labels:
          severity: critical
        annotations:
          summary: "Yopass license has expired"
```

---

## Grafana dashboard

A minimal dashboard query set for the Grafana UI:

**Request rate (per second):**
```
sum(rate(yopass_http_requests_total[1m])) by (handler)
```

**Error rate:**
```
sum(rate(yopass_http_requests_total{code=~"5.."}[1m])) by (handler)
```

**p95 latency:**
```
histogram_quantile(0.95, sum(rate(yopass_http_request_duration_seconds_bucket[5m])) by (le, handler))
```

**Active goroutines:**
```
go_goroutines{job="yopass"}
```

**Memory usage:**
```
process_resident_memory_bytes{job="yopass"}
```

---

## Securing the metrics endpoint

The metrics endpoint has no authentication. In production, restrict access at the network level:

**Firewall (ufw):**
```bash
ufw allow from 10.0.0.0/8 to any port 9090
ufw deny 9090
```

**Nginx basic auth in front of metrics:**
```nginx
server {
    listen 9090;
    location /metrics {
        auth_basic "Prometheus";
        auth_basic_user_file /etc/nginx/.htpasswd;
        proxy_pass http://127.0.0.1:9090;
    }
}
```

**Docker: do not expose the port publicly.** In Docker Compose, omit the host-side port binding and let Prometheus scrape via the internal network:

```yaml
# Expose to internal network only — no host port mapping
yopass:
  environment:
    METRICS_PORT: "9090"
  # No "ports:" entry for 9090
```

---

## Flags

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--metrics-port` | `METRICS_PORT` | `-1` | Port for the metrics server. Set to a positive integer to enable. |
