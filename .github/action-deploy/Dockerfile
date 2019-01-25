
FROM node:10-slim

LABEL version="1.0.0"
LABEL repository="https://github.com/jhaals/yopass"
LABEL homepage="https://github.com/jhaals/yopass"
LABEL maintainer="Johan Haals <johan@haals.se>"

LABEL "com.github.actions.name"="GitHub Action for Serverless Framework"
LABEL "com.github.actions.description"="Wraps the Serverless Frameork to enable common Serverless commands."
LABEL "com.github.actions.icon"="zap"
LABEL "com.github.actions.color"="red"

RUN npm i -g serverless

ADD entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]