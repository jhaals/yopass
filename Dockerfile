FROM golang:1.27-bookworm AS app
RUN mkdir -p /urlx
WORKDIR /urlx
COPY . .
ARG VERSION
RUN VERSION=${VERSION:-$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")} && \
    go build ./cmd/urlx && \
    go build -ldflags "-X main.version=${VERSION}" ./cmd/urlx-server

FROM node:22 AS website
COPY website /website
WORKDIR /website
RUN yarn install --network-timeout 600000 && yarn build

FROM gcr.io/distroless/base
COPY --from=app /urlx/urlx /urlx/urlx-server /
COPY --from=website /website/dist /public
USER 1000
ENTRYPOINT ["/urlx-server"]
