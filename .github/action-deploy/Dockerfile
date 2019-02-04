FROM golang:1-stretch

LABEL "com.github.actions.name"="Deploy"
LABEL "com.github.actions.description"="Deploy yopass to aws lambda"
LABEL "com.github.actions.icon"="mic"
LABEL "com.github.actions.color"="purple"

LABEL "repository"="http://github.com/jhaals/actions"
LABEL "homepage"="http://github.com/jhaals/actions"
LABEL "maintainer"="Johan <johan@haals.se>"

RUN apt-get update && \
    apt-get install -y curl software-properties-common && \
    curl https://deb.nodesource.com/setup_10.x | bash - && \
    apt-get install -y nodejs && \
    npm i -g serverless

ADD entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]