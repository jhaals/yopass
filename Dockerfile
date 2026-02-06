FROM golang:bookworm AS app
RUN mkdir -p /yopass
WORKDIR /yopass
COPY . .
RUN go build ./cmd/yopass && go build ./cmd/yopass-server && go build ./cmd/healthcheck

FROM node:22 AS website
COPY website /website
WORKDIR /website
RUN yarn install --network-timeout 600000 && yarn build

FROM gcr.io/distroless/base
COPY --from=app /yopass/yopass /yopass/yopass-server /yopass/healthcheck /
COPY --from=website /website/dist /public
USER 1000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/healthcheck"]
ENTRYPOINT ["/yopass-server"]
