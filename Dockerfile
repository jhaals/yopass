FROM ubuntu
MAINTAINER Johan Haals <johan.haals@gmail.com>

RUN apt-get update
RUN echo "#!/bin/sh\nexit 0" > /usr/sbin/policy-rc.d
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y git libsasl2-dev build-essential ruby ruby-dev memcached

RUN gem install foreman --no-rdoc --no-ri
RUN gem install bundler --no-rdoc --no-ri
RUN gem install god --no-rdoc --no-ri

RUN git clone https://github.com/jhaals/yopass /yopass
ADD yopass.god /yopass/yopass.god
RUN cd /yopass && bundle install

RUN apt-get -y install apache2
RUN a2enmod ssl proxy proxy_http rewrite
ADD yopass.conf /etc/apache2/sites-available/
ADD 000-default.conf /etc/apache2/sites-available/000-default.conf
ADD ssl/cert /etc/ssl/yo-cert
ADD ssl/key /etc/ssl/yo-key
ADD ssl/bundle /etc/ssl/yo-bundle
RUN a2ensite yopass

# Ensure that both yopass and memcached is up and running
CMD ["god", "-c", "/yopass/yopass.god", "-D"]
