God.watch do |w|
  w.name = "yopass"
  w.start = "foreman start -d /yopass"
  w.keepalive
end

God.watch do |w|
  w.name = "memcached"
  w.start = "memcached -u root"
  w.keepalive
end

God.watch do |w|
  w.name = "apache2"
  w.start = "apachectl -DFOREGROUND"
  w.keepalive
end
