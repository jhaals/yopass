# Yopass changelog

### 2.2.0

- Delete secret after 3 failed attempts

### 2.1.1

- fix missconfigured template rendering when sending decryption key over SMS

### 2.1.0

- remove /get part from URLs
- copy to clipboard for URLs

### 2.0.0

- Rename `http_base_url` to base_url
- Move configuration settings to environment variables
- Use thin as webserver
- Bump rspec version
- Drop ruby 1.8.7 support

### 1.1.5
- Ability to configure secret_max_length in yopass.yaml

### 1.1.4
- remove gui messup

### 1.1.3

- display placeholder for mobile number in form.
- fixes bug where test would fail is memcached was running.

### 1.1.2

- Typo
- Shipp all fonts instead of loading them from external site. Caused insecure content warning
