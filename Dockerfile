FROM --platform=$BUILDPLATFORM golang:buster as app
RUN mkdir -p /yopass
WORKDIR /yopass
COPY . .
ARG TARGETOS TARGETARCH
RUN GOOS=$TARGETOS GOARCH=$TARGETARCH go build ./cmd/yopass && go build ./cmd/yopass-server

FROM --platform=$BUILDPLATFORM node:16 as website
COPY website /website
WORKDIR /website
# 2024-01-04 Force yarn to generate yarn.lock to match package.json
# which has been modified due to 
# https://github.com/react-hook-form/react-hook-form/issues/11281#issuecomment-1852745400
# Otherwise, image won't build on arm64
#	RUN rm yarn.lock
RUN yarn install --network-timeout 600000 && yarn build

FROM gcr.io/distroless/base as final
ENV COMMIT_HASH=COMMIT_HASH_REPLACE
ENV SHA_HASH_VERSION=SHA_HASH_VERSION_REPLACE
COPY --from=app /yopass/yopass /yopass/yopass-server /
COPY --from=website /website/build /public
COPY --from=website /website/yarn.lock /yarn.lock
ENTRYPOINT ["/yopass-server"]
