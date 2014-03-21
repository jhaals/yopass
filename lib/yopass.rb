require 'memcached'
require 'sinatra/base'
require 'securerandom'
require 'encryptor'
require 'yaml'
require 'uri'
require 'yopass/sms_provider'

class Yopass < Sinatra::Base
  configure :development do
    require 'sinatra/reloader'
    register Sinatra::Reloader
    set :config, YAML.load_file('conf/yopass.yaml')
  end
  configure :test do
    set :config, YAML.load_file('conf/yopass.yaml')
  end
  configure :production do
    set :config, YAML.load_file('/etc/yopass.yaml')
  end
  configure do
    set :public_folder, File.dirname(__FILE__) + '/static'
    set :cache, Memcached.new(settings.config['memcached_url'])
  end

  get '/' do
    # display mobile number field if send_sms is true
    erb :index, :locals => { :send_sms => settings.config['send_sms'] }
  end

  post '/' do
    headers 'Cache-Control' => 'no-cache, no-store, must-revalidate'
    headers 'Pragma' => 'no-cache'
    headers 'Expires' => '0'

    lifetime = params[:lifetime]
    # calculate lifetime in secounds
    lifetime_options = { '1w' => 3600 * 24 * 7,
                         '1d' => 3600 * 24,
                         '1h' => 3600
    }
    # Verify that user has posted a valid lifetime
    return 'Invalid lifetime' unless lifetime_options.include? lifetime
    return 'No secret submitted' if params[:secret].empty?
    return 'This site is meant to store secrets not novels' if params[:secret].length >= 10000

    # goes in URL
    key = SecureRandom.hex
    # password goes in URL or via SMS if provider is configured
    password = SecureRandom.hex[0..8]
    # encrypt secret with generated password
    data = Encryptor.encrypt(params[:secret], :key => password)

    # store secret in memcached
    begin
      settings.cache.set key, data, lifetime_options[lifetime]
    rescue Memcached::ServerIsMarkedDead
      return "Can't contact memcached"
    end

    if settings.config['send_sms'] == true && !params[:mobile_number].nil?
      # strip everything except digits
      mobile_number = params[:mobile_number].gsub(/[^0-9]/, '')
      # load specified sms provider
      sms = SmsProvider.create(settings.config['sms::provider'],
                               settings.config['sms::settings'])

      unless params[:mobile_number].empty?
        # TODO verification
        sms.send(mobile_number, password)
        return erb :secret_url, :locals => {
          :url => URI.join(settings.config['http_base_url'], "get?k=#{key}"),
          :key_sent_to_mobile => true }
      end
    end

    erb :secret_url, :locals => {
      :url => URI.join(settings.config['http_base_url'],"get?k=#{key}&p=#{password}"),
      :key_sent_to_mobile => false }
  end

  get '/get' do
    # No password added
    return erb :get_secret, :locals => {
      :key => params[:k] } if params[:p].nil? || params[:p].empty?

    # Disable all caching
    headers 'Cache-Control' => 'no-cache, no-store, must-revalidate'
    headers 'Pragma' => 'no-cache'
    headers 'Expires' => '0'

    begin
      result = settings.cache.get params[:k]
    rescue Memcached::NotFound
      return erb :'404'
    end
    content_type 'text/plain'

    begin
      result = Encryptor.decrypt(:value => result, :key => params[:p])
    rescue OpenSSL::Cipher::CipherError
      return 'Invalid decryption key'
    end
    settings.cache.delete params[:k]
    result
  end

  run! if app_file == $0
end
