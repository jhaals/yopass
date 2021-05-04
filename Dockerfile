FROM golang:buster as app
RUN mkdir -p /yopass
WORKDIR /yopass
COPY . .
RUN go build ./cmd/yopass && go build ./cmd/yopass-server

FROM node as website
COPY website /website
WORKDIR /website
RUN yarn install && yarn build

FROM gcr.io/distroless/base
COPY --from=app --chown=nonroot:nonroot /yopass/yopass /yopass/yopass-server /
COPY --from=website --chown=nonroot:nonroot /website/build /public
USER nonroot
ENTRYPOINT ["/yopass-server"]
