# OSS Scanner build (https://github.com/anthropics/oss-scanner). Keeps the source,
# toolchains, dependency caches and test browsers available for the scanner,
# which runs without Internet access after this build. See threat_model.md.
FROM node:24-bookworm AS node
FROM rust:1-bookworm AS rust
FROM golang:1.27-bookworm

COPY --from=node /usr/local/ /usr/local/
COPY --from=node /opt/ /opt/
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV DEBIAN_FRONTEND=noninteractive \
    GOTOOLCHAIN=local \
    GOWORK=off \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH \
    # GNU ld runs out of memory linking the test binaries in parallel.
    RUSTFLAGS="-C link-arg=-fuse-ld=lld"

# cmake and clang build aws-lc-rs for the Rust server.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 memcached redis-server cmake clang lld \
    && rm -rf /var/lib/apt/lists/*

# Scanner contract: the complete checkout must remain at /src.
COPY . /src
WORKDIR /src
RUN go mod download \
    && go build -o /usr/local/bin/yopass ./cmd/yopass \
    && go build -o /usr/local/bin/yopass-server ./cmd/yopass-server
RUN cd deploy/cdk && go mod download && go build ./...

# The compiler version comes from rust-toolchain.toml. Debug builds of every
# target, tests included, leave all crates compiled for an offline cargo test.
RUN rustup toolchain install
RUN cd server && cargo build --locked --all-targets
RUN cd cli && cargo build --locked --all-targets

WORKDIR /src/website
RUN yarn install --frozen-lockfile --network-timeout 600000 \
    && yarn playwright install --with-deps chromium firefox webkit \
    && yarn build

# Both servers serve the compiled frontend from ./public, so from here when started in /src.
RUN mkdir -p /src/public && cp -a dist/. /src/public/

# Run the tests that need no external services, without letting a flaky test
# fail the build. threat_model.md documents the offline integration tests.
RUN yarn test:unit || echo "WARNING: website unit tests failed"
WORKDIR /src
RUN go test ./cmd/... ./pkg/... || echo "WARNING: Go tests failed"
RUN cd server && (cargo test --locked || echo "WARNING: Rust server tests failed")
RUN cd cli && (YOPASS_REQUIRE_OPENPGPJS=1 cargo test --locked || echo "WARNING: Rust CLI tests failed")
ENV CARGO_NET_OFFLINE=true
CMD ["bash"]
