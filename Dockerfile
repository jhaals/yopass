# Yopass Server build stage
FROM golang:bookworm AS app

WORKDIR /yopass
COPY go.mod go.sum LICENSE /yopass/
COPY cmd /yopass/cmd
COPY pkg /yopass/pkg

RUN go build ./cmd/yopass && go build ./cmd/yopass-server


# Website build stage
FROM node:22 AS website
WORKDIR /website

# Install dependencies
COPY website/package.json website/yarn.lock /website/
RUN yarn install --network-timeout 600000

# Build and bundle src
COPY website/tsconfig.json website/vite.config.ts website/index.html /website/
COPY website/src /website/src
COPY website/public /website/public

ARG PUBLIC_URL
ARG ROUTER_TYPE
RUN PUBLIC_URL="${PUBLIC_URL}" ROUTER_TYPE="${ROUTER_TYPE}" yarn build


# Final minimal image including only built resources
FROM gcr.io/distroless/base
COPY --from=app /yopass/yopass /yopass/yopass-server /
COPY --from=website /website/build /public
ENTRYPOINT ["/yopass-server"]
