FROM golang:bookworm AS app
RUN mkdir -p /yopass
WORKDIR /yopass
COPY . .
RUN go build ./cmd/yopass && go build ./cmd/yopass-server

FROM node:22 AS website
COPY website /website
WORKDIR /website
RUN yarn install --network-timeout 600000 && yarn build

FROM gcr.io/distroless/base
COPY --from=app /yopass/yopass /yopass/yopass-server /
COPY --from=website /website/dist /public
USER 1000

# Health check using yopass-server binary in health check mode
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/yopass-server", "--health-check"] || exit 1

ENTRYPOINT ["/yopass-server"]
