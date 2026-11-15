# Rust server, published as jhaals/yopass:latest, the version tags and next.
# The Go server image is built from ./Dockerfile.go as the go tags.
# The compiler comes from rust-toolchain.toml, shared with CI and the CLI; the image only provides rustup.
FROM rust:1-bookworm AS app
RUN apt-get update && apt-get install -y --no-install-recommends cmake clang && rm -rf /var/lib/apt/lists/*
COPY rust-toolchain.toml /build/
WORKDIR /build/server
RUN rustup toolchain install
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/src ./src
COPY pkg/server/license_public.pem /build/pkg/server/license_public.pem
ARG VERSION
RUN YOPASS_VERSION="${VERSION:-dev}" cargo build --release --locked --bin yopass-server

FROM node:22 AS website
COPY website /website
WORKDIR /website
RUN yarn install --network-timeout 600000 && yarn build

# cc rather than static: glibc, plus the CA certificates OIDC and webhooks need.
FROM gcr.io/distroless/cc-debian12
COPY --from=app /build/server/target/release/yopass-server /yopass-server
COPY --from=website /website/dist /public
USER 1000
ENTRYPOINT ["/yopass-server"]
