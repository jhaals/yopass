//! Prometheus metrics. Metric names match the Go server.

use prometheus::{CounterVec, Encoder, HistogramOpts, HistogramVec, Opts, Registry, TextEncoder};

pub struct Metrics {
    pub registry: Registry,
    requests: CounterVec,
    duration: HistogramVec,
}

impl Default for Metrics {
    fn default() -> Self {
        Self::new()
    }
}

impl Metrics {
    pub fn new() -> Self {
        let registry = Registry::new();
        let requests = CounterVec::new(
            Opts::new(
                "yopass_http_requests_total",
                "Total number of requests served by HTTP method, path and response code.",
            ),
            &["method", "path", "code"],
        )
        .expect("static metric definition");
        let duration = HistogramVec::new(
            HistogramOpts::new(
                "yopass_http_request_duration_seconds",
                "Histogram of HTTP request latencies by method and path.",
            ),
            &["method", "path"],
        )
        .expect("static metric definition");
        registry
            .register(Box::new(requests.clone()))
            .expect("unique metric");
        registry
            .register(Box::new(duration.clone()))
            .expect("unique metric");
        #[cfg(target_os = "linux")]
        let _ = registry.register(Box::new(
            prometheus::process_collector::ProcessCollector::for_self(),
        ));
        Self {
            registry,
            requests,
            duration,
        }
    }

    pub fn record(&self, method: &str, path: &str, code: u16, seconds: f64) {
        self.requests
            .with_label_values(&[method, path, &code.to_string()])
            .inc();
        self.duration
            .with_label_values(&[method, path])
            .observe(seconds);
    }

    pub fn render(&self) -> Vec<u8> {
        let mut out = Vec::new();
        // Encoding only fails on inconsistent metric families, which are static here.
        let _ = TextEncoder::new().encode(&self.registry.gather(), &mut out);
        out
    }
}

/// Clamps the method so clients cannot inflate label cardinality.
pub fn normalized_method(method: &str) -> &str {
    match method {
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "CONNECT" | "OPTIONS" | "TRACE" => {
            method
        }
        _ => "<other>",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_methods_share_one_label() {
        assert_eq!(normalized_method("GET"), "GET");
        assert_eq!(normalized_method("FOOBAR"), "<other>");
    }

    #[test]
    fn renders_recorded_requests() {
        let metrics = Metrics::new();
        metrics.record("GET", "/secret/:key", 200, 0.1);
        let output = String::from_utf8(metrics.render()).unwrap();
        assert!(output.contains(
            r#"yopass_http_requests_total{code="200",method="GET",path="/secret/:key"} 1"#
        ));
    }

    #[test]
    fn default_is_a_fresh_registry() {
        let metrics = Metrics::default();
        metrics.record("GET", "/config", 200, 0.1);
        let output = String::from_utf8(metrics.render()).unwrap();
        assert!(output.contains(r#"path="/config""#), "{output}");
    }
}
